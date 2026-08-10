import 'dart:async';

enum ShutdownPhase { running, draining, forcing, stopped }

final class ShutdownTrigger {
  const ShutdownTrigger(this.name);
  final String name;

  static const sigint = ShutdownTrigger('SIGINT');
  static const sigterm = ShutdownTrigger('SIGTERM');
  static const stdinEof = ShutdownTrigger('stdin-eof');
  static const timeout = ShutdownTrigger('timeout');
  static const programmatic = ShutdownTrigger('programmatic');
  static const serverError = ShutdownTrigger('server-error');
  static const drainError = ShutdownTrigger('drain-error');

  @override
  String toString() => name;
}

final class ShutdownActionContext {
  const ShutdownActionContext({
    required this.trigger,
    required this.interactive,
    required this.attempt,
    required this.elapsed,
  });

  final ShutdownTrigger trigger;
  final bool interactive;
  final int attempt;
  final Duration elapsed;
}

final class ShutdownEvent {
  const ShutdownEvent({
    required this.phase,
    required this.previousPhase,
    required this.trigger,
    required this.interactive,
    required this.attempt,
    required this.elapsed,
    required this.message,
    this.error,
  });

  final ShutdownPhase phase;
  final ShutdownPhase previousPhase;
  final ShutdownTrigger trigger;
  final bool interactive;
  final int attempt;
  final Duration elapsed;
  final String message;
  final Object? error;

  Map<String, Object?> toFields() => <String, Object?>{
    'shutdown.phase': phase.name,
    'shutdown.previous_phase': previousPhase.name,
    'shutdown.trigger': trigger.name,
    'shutdown.interactive': interactive,
    'shutdown.attempt': attempt,
    'shutdown.elapsed_ms': elapsed.inMilliseconds,
    if (error != null) 'shutdown.error': error.toString(),
  };
}

final class ShutdownResult {
  const ShutdownResult({
    required this.forced,
    required this.triggers,
    required this.errors,
    required this.elapsed,
  });

  final bool forced;
  final List<ShutdownTrigger> triggers;
  final List<Object> errors;
  final Duration elapsed;
}

typedef ShutdownAction = FutureOr<void> Function(ShutdownActionContext context);
typedef ShutdownObserver = FutureOr<void> Function(ShutdownEvent event);

final class ShutdownCoordinator {
  ShutdownCoordinator({
    required ShutdownAction drain,
    required ShutdownAction force,
    ShutdownAction? flush,
    ShutdownObserver? onEvent,
    this.gracePeriod = const Duration(seconds: 30),
  }) : _drain = drain,
       _force = force,
       _flush = flush,
       _onEvent = onEvent {
    if (gracePeriod.isNegative) {
      throw ArgumentError.value(
        gracePeriod,
        'gracePeriod',
        'must be non-negative',
      );
    }
  }

  final ShutdownAction _drain;
  final ShutdownAction _force;
  final ShutdownAction? _flush;
  final ShutdownObserver? _onEvent;
  final Duration gracePeriod;
  final Stopwatch _watch = Stopwatch()..start();
  final Completer<ShutdownResult> _completion = Completer<ShutdownResult>();
  final List<ShutdownTrigger> _triggers = <ShutdownTrigger>[];
  final List<Object> _errors = <Object>[];
  final List<Future<void>> _observerTasks = <Future<void>>[];

  ShutdownPhase _phase = ShutdownPhase.running;
  int _attempt = 0;
  bool _forced = false;
  Timer? _timer;

  ShutdownPhase get phase => _phase;
  int get attempt => _attempt;
  Future<ShutdownResult> get done => _completion.future;

  Future<ShutdownResult> request(
    ShutdownTrigger trigger, {
    bool force = false,
    bool interactive = false,
  }) {
    if (_completion.isCompleted) return done;
    _attempt += 1;
    _triggers.add(trigger);
    if (_phase == ShutdownPhase.running && !force) {
      _beginDrain(trigger, interactive);
    } else if (_phase == ShutdownPhase.draining || force) {
      _beginForce(trigger, interactive);
    }
    return done;
  }

