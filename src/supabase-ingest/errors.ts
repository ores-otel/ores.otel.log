export class SupabaseIngestHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMillis: number | undefined;
  readonly requestId: string | undefined;

  constructor(input: {
    status: number;
    statusText: string;
    retryable: boolean;
    retryAfterMillis?: number;
    requestId?: string;
  }) {
    super(
      `Supabase telemetry ingest returned ${input.status} ${input.statusText}` +
        (input.requestId ? ` (request ${input.requestId})` : ''),
    );
    this.name = 'SupabaseIngestHttpError';
    this.status = input.status;
    this.retryable = input.retryable;
    this.retryAfterMillis = input.retryAfterMillis;
    this.requestId = input.requestId;
  }
}

export class SupabaseIngestProtocolError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'SupabaseIngestProtocolError';
  }
}
