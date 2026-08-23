import 'dart:async';
import 'dart:io';

import 'next_loggers.dart';

enum ShutdownCause { sigint, sigterm, stdinEof, timeout, programmatic }

enum ShutdownPhase { running, draining, forced, closed }

enum ShutdownAction { beginGraceful, force, close, ignore }

enum ShutdownStateEvent { trigger, forceNow, markClosed }

class ShutdownTransition {
  const ShutdownTransition({required this.phase, required this.action});

  final ShutdownPhase phase;
  final ShutdownAction action;
}

ShutdownTransition transitionShutdownState(
  ShutdownPhase phase,
  ShutdownStateEvent event,
) =>
    switch ((phase, event)) {
      (ShutdownPhase.running, ShutdownStateEvent.trigger) =>
        const ShutdownTransition(
          phase: ShutdownPhase.draining,
          action: ShutdownAction.beginGraceful,
        ),
      (ShutdownPhase.draining, ShutdownStateEvent.trigger) =>
        const ShutdownTransition(
          phase: ShutdownPhase.forced,
          action: ShutdownAction.force,
        ),
      (
        ShutdownPhase.running || ShutdownPhase.draining,
        ShutdownStateEvent.forceNow,
      ) =>
        const ShutdownTransition(
          phase: ShutdownPhase.forced,
          action: ShutdownAction.force,
        ),
      (ShutdownPhase.draining, ShutdownStateEvent.markClosed) =>
        const ShutdownTransition(
          phase: ShutdownPhase.closed,
          action: ShutdownAction.close,
        ),
      _ => ShutdownTransition(phase: phase, action: ShutdownAction.ignore),
    };

class ShutdownStateMachine {
  ShutdownStateMachine({required this.interactive});

  final bool interactive;
  ShutdownPhase phase = ShutdownPhase.running;
  int signalCount = 0;

  ShutdownAction trigger(ShutdownCause cause) {
    signalCount += 1;
    return _apply(ShutdownStateEvent.trigger);
  }

  ShutdownAction forceNow() => _apply(ShutdownStateEvent.forceNow);

  bool markClosed() {
    return _apply(ShutdownStateEvent.markClosed) == ShutdownAction.close;
  }

  ShutdownAction timeout() => forceNow();

  ShutdownAction _apply(ShutdownStateEvent event) {
    final transition = transitionShutdownState(phase, event);
    phase = transition.phase;
    return transition.action;
  }
}

class ShutdownEvent {
  const ShutdownEvent({
    required this.phase,
    required this.action,
    required this.cause,
    required this.interactive,
    required this.signalCount,
    required this.message,
    this.error,
  });

  final ShutdownPhase phase;
  final ShutdownAction action;
  final ShutdownCause cause;
  final bool interactive;
  final int signalCount;
  final String message;
  final Object? error;
}

class ShutdownResult {
  const ShutdownResult({
    required this.phase,
    required this.cause,
    required this.startedAt,
    required this.finishedAt,
    required this.errors,
  });

  final ShutdownPhase phase;
  final ShutdownCause cause;
  final DateTime startedAt;
  final DateTime finishedAt;
  final List<Object> errors;
}

class ProcessShutdownOptions {
  const ProcessShutdownOptions({
    required this.graceful,
    required this.force,
    this.flush,
    this.timeout = const Duration(seconds: 15),
    this.forceTimeout = const Duration(seconds: 5),
    this.interactive,
    this.watchStdinEof = true,
    this.events,
    this.stdinEofEvents,
    this.onLog,
    this.clock,
  });

  /// Withdraw readiness, stop accepting new work, and await active work.
  final FutureOr<void> Function(ShutdownCause cause) graceful;

  /// Close active sockets/tasks that survived the bounded graceful drain.
  final FutureOr<void> Function(ShutdownCause cause) force;

  /// Flush logs and telemetry exactly once across graceful/force races.
  final FutureOr<void> Function(ShutdownCause cause)? flush;
  final Duration timeout;
  final Duration forceTimeout;
  final bool? interactive;

