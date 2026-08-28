import type { SupabaseIngestOptions } from './types.js';

function decodeBase64Url(value: string): string | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/').replace(/=+$/u, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    buffer = (buffer << 6) | index;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
    buffer &= bits === 0 ? 0 : (1 << bits) - 1;
  }
  try {
    return typeof TextDecoder === 'function'
      ? new TextDecoder().decode(Uint8Array.from(bytes))
      : String.fromCharCode(...bytes);
  } catch {
    return undefined;
  }
}

function decodeJwtRole(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = decodeBase64Url(payload);
    if (!decoded) return undefined;
    const claims = JSON.parse(decoded) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : undefined;
  } catch {
    return undefined;
  }
}

export function assertClientCredential(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new TypeError(`SupabaseIngestTransport requires ${label}`);
  }
  if (normalized.startsWith('sb_secret_') || /service[_-]?role/iu.test(normalized)) {
    throw new TypeError(`Secret/service-role Supabase credentials must never be used as ${label}`);
  }
  if (decodeJwtRole(normalized) === 'service_role') {
    throw new TypeError(`A service-role JWT must never be used as ${label}`);
  }
  return normalized;
}

export function assertClientToken(token: string | undefined, allowUnauthenticated: boolean): string | undefined {
  if (!token) {
    if (!allowUnauthenticated) {
      throw new Error(
        'Supabase telemetry ingestion requires a user access token; ' +
          'set allowUnauthenticated only for a deliberately publishable-key-only function',
      );
    }
    return undefined;
  }
  return assertClientCredential(token, 'a user access token');
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function functionUrl(options: SupabaseIngestOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new TypeError(`Supabase ingest URL must be valid, got: ${options.url}`);
  }
  if (parsed.protocol !== 'https:') {
    const allowedLocalHttp =
      parsed.protocol === 'http:' &&
      options.allowInsecureLocalhost === true &&
      isLocalhost(parsed.hostname);
    if (!allowedLocalHttp) {
      throw new TypeError(
        `Supabase ingest URL must use HTTPS; got ${parsed.protocol} for ${parsed.hostname}`,
      );
    }
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Supabase ingest URL must not contain embedded credentials');
  }
  if (options.allowedHosts && !options.allowedHosts.includes(parsed.host)) {
    throw new TypeError(`Supabase ingest host ${parsed.host} is not in allowedHosts`);
  }
  parsed.search = '';
  parsed.hash = '';
  const marker = '/functions/v1/';
  if (!parsed.pathname.includes(marker)) {
    const name = (options.functionName ?? 'telemetry-ingest').trim();
    if (!name) throw new TypeError('Supabase Edge Function name must not be empty');
    parsed.pathname = `${marker}${encodeURIComponent(name)}`;
  } else if (!parsed.pathname.split(marker)[1]?.replace(/^\/+|\/+$/gu, '')) {
    throw new TypeError('Supabase ingest URL must include an Edge Function name');
  }
  return parsed.toString();
}
