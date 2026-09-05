// ores-otel/ws-ingest/v1 — commit-acknowledged WebSocket telemetry ingest for one application's Supabase project.
//
// Protocol (docs/supabase-websocket-ingest-v1.md):
//   client → { type: "hello", protocol, ticket, session }        ticket = one-time HMAC ticket minted by the app backend
//   client → { type: "telemetry_batch", batchId, sequence, records: [{recordId, record}] }
//   server → { type: "commit_ack", batchId, sequence, accepted, duplicates, committedAt }   only after the RPC committed
//   server → { type: "error", code, message } then close(4xxx)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (edge runtime injects these), TELEMETRY_TICKET_SECRET (shared with the
// app backend that mints tickets), TELEMETRY_ALLOWED_APP_NAMES (comma list), TELEMETRY_MAX_BATCH (default 200).
import { createClient } from 'npm:@supabase/supabase-js@2';

const PROTOCOL = 'ores-otel/ws-ingest/v1';
const MAX_BATCH = Number(Deno.env.get('TELEMETRY_MAX_BATCH') ?? '200');
const MAX_FRAME_BYTES = 512 * 1024;

type Ticket = { userId: string; appName: string; projectRef: string; exp: number; nonce: string };

function envSet(name: string): Set<string> {
  return new Set((Deno.env.get(name) ?? '').split(',').map((v) => v.trim()).filter(Boolean));
}

const b64url = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  decode: (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)),
};

/** Ticket wire format: base64url(payloadJson) + "." + base64url(hmacSha256(secret, payloadJson)). */
async function verifyTicket(raw: string, secret: string, now = Date.now()): Promise<Ticket | null> {
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  let payloadBytes: Uint8Array; let sig: Uint8Array;
  try { payloadBytes = b64url.decode(payloadB64); sig = b64url.decode(sigB64); } catch { return null; }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, sig, payloadBytes);
  if (!ok) return null;
  let t: Ticket;
  try { t = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return null; }
  if (typeof t.userId !== 'string' || typeof t.appName !== 'string' || typeof t.projectRef !== 'string' || typeof t.nonce !== 'string' || typeof t.exp !== 'number') return null;
  if (t.exp * 1000 < now) return null;
  if (t.nonce.length < 16) return null;
  return t;
}

function projectRefFromUrl(url: string): string {
  return new URL(url).hostname.split('.')[0];
}

function send(ws: WebSocket, msg: Record<string, unknown>) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function fail(ws: WebSocket, code: number, reason: string) { send(ws, { type: 'error', protocol: PROTOCOL, code: reason, message: reason }); try { ws.close(code, reason.slice(0, 120)); } catch { /* closed */ } }

Deno.serve(async (req) => {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({ protocol: PROTOCOL, error: 'websocket_required' }), { status: 426, headers: { 'content-type': 'application/json' } });
  }
  const secret = Deno.env.get('TELEMETRY_TICKET_SECRET');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !supabaseUrl || !serviceKey) return new Response('telemetry ingest is not configured', { status: 503 });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const allowedApps = envSet('TELEMETRY_ALLOWED_APP_NAMES');
  const projectRef = projectRefFromUrl(supabaseUrl);

  const { socket, response } = Deno.upgradeWebSocket(req);
  let ticket: Ticket | null = null;
  let runtime = 'unknown';
  let inFlight = false;
  const helloTimer = setTimeout(() => { if (!ticket) fail(socket, 4401, 'hello_timeout'); }, 5000);

  socket.onmessage = async (event) => {
    const data = typeof event.data === 'string' ? event.data : '';
    if (data.length > MAX_FRAME_BYTES) return fail(socket, 4413, 'frame_too_large');
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return fail(socket, 4400, 'invalid_json'); }
    if (msg.protocol !== PROTOCOL) return fail(socket, 4400, 'protocol_mismatch');

    if (msg.type === 'hello') {
      if (ticket) return fail(socket, 4400, 'duplicate_hello');
      const t = await verifyTicket(String(msg.ticket ?? ''), secret);
      if (!t) return fail(socket, 4401, 'ticket_invalid');
      const session = (msg.session ?? {}) as Record<string, unknown>;
      if (session.appName !== t.appName) return fail(socket, 4403, 'app_mismatch');
      if (t.projectRef !== projectRef) return fail(socket, 4403, 'project_mismatch');
      if (allowedApps.size && !allowedApps.has(t.appName)) return fail(socket, 4403, 'app_not_allowed');
      const { data: fresh, error } = await admin.rpc('consume_telemetry_ws_ticket', { p_nonce: t.nonce, p_user_id: t.userId, p_app_name: t.appName, p_expires_at: new Date(t.exp * 1000).toISOString() });
      if (error || fresh !== true) return fail(socket, 4401, 'ticket_replayed');
      ticket = t; runtime = String(session.runtime ?? 'unknown').slice(0, 64);
      clearTimeout(helloTimer);
      return send(socket, { type: 'hello_ack', protocol: PROTOCOL, projectRef, maxBatch: MAX_BATCH });
    }

    if (!ticket) return fail(socket, 4401, 'hello_required');
    if (msg.type !== 'telemetry_batch') return fail(socket, 4400, 'unknown_message_type');
    if (inFlight) return fail(socket, 4429, 'one_batch_in_flight');
    const { batchId, sequence, records } = msg as { batchId?: unknown; sequence?: unknown; records?: unknown };
    if (typeof batchId !== 'string' || batchId.length < 8 || batchId.length > 128) return fail(socket, 4400, 'invalid_batch_id');
    if (!Number.isInteger(sequence) || (sequence as number) < 0) return fail(socket, 4400, 'invalid_sequence');
    if (!Array.isArray(records) || records.length < 1 || records.length > MAX_BATCH) return fail(socket, 4400, 'invalid_records');
    for (const r of records) {
      if (!r || typeof r !== 'object' || typeof (r as { recordId?: unknown }).recordId !== 'string' || typeof (r as { record?: unknown }).record !== 'object') return fail(socket, 4400, 'invalid_record');
    }
    inFlight = true;
    try {
      const { data, error } = await admin.rpc('ingest_telemetry_ws_batch', {
        p_user_id: ticket.userId, p_app_name: ticket.appName, p_runtime: runtime, p_batch_id: batchId, p_sequence: sequence, p_records: records,
      });
      if (error) {
        const reused = /reused with different contents/.test(error.message);
        return fail(socket, reused ? 4409 : 4500, reused ? 'batch_id_reused' : 'commit_failed');
      }
      const ack = data as { batchId: string; sequence: number; accepted: number; duplicates: number; committedAt: string };
      if (ack.batchId !== batchId || ack.sequence !== sequence || ack.accepted + ack.duplicates !== records.length) return fail(socket, 4500, 'ack_invariant_violation');
      send(socket, { type: 'commit_ack', protocol: PROTOCOL, ...ack });
    } finally {
      inFlight = false;
    }
  };
  socket.onerror = () => { clearTimeout(helloTimer); };
  socket.onclose = () => { clearTimeout(helloTimer); };
  return response;
});
