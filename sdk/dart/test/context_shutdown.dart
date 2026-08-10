import 'dart:async';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';

Future<void> main() async {
  final transport = MemoryTransport();
  final logger = Logger(
    appName: 'context-test',
    transports: <LogTransport>[transport],
  );

  final user = <String, Object?>{'id': 'user-1'};
  final record = await withLogContext(
    LogContext(
      loggedInUser: user,
      traceId: 'trace-1',
      traceIds: const <String>['trace-1', 'trace-2'],
      spanId: 'span-1',
      routineId: 'handler',
      fields: const <String, Object?>{'request.id': 'req-1'},
    ),
    () async {
      user['id'] = 'mutated';
      assert(setContextLoggedInUser(const <String, Object?>{'role': 'admin'}));
      await Future<void>.delayed(Duration.zero);
      return (await logger.info('hello').send())!.toJson();
    },
  );

  assert((record['loggedInUser']! as Map)['id'] == 'user-1');
  assert((record['loggedInUser']! as Map)['role'] == 'admin');
  assert((record['fields']! as Map)['otel.span_id'] == 'span-1');
  assert(record['routineId'] == 'handler');
  assert((record['traceIds']! as List).length == 2);
  assert(currentLogContext() == null);

  await withLogContext(
    const LogContext(traceFlags: 1),
    () => withLogContext(const LogContext(traceFlags: 0), () {
      assert(currentLogContext()?.traceFlags == 0);
    }),
  );

  final traces = await Future.wait(<Future<String>>[
    Future<String>(
      () => withLogContext(const LogContext(traceId: 'a'), () async {
        await Future<void>.delayed(Duration.zero);
        return (await logger.info('a').send())!.traceId;
      }),
    ),
    Future<String>(
      () => withLogContext(const LogContext(traceId: 'b'), () async {
        await Future<void>.delayed(Duration.zero);
        return (await logger.info('b').send())!.traceId;
      }),
    ),
  ]);
  assert(traces[0] == 'a' && traces[1] == 'b');

  final signalEvents = StreamController<ShutdownCause>();
  final eofEvents = StreamController<void>();
  final graceful = Completer<void>();
  final flushStarted = Completer<void>();
  final flushRelease = Completer<void>();
  var forced = 0;
  var flushCalls = 0;
  final shutdown = installProcessShutdown(
    ProcessShutdownOptions(
      interactive: true,
      events: signalEvents.stream,
      stdinEofEvents: eofEvents.stream,
      timeout: const Duration(seconds: 5),
      forceTimeout: const Duration(seconds: 1),
      graceful: (_) => graceful.future,
      force: (_) {
        forced += 1;
      },
      flush: (_) async {
        flushCalls += 1;
        if (!flushStarted.isCompleted) flushStarted.complete();
        await flushRelease.future;
      },
    ),
  );

  signalEvents.add(ShutdownCause.sigint);
  await Future<void>.delayed(Duration.zero);
  assert(shutdown.phase == ShutdownPhase.draining);
  graceful.complete();
  await flushStarted.future;
  eofEvents.add(null);
  await Future<void>.delayed(Duration.zero);
  assert(forced == 1);
  assert(flushCalls == 1);
  flushRelease.complete();
  final result = await shutdown.done;
  assert(result.phase == ShutdownPhase.forced);
  assert(result.cause == ShutdownCause.stdinEof);
  assert(forced == 1);
  assert(flushCalls == 1);

  await signalEvents.close();
  await eofEvents.close();

  final blockedSignals = StreamController<ShutdownCause>();
  final blocked = Completer<void>();
  final bounded = installProcessShutdown(
    ProcessShutdownOptions(
      interactive: true,
      events: blockedSignals.stream,
      watchStdinEof: false,
      timeout: const Duration(seconds: 1),
      forceTimeout: const Duration(milliseconds: 5),
      graceful: (_) => blocked.future,
      force: (_) => blocked.future,
      flush: (_) => blocked.future,
    ),
  );
  blockedSignals.add(ShutdownCause.sigint);
  await Future<void>.delayed(Duration.zero);
  blockedSignals.add(ShutdownCause.sigint);
  final boundedResult = await bounded.done;
  assert(boundedResult.phase == ShutdownPhase.forced);
  assert(boundedResult.errors.length == 2);
  await blockedSignals.close();

  await logger.close();
  assert(transport.closed);
  print('Dart context and shutdown conformance passed');
}
