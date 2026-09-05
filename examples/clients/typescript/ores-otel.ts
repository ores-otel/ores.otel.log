// Fleet template (browser / WASM host / TS clients): stream client logs to the app's Supabase project
// over ores-otel/ws-ingest/v1 with commit acknowledgement. Never holds a Supabase key.
import { Logger } from '@oresoftware/next-loggers';
import { SupabaseWebSocketIngestTransport, type SupabaseWebSocketTicket } from '@oresoftware/next-loggers/supabase-websocket-ingest';

export interface OresTelemetryOptions {
  appName: string;
  apiBase: string;                       // e.g. https://api.example.com
  bearerToken: () => Promise<string | null>;  // shared-auth delegated token for this app
  appVersion?: string;
  release?: string;
  allowedHosts?: string[];
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

async function fetchTicket(o: OresTelemetryOptions): Promise<SupabaseWebSocketTicket> {
  const token = await o.bearerToken();
  if (!token) throw new Error('telemetry ticket requires an authenticated session');
  const res = await fetch(new URL('/api/telemetry/ticket', o.apiBase), { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`telemetry ticket endpoint returned ${res.status}`);
  const body = (await res.json()) as { url: string; ticket: string; expiresAt?: string };
  return { url: body.url, ticket: body.ticket, expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined };
}

export function startOresTelemetry(o: OresTelemetryOptions) {
  const runtime = typeof window !== 'undefined' ? 'browser' : typeof Deno !== 'undefined' ? 'deno' : 'node';
  const transport = new SupabaseWebSocketIngestTransport({
    ticketProvider: () => fetchTicket(o),
    session: { appName: o.appName, runtime, sessionId: randomId(), clientInstanceId: randomId(), appVersion: o.appVersion, release: o.release },
    allowedHosts: o.allowedHosts ?? [],
  });
  const log = new Logger({ appName: o.appName, transports: [transport] });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { void transport.flushOnExit(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void transport.flush(); });
  }
  return { log, transport, flush: () => transport.flush(), close: () => log.close() };
}