  /// Watching stdin consumes it. Disable when the application already owns it.
  final bool watchStdinEof;

  /// Injectable event streams for tests and embedding.
  final Stream<ShutdownCause>? events;
  final Stream<void>? stdinEofEvents;
  final void Function(ShutdownEvent event)? onLog;
  final DateTime Function()? clock;
}

class ProcessShutdownController {
  ProcessShutdownController._(this._options, this._interactive)
      : state = ShutdownStateMachine(interactive: _interactive),
        _clock = _options.clock ?? DateTime.now;

  final ProcessShutdownOptions _options;
  final bool _interactive;
  final DateTime Function() _clock;
  final ShutdownStateMachine state;
  final Completer<ShutdownResult> _done = Completer<ShutdownResult>();
  final List<Object> _errors = <Object>[];
  final List<StreamSubscription<dynamic>> _subscriptions =
      <StreamSubscription<dynamic>>[];
  Timer? _timer;
  DateTime? _startedAt;
  Future<void>? _flushFuture;
  bool _forceStarted = false;
  bool _disposed = false;

  Future<ShutdownResult> get done => _done.future;
  ShutdownPhase get phase => state.phase;

  void _log(
    ShutdownPhase phase,
    ShutdownAction action,
    ShutdownCause cause,
    String message, [
    Object? error,
  ]) {
    try {
      _options.onLog?.call(
        ShutdownEvent(
          phase: phase,
          action: action,
          cause: cause,
          interactive: _interactive,
          signalCount: state.signalCount,
          message: message,
          error: error,
        ),
      );
    } catch (_) {
      // Logging must never block shutdown.
    }
  }

  Future<bool> _capture(
    String operation,
    ShutdownCause cause,
    FutureOr<void> Function()? callback,
  ) async {
    if (callback == null) return true;
    try {
      await callback();
      return true;
    } catch (error) {
      _errors.add(error);
      _log(
        state.phase,
        ShutdownAction.ignore,
        cause,
        '$operation failed; shutdown continues',
        error,
      );
      return false;
    }
  }

  Future<void> _flushOnce(ShutdownCause cause) {
    return _flushFuture ??= () async {
      await _capture(
        'telemetry flush',
        cause,
        _options.flush == null ? null : () => _options.flush!(cause),
      );
    }();
  }

  Future<void> _waitBounded(
    String operation,
    ShutdownCause cause,
    Future<void> future,
  ) async {
    try {
      await future.timeout(_options.forceTimeout);
    } on TimeoutException catch (error) {
      _errors.add(error);
      _log(
        state.phase,
        ShutdownAction.ignore,
        cause,
        '$operation did not finish before the force deadline',
        error,
      );
    }
  }

  void trigger(ShutdownCause cause) {
    final action = state.trigger(cause);
    if (action == ShutdownAction.beginGraceful) {
      _startGraceful(cause);
    } else if (action == ShutdownAction.force) {
      _startForce(cause);
    }
  }

  void requestGraceful([ShutdownCause cause = ShutdownCause.programmatic]) {
    trigger(cause);
  }

  void force([ShutdownCause cause = ShutdownCause.programmatic]) {
    if (state.forceNow() == ShutdownAction.force) {
      _startForce(cause);
    }
  }

  void _startGraceful(ShutdownCause cause) {
    _startedAt ??= _clock();
    _log(
      ShutdownPhase.draining,
      ShutdownAction.beginGraceful,
      cause,
      _interactive
          ? 'graceful shutdown started; press Ctrl-C again or Ctrl-D to force'
          : 'graceful shutdown started',
    );
    _timer = Timer(_options.timeout, () {
      if (state.timeout() == ShutdownAction.force) {
        _startForce(ShutdownCause.timeout);
      }
    });

    unawaited(() async {
      final gracefulSucceeded = await _capture(
        'graceful shutdown',
        cause,
        () => _options.graceful(cause),
      );
      if (!gracefulSucceeded && state.forceNow() == ShutdownAction.force) {
        _startForce(cause);
        return;
      }
      if (state.phase != ShutdownPhase.draining) {
        return;
      }
      await _flushOnce(cause);
      if (state.markClosed()) {
        _finish(ShutdownPhase.closed, cause);
      }
    }());
  }

