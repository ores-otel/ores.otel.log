import {
  BaseLogger,
  type FlushOptions,
  type LogEvent,
  type LogFields,
  type LoggerOptions,
} from './base-logger.js';

export interface WasmLoggerOptions extends LoggerOptions {
  moduleName?: string;
  instanceName?: string;
}

export interface WasmLogPayload {
  level?: string | number;
  message: string;
  values?: unknown[];
  fields?: LogFields;
  tags?: string[];
  traceId?: string;
  routineId?: string;
  context?: unknown[];
  meta?: unknown[];
}

export interface WasmLoggerHostOptions {
  /** A memory instance or late-bound getter for memories exported after instantiation. */
  memory: WebAssembly.Memory | (() => WebAssembly.Memory);
  namespace?: string;
  maximumPayloadBytes?: number;
  waitUntil?: (promise: Promise<void>) => void;
  onDecodeError?: (error: Error) => void;
}

export interface WasmLoggerImports {
  emit_json(pointer: number, length: number): number;
  emit_utf8(level: number, pointer: number, length: number): number;
}

export interface WasmLoggerHost {
  readonly imports: Record<string, WasmLoggerImports>;
  flush(options?: FlushOptions): Promise<void>;
}

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
type WasmLevel = (typeof LEVELS)[number];

function normalizeLevel(level: string | number | undefined): WasmLevel {
  if (typeof level === 'number') {
    return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, Math.trunc(level)))] ?? 'INFO';
  }
  const normalized = String(level ?? 'INFO').toUpperCase() as WasmLevel;
  return LEVELS.includes(normalized) ? normalized : 'INFO';
}

function eventFor(logger: BaseLogger, level: WasmLevel, values: unknown[]): LogEvent {
  switch (level) {
    case 'TRACE':
      return logger.trace(...values);
    case 'DEBUG':
      return logger.debug(...values);
    case 'WARN':
      return logger.warn(...values);
    case 'ERROR':
      return logger.error(...values);
    case 'FATAL':
      return logger.fatal(...values);
    default:
      return logger.info(...values);
  }
}

export class WasmLogger extends BaseLogger {
  protected declare readonly options: Readonly<WasmLoggerOptions>;

  constructor(options: WasmLoggerOptions = {}) {
    super(options, 'wasm');
  }

  override getRuntimeFields(): LogFields {
    return {
      ...(this.options.moduleName ? { wasmModule: this.options.moduleName } : {}),
      ...(this.options.instanceName ? { wasmInstance: this.options.instanceName } : {}),
    };
  }

  override anew(options: WasmLoggerOptions = {}): WasmLogger {
    return new WasmLogger({
      ...this.options,
      ...options,
      appName: options.appName || this.appName,
      fields: { ...this.fields, ...options.fields },
      loggedInUser: { ...this.getCurrentUser(), ...options.loggedInUser },
    });
  }
}

export function createWasmLogger(options: WasmLoggerOptions = {}): WasmLogger {
  return new WasmLogger(options);
}

function decorateEvent(event: LogEvent, payload: WasmLogPayload): LogEvent {
  if (payload.fields) {
    event.addFields(payload.fields);
  }
  if (payload.tags?.length) {
    event.addTags(...payload.tags);
  }
  if (payload.traceId) {
    event.addTrace(payload.traceId, { makeFirst: true });
  }
  if (payload.routineId) {
    event.addRoutineId(payload.routineId);
  }
  for (const value of payload.context ?? []) {
    event.addContext(value);
  }
  for (const value of payload.meta ?? []) {
    event.addMeta(value);
  }
  return event;
}

/**
 * Creates synchronous WebAssembly imports that enqueue normal next-loggers
 * events. The host owns memory and async delivery; no WebAssembly runtime or
 * browser API is patched.
 */
export function createWasmLoggerHost(
  logger: BaseLogger,
  options: WasmLoggerHostOptions,
): WasmLoggerHost {
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('createWasmLoggerHost requires a next-loggers logger');
  }
  if (!options?.memory) {
    throw new TypeError('createWasmLoggerHost requires WebAssembly memory');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const configuredMaximum = options.maximumPayloadBytes ?? 256 * 1_024;
  const maximumPayloadBytes = Number.isFinite(configuredMaximum)
    ? Math.max(1, Math.floor(configuredMaximum))
    : 256 * 1_024;
  const pending = new Set<Promise<void>>();

  const memory = (): WebAssembly.Memory => {
    const value = typeof options.memory === 'function' ? options.memory() : options.memory;
    if (!(value instanceof WebAssembly.Memory)) {
      throw new TypeError('WASM memory getter did not return WebAssembly.Memory');
    }
    return value;
  };

  const decode = (pointer: number, length: number): string => {
    if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0) {
      throw new RangeError('WASM log pointer and length must be non-negative integers');
    }
    if (length > maximumPayloadBytes) {
      throw new RangeError(`WASM log payload exceeds ${maximumPayloadBytes} bytes`);
    }
    const bytes = new Uint8Array(memory().buffer);
    if (pointer > bytes.byteLength || length > bytes.byteLength - pointer) {
      throw new RangeError('WASM log payload is outside linear memory');
    }
    return decoder.decode(bytes.subarray(pointer, pointer + length));
  };

  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    const cleanup = (): void => void pending.delete(promise);
    void promise.then(cleanup, cleanup);
    try {
      options.waitUntil?.(promise);
    } catch {
      // A host lifecycle callback must never throw through the synchronous ABI.
    }
  };

  const reportDecodeError = (error: unknown): number => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      options.onDecodeError?.(normalized);
    } catch {
      // Diagnostics are advisory and cannot alter the ABI return contract.
    }
    try {
      const task = logger
        .error('Rejected WebAssembly log payload', normalized)
        .addTags('wasm', 'decode-error')
        .send();
      track(task);
    } catch {
      // A closed or broken logger still yields the deterministic -1 ABI result.
    }
    return -1;
  };

  const emitPayload = (payload: WasmLogPayload): number => {
    if (!payload || typeof payload !== 'object' || typeof payload.message !== 'string') {
      return reportDecodeError(new TypeError('WASM JSON payload requires a string message'));
    }
    const values = [payload.message, ...(payload.values ?? [])];
    const event = decorateEvent(eventFor(logger, normalizeLevel(payload.level), values), payload);
    track(event.addTags('wasm').send());
    return 0;
  };

  const imports: WasmLoggerImports = {
    emit_json(pointer, length) {
      try {
        return emitPayload(JSON.parse(decode(pointer, length)) as WasmLogPayload);
      } catch (error) {
        return reportDecodeError(error);
      }
    },
    emit_utf8(level, pointer, length) {
      try {
        return emitPayload({ level, message: decode(pointer, length) });
      } catch (error) {
        return reportDecodeError(error);
      }
    },
  };

  return {
    imports: { [options.namespace ?? 'next_loggers']: imports },
    async flush(flushOptions = {}) {
      await Promise.allSettled(Array.from(pending));
      await logger.flush(flushOptions);
    },
  };
}

export const wasmLogger = createWasmLogger();
export { wasmLogger as logger };
export default wasmLogger;
