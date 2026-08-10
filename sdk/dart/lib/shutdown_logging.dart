import 'next_loggers.dart';
import 'shutdown.dart';

/// Backward-compatible name for the canonical best-effort logger adapter.
void Function(ShutdownEvent) loggerShutdownObserver(Logger logger) =>
    loggerShutdownLog(logger);

/// Builds a flush hook accepted by [ProcessShutdownOptions].
Future<void> Function(ShutdownCause) loggerShutdownFlush(Logger logger) =>
    (_) => logger.flush();
