import type { LogRecord, LogTransport } from './base-logger.js';

/**
 * Browser-side log streaming over a persistent WebSocket.
 *
 * The shipped SupabaseRealtimeTransport speaks the Phoenix protocol and sends
 * one frame per record. That is fine on a server, but a browser tab needs
 * three things it does not provide:
 *
 *   1. Batching — a chatty page can emit hundreds of records per second, and a
 *      frame each would swamp the socket and the collector.
 *   2. A bounded buffer that survives disconnects — tab sleep, network blips
 *      and proxy resets are normal, and records must not be lost or grow
 *      without limit while the socket is down.
 *   3. A last-gasp flush on pagehide, where async sends are unreliable.
 *
 * This transport wraps any inner transport (Supabase Realtime, a raw
 * WebSocket, an HTTP collector) with that queueing policy, so the destination
 * stays pluggable — "Supabase or wherever".
 */

/** Minimal WebSocket contract; matches the browser global and ws-style shims. */
export interface StreamSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface BrowserStreamOptions {
  /**
   * Where batches go. Provide `url` for a plain WebSocket collector, or
   * `transport` to reuse an existing transport (e.g. SupabaseRealtimeTransport)
   * and get only the batching/buffering policy.
   */
  url?: string;
  transport?: LogTransport;
  /** Overrides the WebSocket constructor (tests, non-browser runtimes). */
  socketFactory?: (url: string) => StreamSocketLike;
  /** Records buffered before the oldest are dropped. Default 2000. */
  maxQueueSize?: number;
  /** Records per outgoing batch. Default 120. */
  batchSize?: number;
  /** Idle flush cadence in ms. Default 2500. */
  flushIntervalMillis?: number;
  /**
   * Abandons a connection attempt after this many ms. Default 8000. Without it
   * a socket wedged in CONNECTING (captive portal, silently dropped SYN) would
   * stall the flush loop forever and the queue would never drain.
   */
  connectTimeoutMillis?: number;
  /** Flush delay for urgent levels in ms. Default 250. */
  urgentFlushDelayMillis?: number;
  /** Levels that trigger the urgent (fast) flush. Default ERROR and FATAL. */
  urgentLevels?: readonly string[];
  /** Wraps a batch before it goes on the wire. Default {type:'log-batch',records}. */
  mapBatch?: (records: readonly LogRecord[]) => string;
  /** Endpoint for the pagehide sendBeacon flush. Without it, no beacon is sent. */
  beaconUrl?: string;
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
  /** Attach pagehide/visibilitychange flush handlers. Default true. */
  flushOnPageHide?: boolean;
  onError?: (error: unknown) => void;
}

const DEFAULT_URGENT_LEVELS = ['ERROR', 'FATAL'] as const;

/**
 * FIFO queue with a head cursor: shift() advances a pointer instead of
 * re-indexing the whole array, so draining a deep queue stays O(1) amortized
 * rather than O(n) per record on the main thread.
 */
class CursorQueue<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  peek(count: number): T[] {
    return this.items.slice(this.head, this.head + count);
  }

  drain(count: number): void {
    const next = Math.min(this.head + count, this.items.length);
    for (let index = this.head; index < next; index += 1) {
      this.items[index] = undefined as unknown as T;
    }
    this.head = next;
    this.compact();
  }

  trimToLast(max: number): number {
    const excess = this.length - max;
    if (excess <= 0) {
      return 0;
    }
    this.drain(excess);
    return excess;
  }

  toArray(): T[] {
    return this.items.slice(this.head);
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }

  /** Reclaim the consumed prefix once it dominates the backing array. */
  private compact(): void {
    if (this.head > 512 && this.head > this.items.length / 2) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}

export class BrowserStreamTransport implements LogTransport {
  readonly name = 'browser-stream';

  private readonly queue = new CursorQueue<LogRecord>();
  private readonly options: Readonly<BrowserStreamOptions>;
  private readonly urgentLevels: ReadonlySet<string>;

  private socket: StreamSocketLike | null = null;
  private connectPromise: Promise<StreamSocketLike> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight = false;
  private closed = false;
  private droppedRecords = 0;
  private removePageHideHandlers: (() => void) | null = null;

  constructor(options: BrowserStreamOptions) {
    if (!options.url && !options.transport) {
      throw new TypeError('BrowserStreamTransport requires either url or transport');
    }
    this.options = options;
    this.urgentLevels = new Set(options.urgentLevels ?? DEFAULT_URGENT_LEVELS);
    if (options.flushOnPageHide !== false) {
      this.installPageHideHandlers();
    }
  }

  /** Records dropped because the queue was full — surfaces silent log loss. */
  get dropped(): number {
    return this.droppedRecords;
  }

  get queued(): number {
    return this.queue.length;
  }

  write(record: LogRecord): void {
    if (this.closed) {
      return;
    }
    this.queue.push(record);
    const maximumQueueSize = Math.max(
      0,
      Math.floor(this.options.maxQueueSize ?? 2_000),
    );
    this.droppedRecords += this.queue.trimToLast(maximumQueueSize);
    this.schedule(this.urgentLevels.has(record.level));
  }

