import type { LogRecord } from '../base-logger.js';

export interface SupabaseIngestDrop {
  reason: 'queue-full' | 'record-too-large' | 'closed' | 'server-rejected';
  record: LogRecord;
  droppedTotal: number;
}

export interface SupabaseIngestSnapshot {
  queued: number;
  inFlight: number;
  acknowledged: number;
  rejected: number;
  dropped: number;
  failures: number;
  /** Consecutive retry attempts for the current in-flight batch. */
  retryAttempts: number;
  /** Lifetime retry schedules observed by this transport. */
  retries: number;
  accepting: boolean;
  closed: boolean;
}

export interface SupabaseIngestAcknowledgement {
  schema: 'next-loggers/ingest-ack/v1';
  batchId: string;
  accepted: number;
  duplicates: number;
  requested: number;
  /** Present only when the server confirms the database transaction completed. */
  committedAt?: string;
  /** @deprecated Use duplicates; this is true only for a whole-batch replay. */
  duplicate: boolean;
  requestId?: string;
}

export interface SupabaseRejectedBatch {
  batchId: string;
  status: number;
  records: readonly LogRecord[];
  error: unknown;
}

export interface SupabaseIngestOptions {
  /** Supabase project URL or complete Edge Function URL. */
  url: string;
  /** Client-safe sb_publishable_* key (legacy anon keys also work during migration). */
  publishableKey: string;
  /** User access token. Never pass a service-role or sb_secret_* key. */
  accessToken?: string | (() => string | undefined | Promise<string | undefined>);
  /**
   * Authenticated ingestion is the safe default. Set this only when the Edge
   * Function is deliberately configured for publishable-key-only ingestion.
   */
  allowUnauthenticated?: boolean;
  /** Permit http:// only for localhost development. Production defaults to HTTPS only. */
  allowInsecureLocalhost?: boolean;
  /** Optional exact host allow-list for custom domains and SSRF-sensitive runtimes. */
  allowedHosts?: readonly string[];
  functionName?: string;
  batchSize?: number;
  maxQueueSize?: number;
  maxRecordBytes?: number;
  /** Maximum serialized records per ordinary request. Default 480 KiB. */
  maxBatchBytes?: number;
  /** Smaller keepalive budget used during page/process exit. Default 60 KiB. */
  maxExitBatchBytes?: number;
  flushIntervalMillis?: number;
  timeoutMillis?: number;
  retryBaseMillis?: number;
  retryMaxMillis?: number;
  /** Upper bound applied to Retry-After. Default 60 seconds. */
  maxRetryAfterMillis?: number;
  fetch?: typeof fetch;
  awaitDelivery?: boolean;
  /** Testable clock used for batch sentAt and Retry-After dates. */
  clock?: () => Date;
  /** Testable source of retry jitter in the range [0, 1]. */
  random?: () => number;
  /** Require a commit acknowledgement containing the same batchId. Default true. */
  requireCommitAcknowledgement?: boolean;
  /** Injectable for deterministic tests. A generated ID is stable across retries. */
  batchIdFactory?: () => string;
  onDrop?: (drop: SupabaseIngestDrop) => void;
  onAcknowledged?: (acknowledgement: SupabaseIngestAcknowledgement) => void;
  onRejectedBatch?: (rejection: SupabaseRejectedBatch) => void;
  onError?: (error: unknown, snapshot: SupabaseIngestSnapshot) => void;
}
