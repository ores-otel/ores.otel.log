import { withSupabase } from 'npm:@supabase/server@^1';

const BATCH_SCHEMA = 'next-loggers/batch/v1';
const MAX_BODY_BYTES = 512 * 1_024;
const MAX_RECORDS = 100;
const BATCH_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;

interface TelemetryBatch {
  schema: typeof BATCH_SCHEMA;
  batchId: string;
  sentAt: string;
  records: unknown[];
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseBatch(value: unknown): TelemetryBatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<TelemetryBatch>;
  if (
    candidate.schema !== BATCH_SCHEMA ||
    typeof candidate.batchId !== 'string' ||
    !BATCH_ID.test(candidate.batchId) ||
    typeof candidate.sentAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.sentAt)) ||
    !Array.isArray(candidate.records) ||
    candidate.records.length < 1 ||
    candidate.records.length > MAX_RECORDS
  ) {
    return undefined;
  }
  return candidate as TelemetryBatch;
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (request, context) => {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return json({ error: 'content_type_must_be_json' }, 415);
    }
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json({ error: 'request_too_large' }, 413);
    }

    const raw = await request.text();
    if (byteLength(raw) > MAX_BODY_BYTES) {
      return json({ error: 'request_too_large' }, 413);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const batch = parseBatch(decoded);
    if (!batch) {
      return json({ error: 'invalid_next_loggers_batch' }, 400);
    }

    // The database function derives user ownership from auth.uid(), validates
    // every record, applies a per-user rate limit, and inserts idempotently.
    // Never trust loggedInUser, user_id, tenant_id, or role fields in the record.
    const { data, error } = await context.supabase.rpc('ingest_next_logger_batch', {
      p_batch_id: batch.batchId,
      p_records: batch.records,
    });
    if (error) {
      // Do not echo Postgres details or telemetry payloads to the client.
      const limited = /rate limit/iu.test(String(error.message));
      return json({ error: limited ? 'rate_limited' : 'ingest_rejected' }, limited ? 429 : 400);
    }

    return json({ ok: true, batchId: batch.batchId, result: data }, 202);
  }),
};