  private schedule(urgent: boolean): void {
    if (this.queue.length === 0 || this.flushInFlight || this.closed) {
      return;
    }
    const delay = urgent
      ? (this.options.urgentFlushDelayMillis ?? 250)
      : (this.options.flushIntervalMillis ?? 2_500);
    if (this.flushTimer) {
      // A pending idle flush is pre-empted by an urgent one, never the reverse.
      if (!urgent) {
        return;
      }
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) => this.options.onError?.(error));
    }, delay);
  }

  private connect(): Promise<StreamSocketLike> {
    if (this.socket && this.socket.readyState === 1) {
      return Promise.resolve(this.socket);
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const url = this.options.url;
    if (!url) {
      return Promise.reject(new Error('BrowserStreamTransport has no url to connect to'));
    }

    const factory =
      this.options.socketFactory ??
      ((target: string): StreamSocketLike => {
        const Ctor = (globalThis as { WebSocket?: new (value: string) => StreamSocketLike })
          .WebSocket;
        if (!Ctor) {
          throw new Error('No WebSocket implementation available; pass socketFactory');
        }
        return new Ctor(target);
      });

    this.connectPromise = new Promise<StreamSocketLike>((resolve, reject) => {
      let socket: StreamSocketLike;
      try {
        socket = factory(url);
      } catch (error) {
        this.connectPromise = null;
        reject(error);
        return;
      }
      this.socket = socket;
      let settled = false;

      const timeout = setTimeout(() => {
        finish(new Error('Log stream WebSocket connection timed out'));
      }, this.options.connectTimeoutMillis ?? 8_000);

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.connectPromise = null;
        if (error) {
          this.socket = null;
          try {
            socket.close(1011, 'log stream connect failed');
          } catch {
            // The socket may already be closing; nothing further to do.
          }
          reject(error);
        } else {
          resolve(socket);
        }
      };

      socket.onopen = () => finish();
      socket.onerror = () => finish(new Error('Log stream WebSocket failed to open'));
      socket.onclose = () => {
        // Queued records stay queued; the next flush reconnects and replays.
        this.socket = null;
        finish(new Error('Log stream WebSocket closed before opening'));
      };
    });

    return this.connectPromise;
  }

  private encode(records: readonly LogRecord[]): string {
    return this.options.mapBatch?.(records) ?? JSON.stringify({ type: 'log-batch', records });
  }

  /**
   * Drains the queue in batches. Records are removed only after the send
   * succeeds, so a mid-drain failure leaves the remainder queued for the next
   * attempt rather than dropping it.
   */
  async flush(): Promise<void> {
    if (this.flushInFlight || this.queue.length === 0 || this.closed) {
      return;
    }
    this.flushInFlight = true;
    try {
      const batchSize = Math.max(
        1,
        Math.floor(this.options.batchSize ?? 120),
      );
      while (this.queue.length > 0) {
        const batch = this.queue.peek(batchSize);
        if (batch.length === 0) {
          break;
        }
        if (this.options.transport) {
          for (const record of batch) {
            await this.options.transport.write(record);
          }
        } else {
          const socket = await this.connect();
          socket.send(this.encode(batch));
        }
        this.queue.drain(batch.length);
        if (this.queue.length > 0) {
          // Yield so a long drain does not monopolise the main thread.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      this.flushInFlight = false;
      if (this.queue.length > 0) {
        this.schedule(false);
      }
    }
  }

  /**
   * Page teardown: async sends are unreliable here, so the queue goes out via
   * sendBeacon when a beaconUrl is configured. Without one there is nothing
   * reliable to do, and the records are dropped rather than silently retried.
   */
  flushOnExit(records: readonly LogRecord[]): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const pending = [...this.queue.toArray(), ...records];
    if (pending.length === 0) {
      return;
    }
    const beacon =
      this.options.sendBeacon ??
      (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : undefined);
    const beaconUrl = this.options.beaconUrl;
    if (!beacon || !beaconUrl) {
      return;
    }
    try {
      beacon(beaconUrl, this.encode(pending));
      this.queue.clear();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private installPageHideHandlers(): void {
    if (this.removePageHideHandlers || typeof globalThis.addEventListener !== 'function') {
      return;
    }
    const onPageHide = (): void => {
      this.flushOnExit([]);
    };
    const onVisibilityChange = (): void => {
      // 'hidden' is the last reliable point on mobile Safari, which often
      // never fires pagehide before discarding the tab.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.flushOnExit([]);
      }
    };
    globalThis.addEventListener('pagehide', onPageHide);
    globalThis.addEventListener('visibilitychange', onVisibilityChange);
    this.removePageHideHandlers = () => {
      globalThis.removeEventListener('pagehide', onPageHide);
      globalThis.removeEventListener('visibilitychange', onVisibilityChange);
      this.removePageHideHandlers = null;
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.flush();
    } catch (error) {
      this.options.onError?.(error);
    }
    this.closed = true;
    this.removePageHideHandlers?.();
    this.socket?.close(1000, 'next-loggers stream closed');
    this.socket = null;
    await this.options.transport?.close?.();
  }
}

export function createBrowserStreamTransport(
  options: BrowserStreamOptions,
): BrowserStreamTransport {
  return new BrowserStreamTransport(options);
}
