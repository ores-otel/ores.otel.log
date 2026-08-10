import {
  ShutdownCoordinator,
  type ShutdownCoordinatorOptions,
  type ShutdownEvent,
  type ShutdownResult,
  type ShutdownTrigger,
} from './shutdown.js';

export interface NodeHttpServerLike {
  close(callback?: (error?: unknown) => void): unknown;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
}

export interface NodeSignalSourceLike {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off?(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener?(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  stdin?: {
    readonly isTTY?: boolean;
    on(event: 'end', listener: () => void): unknown;
    off?(event: 'end', listener: () => void): unknown;
    removeListener?(event: 'end', listener: () => void): unknown;
    resume?(): void;
  };
}

export interface InstallNodeShutdownSignalsOptions {
  readonly source?: NodeSignalSourceLike;
  readonly interactive?: boolean;
  readonly listenForStdinEof?: boolean;
}

export interface NodeHttpShutdownOptions {
  readonly servers: NodeHttpServerLike | readonly NodeHttpServerLike[];
  readonly gracePeriodMillis?: number;
  readonly flush?: ShutdownCoordinatorOptions['flush'];
  readonly onEvent?: (event: ShutdownEvent) => void | Promise<void>;
  /** Force-close WebSockets, HTTP/2 sessions, queues, or other upgraded work. */
  readonly forceCloseUpgrades?: () => void | Promise<void>;
  readonly signalSource?: NodeSignalSourceLike;
  readonly interactive?: boolean;
  readonly listenForStdinEof?: boolean;
  readonly installSignalHandlers?: boolean;
}

export interface NodeShutdownHandle {
  readonly coordinator: ShutdownCoordinator;
  request(trigger?: ShutdownTrigger, force?: boolean): Promise<ShutdownResult>;
  dispose(): void;
  wait(): Promise<ShutdownResult>;
}

function defaultSignalSource(): NodeSignalSourceLike {
  const source = (globalThis as { process?: NodeSignalSourceLike }).process;
  if (!source) {
    throw new Error('Node.js process signal source is unavailable');
  }
  return source;
}

function removeListener(
  target: NodeSignalSourceLike,
  event: 'SIGINT' | 'SIGTERM',
  listener: () => void,
): void {
  if (target.off) {
    target.off(event, listener);
  } else {
    target.removeListener?.(event, listener);
  }
}

function removeStdinListener(
  stdin: NonNullable<NodeSignalSourceLike['stdin']>,
  listener: () => void,
): void {
  if (stdin.off) {
    stdin.off('end', listener);
  } else {
    stdin.removeListener?.('end', listener);
  }
}

/**
 * Installs SIGINT/SIGTERM handling. In a TTY the first signal drains and the
 * second signal — or Ctrl-D/stdin EOF — forces. In non-TTY environments one
 * signal is sufficient to start shutdown; the grace timeout handles escalation.
 */
export function installNodeShutdownSignals(
  coordinator: ShutdownCoordinator,
  options: InstallNodeShutdownSignalsOptions = {},
): () => void {
  const source = options.source ?? defaultSignalSource();
  const interactive = options.interactive ?? Boolean(source.stdin?.isTTY);

  const request = (trigger: ShutdownTrigger): void => {
    const force = coordinator.phase === 'draining';
    void coordinator.request(trigger, { force, interactive });
  };
  const onSigint = (): void => request('SIGINT');
  const onSigterm = (): void => request('SIGTERM');
  const onStdinEnd = (): void => request('stdin-eof');

  source.on('SIGINT', onSigint);
  source.on('SIGTERM', onSigterm);

  const stdin = source.stdin;
  const listenForStdinEof = options.listenForStdinEof ?? true;
  if (interactive && listenForStdinEof && stdin) {
    stdin.on('end', onStdinEnd);
    stdin.resume?.();
  }

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    removeListener(source, 'SIGINT', onSigint);
    removeListener(source, 'SIGTERM', onSigterm);
    if (interactive && listenForStdinEof && stdin) {
      removeStdinListener(stdin, onStdinEnd);
    }
  };
}

function closeServer(server: NodeHttpServerLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    try {
      server.close(done);
      // Node 18 needs this for keep-alive parity with Node 19+.
      server.closeIdleConnections?.();
    } catch (error) {
      done(error);
    }
  });
}

/**
 * Creates a two-phase controller for one or more Node HTTP(S) servers.
 * `server.close()` is the drain path; `closeAllConnections()` is force-only.
 */
export function createNodeHttpShutdown(options: NodeHttpShutdownOptions): NodeShutdownHandle {
  const servers = Array.isArray(options.servers) ? [...options.servers] : [options.servers];
  if (servers.length === 0) {
    throw new TypeError('at least one HTTP server is required');
  }

  const coordinatorOptions: ShutdownCoordinatorOptions = {
    drain: async () => {
      await Promise.all(servers.map(closeServer));
    },
    force: async () => {
      // close() must be called before closeAllConnections() to avoid an accept race.
      for (const server of servers) {
        try {
          server.close(() => undefined);
        } catch {
          // It may already be closing; force must remain best-effort/idempotent.
        }
        server.closeAllConnections?.();
      }
      await options.forceCloseUpgrades?.();
    },
    ...(options.gracePeriodMillis === undefined
      ? {}
      : { gracePeriodMillis: options.gracePeriodMillis }),
    ...(options.flush === undefined ? {} : { flush: options.flush }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  };

  const coordinator = new ShutdownCoordinator(coordinatorOptions);
  let disposeSignals = (): void => undefined;
  if (options.installSignalHandlers ?? true) {
    const signalOptions: InstallNodeShutdownSignalsOptions = {
      ...(options.signalSource === undefined ? {} : { source: options.signalSource }),
      ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
      ...(options.listenForStdinEof === undefined
        ? {}
        : { listenForStdinEof: options.listenForStdinEof }),
    };
    disposeSignals = installNodeShutdownSignals(coordinator, signalOptions);
  }

  return {
    coordinator,
    request: (trigger = 'programmatic', force = false) =>
      coordinator.request(trigger, {
        force,
        interactive: options.interactive ?? Boolean(options.signalSource?.stdin?.isTTY),
      }),
    dispose: disposeSignals,
    wait: () => coordinator.wait(),
  };
}