  ShutdownActionContext _context(ShutdownTrigger trigger, bool interactive) =>
      ShutdownActionContext(
        trigger: trigger,
        interactive: interactive,
        attempt: _attempt,
        elapsed: _watch.elapsed,
      );

  void _transition(
    ShutdownPhase next,
    ShutdownTrigger trigger,
    bool interactive, [
    Object? error,
  ]) {
    final previous = _phase;
    _phase = next;
    final message = switch (next) {
      ShutdownPhase.draining =>
        'graceful shutdown started; no new work will be accepted',
      ShutdownPhase.forcing =>
        'forced shutdown started; remaining work will be terminated',
      ShutdownPhase.stopped => 'shutdown complete',
      ShutdownPhase.running => 'shutdown coordinator running',
    };
    try {
      final observed = _onEvent?.call(
        ShutdownEvent(
          phase: next,
          previousPhase: previous,
          trigger: trigger,
          interactive: interactive,
          attempt: _attempt,
          elapsed: _watch.elapsed,
          message: message,
          error: error,
        ),
      );
      if (observed is Future<void>) {
        _observerTasks.add(observed.catchError((Object _) {}));
      }
    } catch (_) {
      // A logger/observer failure must not stop shutdown.
    }
  }

  void _beginDrain(ShutdownTrigger trigger, bool interactive) {
    if (_phase != ShutdownPhase.running) return;
    _transition(ShutdownPhase.draining, trigger, interactive);
    _timer = Timer(
      gracePeriod,
      () => request(ShutdownTrigger.timeout, force: true),
    );
    Future<void>.sync(() => _drain(_context(trigger, interactive))).then(
      (_) {
        if (_phase == ShutdownPhase.draining) {
          unawaited(_finish(trigger, interactive, forced: false));
        }
      },
      onError: (Object error, StackTrace _) {
        _errors.add(error);
        if (_phase == ShutdownPhase.draining) {
          _transition(
            ShutdownPhase.draining,
            ShutdownTrigger.drainError,
            interactive,
            error,
          );
          _beginForce(ShutdownTrigger.drainError, interactive);
        }
      },
    );
  }

  void _beginForce(ShutdownTrigger trigger, bool interactive) {
    if (_phase == ShutdownPhase.forcing || _phase == ShutdownPhase.stopped)
      return;
    _forced = true;
    _timer?.cancel();
    _transition(ShutdownPhase.forcing, trigger, interactive);
    Future<void>.sync(() => _force(_context(trigger, interactive))).then(
      (_) => _finish(trigger, interactive, forced: true),
      onError: (Object error, StackTrace _) {
        _errors.add(error);
        _transition(ShutdownPhase.forcing, trigger, interactive, error);
        return _finish(trigger, interactive, forced: true);
      },
    );
  }

  Future<void> _finish(
    ShutdownTrigger trigger,
    bool interactive, {
    required bool forced,
  }) async {
    if (_completion.isCompleted) return;
    if (!forced && _phase != ShutdownPhase.draining) return;
    if (forced && _phase != ShutdownPhase.forcing) return;
    _timer?.cancel();
    if (_completion.isCompleted) return;
    _transition(ShutdownPhase.stopped, trigger, interactive);
    await Future.wait<void>(List<Future<void>>.from(_observerTasks));
    try {
      await _flush?.call(_context(trigger, interactive));
    } catch (error) {
      _errors.add(error);
    }
    if (_completion.isCompleted) return;
    _completion.complete(
      ShutdownResult(
        forced: _forced,
        triggers: List<ShutdownTrigger>.unmodifiable(_triggers),
        errors: List<Object>.unmodifiable(_errors),
        elapsed: _watch.elapsed,
      ),
    );
  }
}
