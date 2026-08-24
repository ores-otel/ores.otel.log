import type { LogRecord, LogTransport } from './base-logger.js';
import {
  ORES_SUPABASE_WEBSOCKET_PROTOCOL,
  SupabaseWebSocketIngestTransport,
  type SupabaseTelemetrySession,
  type SupabaseWebSocketIngestOptions,
  type SupabaseWebSocketSnapshot,
} from './supabase-websocket-ingest.js';

export const ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA =
  'ores-otel/supabase-websocket-queue/v1' as const;

export interface SupabaseWebSocketQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistentSupabaseWebSocketDropReason =
  | 'closed'
  | 'expired'
  | 'invalid-state'
  | 'persistent-queue-full'
  | 'record-too-large'
  | 'session-mismatch';

export interface PersistentSupabaseWebSocketDrop {
  reason: PersistentSupabaseWebSocketDropReason;
  recordId?: string;
  record?: LogRecord;
  droppedTotal: number;
}

export interface PersistentSupabaseWebSocketSnapshot {
  persisted: number;
  resident: number;
  restored: number;
  dropped: number;
  persistenceErrors: number;
  accepting: boolean;
  draining: boolean;
  closed: boolean;
  inner?: SupabaseWebSocketSnapshot;
}

export interface SupabaseWebSocketIngestDelegate extends LogTransport {
  write(record: LogRecord): void | Promise<void>;
  flush(): void | Promise<void>;
  flushOnExit?(records?: readonly LogRecord[]): void | Promise<void>;
  close?(): void | Promise<void>;
  snapshot?(): SupabaseWebSocketSnapshot;
}

export type SupabaseWebSocketIngestTransportFactory = (
  options: SupabaseWebSocketIngestOptions,
) => SupabaseWebSocketIngestDelegate;

export interface PersistentSupabaseWebSocketIngestOptions
  extends Omit<
    SupabaseWebSocketIngestOptions,
    'awaitAcknowledgement' | 'recordIdFactory'
  > {
  /** Synchronous durable storage; browser callers normally pass sessionStorage. */
  storage: SupabaseWebSocketQueueStorage;
  storageKey?: string;
  maxPersistedRecords?: number;
  maxPersistedAgeMillis?: number;
  autoReplay?: boolean;
  /** Resolve write() only after the database commit acknowledgement. */
  awaitAcknowledgement?: boolean;
  /** Stable id persisted before the record enters the socket queue. */
  recordIdFactory?: () => string;
  onPersistentDrop?: (drop: PersistentSupabaseWebSocketDrop) => void;
  onPersistenceError?: (
    error: unknown,
    snapshot: PersistentSupabaseWebSocketSnapshot,
  ) => void;
  /** Conformance-test and compatible-adapter injection point. */
  transportFactory?: SupabaseWebSocketIngestTransportFactory;
}

interface Entry {
  recordId: string;
  sequence: number;
  createdAtMillis: number;
  record: LogRecord;
}

interface StoredState {
  schema: typeof ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA;
  protocol: typeof ORES_SUPABASE_WEBSOCKET_PROTOCOL;
  sessionFingerprint: string;
  savedAtMillis: number;
  nextSequence: number;
  entries: Entry[];
}

function integer(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isSafeInteger(value) && Number(value) >= minimum
    ? Number(value)
    : fallback;
}

