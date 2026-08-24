import type { SupabaseIngestOptions } from './types.js';
import { SupabaseIngestHttpError, SupabaseIngestProtocolError } from './errors.js';
import type { LogRecord } from '../base-logger.js';

export interface PendingBatch {
  readonly batchId: string;
  readonly records: readonly LogRecord[];
}

interface ParsedAcknowledgement {
  batchId: string;
  accepted: number;
  duplicate: boolean;
}

export function timerUnref(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  candidate.unref?.();
}

export function byteLength(value: string): number {
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
}

export function generateBatchId(): string {
  const cryptoValue = globalThis.crypto;
  if (cryptoValue?.randomUUID) {
    return cryptoValue.randomUUID();
  }
  if (cryptoValue?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoValue.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 ||
    status === 502 || status === 503 || status === 504;
}

export function parseRetryAfter(
  value: string | null,
  maximumMillis: number,
  nowMillis = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(maximumMillis, Math.round(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.min(maximumMillis, Math.max(0, date - nowMillis));
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof SupabaseIngestHttpError || error instanceof SupabaseIngestProtocolError) {
    return error.retryable;
  }
  // Fetch/network failures and AbortError are transient unless proven otherwise.
  return true;
}

export async function resolveToken(
  value: SupabaseIngestOptions['accessToken'],
): Promise<string | undefined> {
  const token = typeof value === 'function' ? await value() : value;
  if (token === undefined) return undefined;
  if (typeof token !== 'string') {
    throw new TypeError('Supabase accessToken callback must return a string or undefined');
  }
  return token.trim() || undefined;
}

export async function parseAcknowledgement(
  response: Response,
  batch: PendingBatch,
  required: boolean,
): Promise<ParsedAcknowledgement> {
  if (!required) {
    return { batchId: batch.batchId, accepted: batch.records.length, duplicate: false };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new SupabaseIngestProtocolError(
      `Supabase telemetry ingest did not return JSON acknowledgement for batch ${batch.batchId}`,
    );
  }
  if (!data || typeof data !== 'object') {
    throw new SupabaseIngestProtocolError('Supabase telemetry acknowledgement must be an object');
  }
  const value = data as Record<string, unknown>;
  if (value.batchId !== batch.batchId) {
    throw new SupabaseIngestProtocolError(
      `Supabase telemetry acknowledgement batchId mismatch: expected ${batch.batchId}`,
    );
  }
  if (!Number.isInteger(value.accepted) || (value.accepted as number) < 0) {
    throw new SupabaseIngestProtocolError('Supabase telemetry acknowledgement has invalid accepted count');
  }
  if (value.duplicate !== undefined && typeof value.duplicate !== 'boolean') {
    throw new SupabaseIngestProtocolError('Supabase telemetry acknowledgement has invalid duplicate flag');
  }
  const accepted = value.accepted as number;
  const duplicate = value.duplicate === true;
  if ((duplicate && accepted !== 0) || (!duplicate && accepted !== batch.records.length)) {
    throw new SupabaseIngestProtocolError(
      'Supabase telemetry acknowledgement does not account for the complete batch',
    );
  }
  return { batchId: batch.batchId, accepted, duplicate };
}