  void _startForce(ShutdownCause cause) {
    if (_forceStarted) return;
    _forceStarted = true;
    _startedAt ??= _clock();
    _timer?.cancel();
    _log(
      ShutdownPhase.forced,
      ShutdownAction.force,
      cause,
      'forcing active connections and application resources closed',
    );
    unawaited(() async {
      await _waitBounded(
        'force shutdown',
        cause,
        _capture('force shutdown', cause, () => _options.force(cause)),
      );
      await _waitBounded('telemetry flush', cause, _flushOnce(cause));
      _finish(ShutdownPhase.forced, cause);
    }());
  }

  void _finish(ShutdownPhase phase, ShutdownCause cause) {
    if (_done.isCompleted) return;
    _timer?.cancel();
    dispose();
    _log(
      phase,
      ShutdownAction.ignore,
      cause,
      phase == ShutdownPhase.closed
          ? 'graceful shutdown completed'
          : 'forceful shutdown completed',
    );
    _done.complete(
      ShutdownResult(
        phase: phase,
        cause: cause,
        startedAt: _startedAt ?? _clock(),
        finishedAt: _clock(),
        errors: List<Object>.unmodifiable(_errors),
      ),
    );
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _timer?.cancel();
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _subscriptions.clear();
  }

  void _listen(Stream<dynamic> stream, void Function(dynamic) callback) {
    _subscriptions.add(stream.listen(callback));
  }
}

/// Best-effort structured shutdown logging through the Dart next-loggers SDK.
void Function(ShutdownEvent) loggerShutdownLog(Logger logger) {
  return (event) {
    unawaited(() async {
      try {
        final fields = <String, Object?>{
          'shutdown.phase': event.phase.name,
          'shutdown.action': event.action.name,
          'shutdown.cause': event.cause.name,
          'shutdown.interactive': event.interactive,
          'shutdown.signal_count': event.signalCount,
        };
        if (event.error != null) {
          await logger
              .error(event.message, <Object?>[event.error])
              .addFields(fields)
              .send();
        } else if (event.phase == ShutdownPhase.forced) {
          await logger.warn(event.message).addFields(fields).send();
        } else {
          await logger.info(event.message).addFields(fields).send();
        }
      } catch (_) {
        // Best-effort observability must not interfere with termination.
      }
    }());
  };
}

ProcessShutdownController installProcessShutdown(
  ProcessShutdownOptions options,
) {
  final interactive = options.interactive ?? stdin.hasTerminal;
  final controller = ProcessShutdownController._(options, interactive);

  if (options.events != null) {
    controller._listen(
      options.events!,
      (value) => controller.trigger(value as ShutdownCause),
    );
  } else {
    controller._listen(
      ProcessSignal.sigint.watch(),
      (_) => controller.trigger(ShutdownCause.sigint),
    );
    try {
      controller._listen(
        ProcessSignal.sigterm.watch(),
        (_) => controller.trigger(ShutdownCause.sigterm),
      );
    } catch (_) {
      // SIGTERM is not available on every Dart platform (notably Windows).
    }
  }

  if (options.stdinEofEvents != null) {
    controller._listen(
      options.stdinEofEvents!,
      (_) => controller.trigger(ShutdownCause.stdinEof),
    );
  } else if (interactive && options.watchStdinEof) {
    controller._subscriptions.add(
      stdin.cast<Object?>().listen(
            (_) {},
            onDone: () => controller.trigger(ShutdownCause.stdinEof),
          ),
    );
  }

  return controller;
}
