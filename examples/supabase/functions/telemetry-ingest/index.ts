import { createSupabaseContext } from '@supabase/server';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_BATCH_RECORDS = 100;
const BATCH_ID = /^nl-[0-9]+-[0-9a-f]{16}$/u;
const encoder = new TextEncoder();

function environmentSet(name: string): Set<string> {
  return new Set(
    (Deno.env.get(name) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function allowedOrigins(): Set<string> {
  return environmentSet('TELEMETRY_ALLOWED_ORIGINS');
}

function allowedAppNames(): Set<string> {
  return environmentSet('TELEMETRY_ALLOWED_APP_NAMES');
}

function corsHeaders(request: Request): Headers | null {
  const origin = request.headers.get('origin');
  if (!origin) {
    return new Headers();
  }
  if (!allowedOrigins().has(origin)) {
    return null;
  }
  return new Headers({
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': [
      'authorization',
      'apikey',
      'content-type',
      'x-client-info',
      'x-next-loggers-schema',
      'x-next-loggers-batch-id',
    ].join(', '),
    'access-control-max-age': '600',
    vary: 'origin',
  });
}

function json(
  request: Request,
  value: unknown,
  status: number,
  extraHeaders?: HeadersInit,
): Response {
  const headers = corsHeaders(request) ?? new Headers();
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  for (const [name, headerValue] of new Headers(extraHeaders)) {
    headers.set(name, headerValue);
  }
  return new Response(JSON.stringify(value), { status, headers });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveRateLimit(): number {
  const parsed = Number.parseInt(
    Deno.env.get('TELEMETRY_MAX_RECORDS_PER_MINUTE') ?? '1000',
    10,
  );
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100_000
    ? parsed
    : 1_000;
}

async function ingest(
  request: Request,
  ctx: Awaited<ReturnType<typeof createSupabaseContext>>['data'],
): Promise<Response> {
  if (!ctx) {
    return json(request, { error: 'unauthorized' }, 401);
  }
  const cors = corsHeaders(request);
  if (cors === null) {
    return json(request, { error: 'origin_not_allowed' }, 403);
  }
  if (request.method !== 'POST') {
    return json(request, { error: 'method_not_allowed' }, 405, {
      allow: 'POST, OPTIONS',
    });
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    return json(request, { error: 'content_type_must_be_application_json' }, 415);
  }
  const declaredLength = Number.parseInt(
    request.headers.get('content-length') ?? '0',
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(request, { error: 'payload_too_large' }, 413);
  }

  const rawBody = await request.text();
  if (encoder.encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json(request, { error: 'payload_too_large' }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(request, { error: 'invalid_json' }, 400);
  }
  if (!object(body)) {
    return json(request, { error: 'invalid_batch' }, 400);
  }

  const schema = body.schema;
  const batchId = body.batchId;
  const sentAt = body.sentAt;
  const records = body.records;
  if (
    schema !== 'next-loggers/batch/v1' ||
    typeof batchId !== 'string' ||
    !BATCH_ID.test(batchId) ||
    typeof sentAt !== 'string' ||
    sentAt.length < 20 ||
    sentAt.length > 64 ||
    !Number.isFinite(Date.parse(sentAt)) ||
    !Array.isArray(records) ||
    records.length < 1 ||
    records.length > MAX_BATCH_RECORDS ||
    Number.parseInt(batchId.split('-')[1] ?? '', 10) !== records.length
  ) {
    return json(request, { error: 'invalid_batch' }, 400);
  }
  if (request.headers.get('x-next-loggers-schema') !== schema) {
    return json(request, { error: 'schema_header_mismatch' }, 400);
  }
  if (request.headers.get('x-next-loggers-batch-id') !== batchId) {
    return json(request, { error: 'batch_id_header_mismatch' }, 400);
  }

  const appNames = allowedAppNames();
  if (appNames.size === 0) {
    return json(request, { error: 'telemetry_app_allowlist_missing' }, 503);
  }
  for (const record of records) {
    if (!object(record) || typeof record.appName !== 'string') {
      return json(request, { error: 'invalid_batch' }, 400);
    }
    if (!appNames.has(record.appName)) {
      return json(request, { error: 'app_name_not_allowed' }, 403);
    }
  }

  const userId = ctx.userClaims?.id;
  if (typeof userId !== 'string' || !userId) {
    return json(request, { error: 'authenticated_user_missing' }, 401);
  }

  const { data, error } = await ctx.supabaseAdmin.rpc('ingest_next_logger_records', {
    p_user_id: userId,
    p_batch_id: batchId,
    p_records: records,
    p_max_records_per_minute: positiveRateLimit(),
  });

  if (error) {
    // Never include the batch, bearer token, or raw Postgres error details in
    // the response. Correlate server-side diagnostics through a separate,
    // non-recursive telemetry path.
    const requestId = Deno.env.get('SB_EXECUTION_ID') ?? crypto.randomUUID();
    if (error.code === 'P0001') {
      return json(request, { error: 'rate_limited', requestId }, 429, {
        'retry-after': '60',
        'x-request-id': requestId,
      });
    }
    if (error.code === '22023') {
      return json(request, { error: 'invalid_batch', requestId }, 400, {
        'x-request-id': requestId,
      });
    }
    return json(request, { error: 'ingest_unavailable', requestId }, 503, {
      'retry-after': '1',
      'x-request-id': requestId,
    });
  }

  if (
    !object(data) ||
    data.batchId !== batchId ||
    typeof data.accepted !== 'number' ||
    !Number.isInteger(data.accepted) ||
    data.accepted < 0 ||
    typeof data.duplicates !== 'number' ||
    !Number.isInteger(data.duplicates) ||
    data.duplicates < 0 ||
    typeof data.requested !== 'number' ||
    !Number.isInteger(data.requested) ||
    data.requested !== records.length ||
    data.accepted + data.duplicates !== records.length
  ) {
    const requestId = Deno.env.get('SB_EXECUTION_ID') ?? crypto.randomUUID();
    return json(request, { error: 'ingest_unavailable', requestId }, 503, {
      'retry-after': '1',
      'x-request-id': requestId,
    });
  }

  // The RPC response is available only after Supabase commits its transaction.
  // Generate this timestamp after that response so clients can distinguish a
  // durable commit acknowledgement from a generic HTTP success.
  const requestId = Deno.env.get('SB_EXECUTION_ID') ?? crypto.randomUUID();
  return json(request, {
    schema: 'next-loggers/ingest-ack/v1',
    batchId,
    accepted: data.accepted,
    duplicates: data.duplicates,
    requested: data.requested,
    committedAt: new Date().toISOString(),
  }, 202, {
    'x-request-id': requestId,
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const cors = corsHeaders(request);
    if (cors === null) {
      return json(request, { error: 'origin_not_allowed' }, 403);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const { data: ctx, error } = await createSupabaseContext(request, { auth: 'user' });
    if (error || !ctx) {
      return json(request, { error: 'unauthorized' }, error?.status ?? 401);
    }
    return ingest(request, ctx);
  },
};