function byteLength(value: string): number {
  return typeof TextEncoder === 'function'
    ? new TextEncoder().encode(value).byteLength
    : value.length;
}

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `record-${uuid}`
    : `record-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sessionFingerprint(session: SupabaseTelemetrySession): string {
  return JSON.stringify([
    session.appName,
    session.runtime,
    session.sessionId,
    session.clientInstanceId,
    session.appVersion ?? null,
    session.release ?? null,
  ]);
}

function isRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LogRecord>;
  return record.schema === 'next-loggers/v1'
    && typeof record.id === 'string'
    && typeof record.timestamp === 'string'
    && typeof record.level === 'string'
    && typeof record.runtime === 'string'
    && typeof record.appName === 'string'
    && typeof record.message === 'string'
    && Array.isArray(record.values)
    && Boolean(record.fields)
    && typeof record.fields === 'object';
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Entry>;
  return typeof entry.recordId === 'string'
    && entry.recordId.trim() !== ''
    && Number.isSafeInteger(entry.sequence)
    && Number(entry.sequence) >= 0
    && Number.isFinite(entry.createdAtMillis)
    && Number(entry.createdAtMillis) >= 0
    && isRecord(entry.record);
}

/**
 * Crash/reload-safe wrapper for SupabaseWebSocketIngestTransport.
 *
 * Stable ids are persisted before socket enqueue and removed only after the
 * delegate's post-transaction commit acknowledgement. Replay is at-least-once;
 * the ingest transaction must deduplicate on recordId.
 */
export class PersistentSupabaseWebSocketIngestTransport implements LogTransport {
  readonly name = 'supabase-websocket-ingest-persistent';
  readonly options: Readonly<PersistentSupabaseWebSocketIngestOptions>;

  private readonly storage: SupabaseWebSocketQueueStorage;
  private readonly storageKey: string;
  private readonly fingerprint: string;
  private readonly maxRecords: number;
  private readonly maxAgeMillis: number;
  private readonly maxRecordBytes: number;
  private readonly idFactory: () => string;
  private readonly inner: SupabaseWebSocketIngestDelegate;
  private readonly residentIds = new Set<string>();

  private entries: Entry[] = [];
  private nextSequence = 0;
  private restored = 0;
  private dropped = 0;
  private persistenceErrors = 0;
  private expectedRecordId: string | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainScheduled = false;
  private accepting = true;
  private closed = false;

  constructor(options: PersistentSupabaseWebSocketIngestOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Persistent Supabase WebSocket options are required');
    }
    if (!options.storage || typeof options.storage !== 'object') {
      throw new TypeError('Persistent Supabase WebSocket storage is required');
    }
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      if (typeof options.storage[method] !== 'function') {
        throw new TypeError(`storage.${method} must be a function`);
      }
    }

    this.options = options;
    this.storage = options.storage;
    this.storageKey = options.storageKey?.trim()
      || `ores-otel:supabase-websocket-queue:v1:${encodeURIComponent(options.session.appName)}`;
    this.fingerprint = sessionFingerprint(options.session);
    this.maxRecords = integer(options.maxPersistedRecords, 2_000, 1);
    this.maxAgeMillis = integer(options.maxPersistedAgeMillis, 86_400_000, 1);
    this.maxRecordBytes = integer(options.maxRecordBytes, 128 * 1_024, 1);
    this.idFactory = options.recordIdFactory ?? randomId;
    this.restore();

    const {
      storage: _storage,
      storageKey: _storageKey,
      maxPersistedRecords: _maxPersistedRecords,
      maxPersistedAgeMillis: _maxPersistedAgeMillis,
      autoReplay: _autoReplay,
      awaitAcknowledgement: _awaitAcknowledgement,
      recordIdFactory: _recordIdFactory,
      onPersistentDrop: _onPersistentDrop,
      onPersistenceError: _onPersistenceError,
      transportFactory,
      ...transportOptions
    } = options;
    const innerOptions: SupabaseWebSocketIngestOptions = {
      ...transportOptions,
      awaitAcknowledgement: false,
      maxQueueSize: Math.max(options.maxQueueSize ?? this.maxRecords, this.maxRecords),
      recordIdFactory: () => {
        const id = this.expectedRecordId;
        if (!id) throw new Error('Inner transport requested an unpersisted record id');
        this.expectedRecordId = null;
        return id;
      },
    };
    this.inner = transportFactory?.(innerOptions)
      ?? new SupabaseWebSocketIngestTransport(innerOptions);

    if (options.autoReplay !== false && this.entries.length > 0) this.scheduleDrain();
  }

  snapshot(): PersistentSupabaseWebSocketSnapshot {
    const inner = this.inner.snapshot?.();
    return {
      persisted: this.entries.length,
      resident: this.residentIds.size,
      restored: this.restored,
      dropped: this.dropped,
      persistenceErrors: this.persistenceErrors,
      accepting: this.accepting,
      draining: Boolean(this.drainPromise),
      closed: this.closed,
      ...(inner ? { inner } : {}),
    };
  }

  async write(record: LogRecord): Promise<void> {
    if (!this.accepting) {
      this.reportDrop('closed', undefined, record);
      throw new Error('Persistent Supabase WebSocket transport is closed');
    }
    if (!this.persistRecord(record)) return;
    if (this.options.awaitAcknowledgement === true) {
      await this.flush();
    } else {
      this.scheduleDrain();
    }
  }

  async flush(): Promise<void> {
    await this.startDrain(false);
  }

  async flushOnExit(records: readonly LogRecord[] = []): Promise<void> {
    if (!this.accepting && records.length > 0) {
      for (const record of records) this.reportDrop('closed', undefined, record);
      throw new Error('Persistent Supabase WebSocket transport is closed');
    }
    for (const record of records) this.persistRecord(record);
    await this.startDrain(true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    let firstError: unknown;
    try {
      await this.flushOnExit();
    } catch (error) {
      firstError = error;
    }
    try {
      await this.inner.close?.();
      if (this.residentIds.size > 0) {
        this.removeCommitted(new Set(this.residentIds));
      }
    } catch (error) {
      firstError ??= error;
    }
    this.closed = true;
    if (firstError) throw firstError;
  }

  private persistRecord(record: LogRecord): Entry | null {
    let encoded: string;
    try {
      encoded = JSON.stringify(record);
    } catch (error) {
      this.reportPersistenceError(error);
      return null;
    }
    if (byteLength(encoded) > this.maxRecordBytes) {
      this.reportDrop('record-too-large', undefined, record);
      return null;
    }
    const recordId = String(this.idFactory()).trim();
    if (!recordId) throw new Error('recordIdFactory returned an empty id');
    if (this.entries.some((entry) => entry.recordId === recordId)) {
      throw new Error(`recordIdFactory returned duplicate id ${recordId}`);
    }

    const entry: Entry = {
      recordId,
      sequence: this.nextSequence,
      createdAtMillis: this.nowMillis(),
      record,
    };
    const next = [...this.entries, entry];
    const displaced: Entry[] = [];
    while (next.length > this.maxRecords) {
      const index = next.findIndex((candidate) => !this.residentIds.has(candidate.recordId));
      if (index < 0) {
        this.reportDrop('persistent-queue-full', recordId, record);
        return null;
      }
      const [removed] = next.splice(index, 1);
      if (removed) displaced.push(removed);
    }

    try {
      this.writeState(next, this.nextSequence + 1);
    } catch (error) {
      this.reportPersistenceError(error);
      throw error;
    }
    this.entries = next;
    this.nextSequence += 1;
    for (const removed of displaced) {
      this.reportDrop('persistent-queue-full', removed.recordId, removed.record);
    }
    return entry;
  }

  private startDrain(useExitFallback: boolean): Promise<void> {
    if (this.entries.length === 0) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain(useExitFallback).finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drain(useExitFallback: boolean): Promise<void> {
    for (const entry of this.entries) {
      if (this.residentIds.has(entry.recordId)) continue;
      this.expectedRecordId = entry.recordId;
      try {
        await this.inner.write(entry.record);
      } finally {
        const consumed = this.expectedRecordId === null;
        this.expectedRecordId = null;
        if (consumed) this.residentIds.add(entry.recordId);
      }
    }

    try {
      await this.inner.flush();
    } catch (error) {
      if (!useExitFallback || !this.inner.flushOnExit) throw error;
      await this.inner.flushOnExit([]);
    }
    if (this.residentIds.size === 0) {
      throw new Error('Supabase flush completed without resident records');
    }
    this.removeCommitted(new Set(this.residentIds));
  }

  private removeCommitted(recordIds: ReadonlySet<string>): void {
    this.entries = this.entries.filter((entry) => !recordIds.has(entry.recordId));
    for (const id of recordIds) this.residentIds.delete(id);
    try {
      this.writeState(this.entries, this.nextSequence);
    } catch (error) {
      // A stale queue can only replay the same stable ids; server deduplication is required.
      this.reportPersistenceError(error);
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.drainPromise || this.entries.length === 0) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.closed || this.entries.length === 0) return;
      void this.startDrain(false).catch((error: unknown) => {
        this.reportPersistenceError(error);
      });
    });
  }

  private restore(): void {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch (error) {
      this.reportPersistenceError(error);
      return;
    }
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      this.clearInvalid(error);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.clearInvalid(new Error('Persisted telemetry state is not an object'));
      return;
    }
    const state = parsed as Partial<StoredState>;
    if (
      state.schema !== ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA
      || state.protocol !== ORES_SUPABASE_WEBSOCKET_PROTOCOL
      || typeof state.sessionFingerprint !== 'string'
      || !Array.isArray(state.entries)
    ) {
      this.clearInvalid(new Error('Persisted telemetry state schema is invalid'));
      return;
    }
    if (state.sessionFingerprint !== this.fingerprint) {
      const count = Math.max(1, state.entries.length);
      this.removeStorageBestEffort();
      for (let index = 0; index < count; index += 1) {
        this.reportDrop('session-mismatch');
      }
      return;
    }

    const oldestAllowed = this.nowMillis() - this.maxAgeMillis;
    const seen = new Set<string>();
    const valid: Entry[] = [];
    for (const candidate of state.entries) {
      if (!isEntry(candidate) || seen.has(candidate.recordId)) {
        this.reportDrop('invalid-state');
        continue;
      }
      seen.add(candidate.recordId);
      let encoded: string;
      try {
        encoded = JSON.stringify(candidate.record);
      } catch {
        this.reportDrop('invalid-state', candidate.recordId, candidate.record);
        continue;
      }
      if (byteLength(encoded) > this.maxRecordBytes) {
        this.reportDrop('record-too-large', candidate.recordId, candidate.record);
        continue;
      }
      if (candidate.createdAtMillis < oldestAllowed) {
        this.reportDrop('expired', candidate.recordId, candidate.record);
        continue;
      }
      valid.push(candidate);
    }
    valid.sort((left, right) => left.sequence - right.sequence);
    while (valid.length > this.maxRecords) {
      const removed = valid.shift();
      if (removed) this.reportDrop('persistent-queue-full', removed.recordId, removed.record);
    }
    const minimumNext = valid.reduce(
      (maximum, entry) => Math.max(maximum, entry.sequence + 1),
      0,
    );
    this.entries = valid;
    this.restored = valid.length;
    this.nextSequence = Math.max(
      integer(state.nextSequence, minimumNext, 0),
      minimumNext,
    );
    try {
      this.writeState(this.entries, this.nextSequence);
    } catch (error) {
      this.reportPersistenceError(error);
    }
  }

  private writeState(entries: Entry[], nextSequence: number): void {
    if (entries.length === 0) {
      this.storage.removeItem(this.storageKey);
      return;
    }
    const state: StoredState = {
      schema: ORES_SUPABASE_WEBSOCKET_QUEUE_SCHEMA,
      protocol: ORES_SUPABASE_WEBSOCKET_PROTOCOL,
      sessionFingerprint: this.fingerprint,
      savedAtMillis: this.nowMillis(),
      nextSequence,
      entries,
    };
    this.storage.setItem(this.storageKey, JSON.stringify(state));
  }

  private clearInvalid(error: unknown): void {
    this.removeStorageBestEffort();
    this.reportDrop('invalid-state');
    this.reportPersistenceError(error);
  }

  private removeStorageBestEffort(): void {
    try {
      this.storage.removeItem(this.storageKey);
    } catch (error) {
      this.reportPersistenceError(error);
    }
  }

  private nowMillis(): number {
    try {
      const value = this.options.clock?.() ?? new Date();
      return value instanceof Date && Number.isFinite(value.getTime())
        ? value.getTime()
        : Date.now();
    } catch {
      return Date.now();
    }
  }

  private reportDrop(
    reason: PersistentSupabaseWebSocketDropReason,
    recordId?: string,
    record?: LogRecord,
  ): void {
    this.dropped += 1;
    try {
      this.options.onPersistentDrop?.({
        reason,
        ...(recordId ? { recordId } : {}),
        ...(record ? { record } : {}),
        droppedTotal: this.dropped,
      });
    } catch {
      // Diagnostics must not recurse into telemetry delivery.
    }
  }

  private reportPersistenceError(error: unknown): void {
    this.persistenceErrors += 1;
    try {
      this.options.onPersistenceError?.(error, this.snapshot());
    } catch {
      // Diagnostics must not recurse into telemetry delivery.
    }
  }
}

export function createPersistentSupabaseWebSocketIngestTransport(
  options: PersistentSupabaseWebSocketIngestOptions,
): PersistentSupabaseWebSocketIngestTransport {
  return new PersistentSupabaseWebSocketIngestTransport(options);
}
