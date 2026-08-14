import 'dart:async';

import 'package:oresoftware_next_loggers/next_loggers.dart';
import 'package:test/test.dart';

void main() {
  group('Zone context', () {
    test('nested contexts restore the parent after async work', () async {
      expect(currentLogContext(), isNull);
      const parent = LogContext(traceId: 'parent', spanId: 'span-parent');
      const child = LogContext(traceId: 'child', spanId: 'span-child');

      await runWithLogContext(parent, () async {
        expect(currentLogContext()!.traceId, 'parent');
        await runWithLogContext(child, () async {
          await Future<void>.delayed(Duration.zero);
          expect(currentLogContext()!.traceId, 'child');
        });
        expect(currentLogContext()!.traceId, 'parent');
      });

      expect(currentLogContext(), isNull);
    });

    test('context snapshots do not alias mutable caller collections', () {
      final baggage = <String, String>{'tenant': 'acme'};
      final fields = <String, Object?>{'route': '/pay'};
      final tags = <String>['request'];
      final context = LogContext(
        traceId: 'trace',
        baggage: baggage,
        fields: fields,
        tags: tags,
      ).copyWith();

      baggage['tenant'] = 'mutated';
      fields['route'] = '/mutated';
      tags[0] = 'mutated';

      expect(context.baggage, {'tenant': 'acme'});
      expect(context.fields, {'route': '/pay'});
      expect(context.tags, ['request']);
      expect(() => context.baggage['x'] = 'y', throwsUnsupportedError);
      expect(() => context.fields['x'] = true, throwsUnsupportedError);
      expect(() => context.tags.add('x'), throwsUnsupportedError);
    });

    test('100 concurrent async operations never cross-contaminate traces',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.trace,
        console: false,
        transports: [memory],
      );
      const count = 100;

      await Future.wait(
        List.generate(count, (index) {
          final trace = 'trace-${index.toString().padLeft(3, '0')}';
          final span = 'span-${index.toString().padLeft(3, '0')}';
          final message = 'message-${index.toString().padLeft(3, '0')}';
          return runWithLogContext(
            LogContext(traceId: trace, spanId: span, traceFlags: 1),
            () async {
              await Future<void>.delayed(
                Duration(microseconds: (index % 7) * 10),
              );
              await logger.info(message).send();
            },
          );
        }),
      );

      expect(memory.records, hasLength(count));
      for (final record in memory.records) {
        final suffix = record.message.substring('message-'.length);
        expect(record.traceId, 'trace-$suffix');
        expect(record.fields['otel.span_id'], 'span-$suffix');
      }
      expect(currentLogContext(), isNull);
    });

    test('explicit trace remains primary while ambient trace is retained',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(console: false, transports: [memory]);

      await runWithLogContext(
        const LogContext(traceId: 'ambient', spanId: 'ambient-span'),
        () => logger.info('inside').addTrace('explicit').send(),
      );

      final record = memory.records.single;
      expect(record.traceId, 'explicit');
      expect(record.traceIds, ['explicit', 'ambient']);
      expect(record.fields['otel.span_id'], 'ambient-span');
    });
  });

  group('logger lifecycle', () {
    test('minimum level filters records before transports', () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.warn,
        console: false,
        transports: [memory],
      );

      expect(await logger.trace('trace').send(), isNull);
      expect(await logger.debug('debug').send(), isNull);
      expect(await logger.info('info').send(), isNull);
      await logger.warn('warn').send();
      await logger.error('error').send();
      await logger.fatal('fatal').send();

      expect(
        memory.records.map((record) => record.level),
        [LogLevel.warn, LogLevel.error, LogLevel.fatal],
      );
    });

    test('send is idempotent and returns the cached immutable record',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(console: false, transports: [memory]);
      final event = logger.info('once').addFields({'value': 1});
      final firstFuture = event.send();
      final secondFuture = event.send();
      expect(identical(firstFuture, secondFuture), isTrue);
      final first = await firstFuture;
      final second = await secondFuture;
      expect(identical(first, second), isTrue);
      expect(memory.records, hasLength(1));
      expect(() => first!.fields['later'] = true, throwsUnsupportedError);
    });

    test('transport failures are aggregated after all transports receive data',
        () async {
      final memory = MemoryTransport();
      final first = _FailingTransport(StateError('first'));
      final second = _FailingTransport(ArgumentError('second'));
      final logger = Logger(
        console: false,
        transports: [first, memory, second],
      );

      await expectLater(logger.error('fanout').send(), throwsStateError);
      expect(first.writes, 1);
      expect(second.writes, 1);
      expect(memory.records.single.message, 'fanout');
    });

    test('close is idempotent and rejects new events', () async {
      final memory = MemoryTransport();
      final logger = Logger(console: false, transports: [memory]);
      await logger.info('before close').send();
      await logger.close();
      await logger.close();
      expect(() => logger.info('after close'), throwsStateError);
    });

    test('wire JSON omits empty optionals and escapes control characters',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(
        appName: 'wire',
        console: false,
        transports: [memory],
        idFactory: () => 'fixed-id',
        clock: () => DateTime.utc(2026, 1, 2, 3, 4, 5),
      );
      final record = await logger.info('quote" slash\\ newline\n tab\t').send();
      final json = record!.toJsonString();
      expect(json, contains('"schema":"next-loggers/v1"'));
      expect(json, contains('quote\\"'));
      expect(json, contains('slash\\\\'));
      expect(json, contains('newline\\n'));
      expect(json, isNot(contains('"traceId"')));
      expect(json, isNot(contains('"tags"')));
    });
  });

  group('Supabase transport', () {
    test('batches in insertion order and serializes the shared wire schema',
        () async {
      final batches = <List<JsonMap>>[];
      final transport = SupabaseTransport(
        batchSize: 3,
        flushInterval: const Duration(minutes: 1),
        sendBatch: (records) => batches.add(records),
      );
      final logger = Logger(console: false, transports: [transport]);

      await Future.wait([
        logger.info('one').send(),
        logger.warn('two').send(),
        logger.error('three').send(),
      ]);

      expect(batches, hasLength(1));
      expect(
        batches.single.map((record) => record['message']),
        ['one', 'two', 'three'],
      );
      expect(
        batches.single.every((record) => record['schema'] == schema),
        isTrue,
      );
      await transport.close();
    });

    test('timer flush sends a partial batch', () async {
      final completed = Completer<List<JsonMap>>();
      final transport = SupabaseTransport(
        batchSize: 10,
        flushInterval: const Duration(milliseconds: 2),
        sendBatch: (records) {
          if (!completed.isCompleted) completed.complete(records);
        },
      );
      final logger = Logger(console: false, transports: [transport]);
      await logger.info('partial').send();
      final batch = await completed.future.timeout(const Duration(seconds: 1));
      expect(batch.single['message'], 'partial');
      await transport.close();
    });

    test('failed batches are requeued without reordering or data loss',
        () async {
      final attempts = <List<String>>[];
      var fail = true;
      final transport = SupabaseTransport(
        batchSize: 2,
        flushInterval: const Duration(minutes: 1),
        sendBatch: (records) {
          attempts.add(
            records.map((record) => record['message']! as String).toList(),
          );
          if (fail) {
            fail = false;
            throw StateError('temporary failure');
          }
        },
      );
      final logger = Logger(console: false, transports: [transport]);

      final results = await Future.wait(
        [logger.info('one').send(), logger.info('two').send()],
        eagerError: false,
      ).then<Object?>((value) => value, onError: (Object error) => error);
      expect(results, isA<StateError>());
      await Future<void>.delayed(Duration.zero);
      expect(attempts, hasLength(1), reason: 'failures must not busy-retry');
      await transport.flush();
      expect(attempts.first, ['one', 'two']);
      expect(attempts.last, ['one', 'two']);
      await transport.close();
    });

    test(
        'bounded queue drops the oldest queued record during an in-flight send',
        () async {
      final firstGate = Completer<void>();
      final dropped = <String>[];
      final sent = <String>[];
      var calls = 0;
      final transport = SupabaseTransport(
        batchSize: 2,
        maxQueueSize: 2,
        flushInterval: const Duration(minutes: 1),
        onDrop: (record) => dropped.add(record.message),
        sendBatch: (records) async {
          calls += 1;
          if (calls == 1) await firstGate.future;
          sent.addAll(records.map((record) => record['message']! as String));
        },
      );
      final logger = Logger(console: false, transports: [transport]);

      final first = logger.info('one').send();
      final second = logger.info('two').send();
      final third = logger.info('three').send();
      final fourth = logger.info('four').send();
      final fifth = logger.info('five').send();

      await Future<void>.delayed(Duration.zero);
      expect(dropped, ['three']);
      firstGate.complete();
      await Future.wait([first, second, fourth, fifth]);
      await third;
      await transport.close();
      expect(sent, ['one', 'two', 'four', 'five']);
    });

    test('drop diagnostics cannot throw through client logging', () async {
      final gate = Completer<void>();
      var calls = 0;
      final transport = SupabaseTransport(
        batchSize: 2,
        maxQueueSize: 2,
        flushInterval: const Duration(minutes: 1),
        onDrop: (_) => throw StateError('diagnostics failed'),
        sendBatch: (_) async {
          calls += 1;
          if (calls == 1) await gate.future;
        },
      );
      final logger = Logger(console: false, transports: [transport]);
      final first = logger.info('one').send();
      final second = logger.info('two').send();
      await logger.info('three').send();
      await logger.info('four').send();
      expect(() => logger.info('five').send(), returnsNormally);
      gate.complete();
      await Future.wait([first, second]);
      await transport.close();
    });

    test('close drains all pending batches and rejects later writes', () async {
      final messages = <String>[];
      final transport = SupabaseTransport(
        batchSize: 2,
        flushInterval: const Duration(minutes: 1),
        sendBatch: (records) => messages.addAll(
          records.map((record) => record['message']! as String),
        ),
      );
      final logger = Logger(console: false, transports: [transport]);
      final writes = List.generate(
        5,
        (index) => logger.info('message-$index').send(),
      );
      await Future.wait(writes);
      await transport.close();
      await transport.close();
      expect(messages, [
        'message-0',
        'message-1',
        'message-2',
        'message-3',
        'message-4',
      ]);
      await expectLater(
        transport.write(memoryRecord('after close')),
        throwsStateError,
      );
    });
  });

  group('explicit OpenTelemetry bridge', () {
    test('successful lifecycle propagates Zone context through async work',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.debug,
        console: false,
        transports: [memory],
      );
      final span = _TestSpan();
      final result = await withOtelSpan(
        logger,
        _TestTracer(span),
        'operation',
        (_) async {
          await Future<void>.delayed(Duration.zero);
          expect(currentLogContext()!.traceId, 'trace-span');
          await logger.info('inside span').send();
          return 47;
        },
      );
      expect(result, 47);
      expect(span.status, 1);
      expect(span.ended, 1);
      expect(
        memory.records
            .singleWhere((record) => record.message == 'inside span')
            .traceId,
        'trace-span',
      );
      expect(currentLogContext(), isNull);
    });

    test('callback error identity and stack are preserved after reporting',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.debug,
        console: false,
        transports: [memory],
      );
      final span = _TestSpan();
      final expected = StateError('declined');
      Object? actual;
      StackTrace? actualStack;
      try {
        await withOtelSpan<int>(
          logger,
          _TestTracer(span),
          'failure',
          (_) async {
            await Future<void>.delayed(Duration.zero);
            throw expected;
          },
        );
      } catch (error, stackTrace) {
        actual = error;
        actualStack = stackTrace;
      }
      expect(identical(actual, expected), isTrue);
      expect(actualStack.toString(), contains('adversarial_test.dart'));
      expect(identical(span.recorded, expected), isTrue);
      expect(span.status, 2);
      expect(span.ended, 1);
    });

    test('sampled-out spans correlate logs without recording mutations',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.debug,
        console: false,
        transports: [memory],
      );
      final span = _TestSpan()..recording = false;
      final result = await withOtelSpan(
        logger,
        _TestTracer(span),
        'sampled-out',
        (_) async {
          await logger.info('inside sampled-out').send();
          return 49;
        },
      );
      expect(result, 49);
      expect(span.status, 0);
      expect(span.recorded, isNull);
      expect(
        memory.records
            .singleWhere((record) => record.message == 'inside sampled-out')
            .traceId,
        'trace-span',
      );
      expect(span.ended, 1);
    });

    test('broken span context falls back to an empty Zone context', () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.debug,
        console: false,
        transports: [memory],
      );
      final span = _TestSpan()..failContext = true;
      final value = await withOtelSpan(
        logger,
        _TestTracer(span),
        'broken-context',
        (_) {
          expect(currentLogContext()!.traceId, isEmpty);
          return 53;
        },
      );
      expect(value, 53);
      expect(
        memory.records.any(
          (record) =>
              record.fields['otel.bridge_operation'] == 'read span context',
        ),
        isTrue,
      );
    });

    test('start, status, record, and end failures never replace app results',
        () async {
      final memory = MemoryTransport();
      final logger = Logger(
        minimumLevel: LogLevel.debug,
        console: false,
        transports: [memory],
      );
      final broken = _TestSpan()..failLifecycle = true;
      final value = await withOtelSpan(
        logger,
        _TestTracer(broken),
        'resilient',
        (_) async => 59,
      );
      expect(value, 59);

      final fallback = await withOtelSpan(
        logger,
        _FailingTracer(),
        'fallback',
        (span) async {
          expect(span.context.traceId, isEmpty);
          return 61;
        },
      );
      expect(fallback, 61);
      for (final operation in [
        'set success status',
        'end span',
        'start span'
      ]) {
        expect(
          memory.records.any(
            (record) => record.fields['otel.bridge_operation'] == operation,
          ),
          isTrue,
        );
      }
    });

    test('telemetry sink failures do not replace callback success', () async {
      final logger = Logger(
        minimumLevel: LogLevel.debug,
        console: false,
        transports: [_FailingTransport(StateError('sink unavailable'))],
      );
      final span = _TestSpan()..failLifecycle = true;
      final result = await withOtelSpan(
        logger,
        _TestTracer(span),
        'sink-failure',
        (_) async => 67,
      );
      expect(result, 67);
    });
  });
}

LogRecord memoryRecord(String message) => LogRecord(
      id: 'record-$message',
      timestamp: DateTime.utc(2026).toIso8601String(),
      level: LogLevel.info,
      runtime: 'dart',
      appName: 'test',
      message: message,
      values: [message],
      fields: const {},
    );

class _FailingTransport implements LogTransport {
  _FailingTransport(this.failure);
  final Object failure;
  int writes = 0;

  @override
  Future<void> write(LogRecord record) async {
    writes += 1;
    throw failure;
  }

  @override
  void flush() {}

  @override
  void close() {}
}

class _TestTracer implements OtelTracer {
  _TestTracer(this.span);
  final _TestSpan span;

  @override
  OtelSpan startSpan(String name, JsonMap attributes) => span;
}

class _FailingTracer implements OtelTracer {
  @override
  OtelSpan startSpan(String name, JsonMap attributes) {
    throw StateError('sdk unavailable');
  }
}

class _TestSpan implements OtelSpan, RecordingOtelSpan {
  int status = 0;
  int ended = 0;
  Object? recorded;
  bool failContext = false;
  bool failLifecycle = false;
  bool recording = true;

  @override
  bool get isRecording => recording;

  @override
  LogContext get context {
    if (failContext) throw StateError('context unavailable');
    return const LogContext(
      traceId: 'trace-span',
      spanId: 'span-span',
      traceFlags: 1,
      traceState: 'vendor=value',
      baggage: {'tenant': 'acme'},
      fields: {'route': '/pay'},
      tags: ['request'],
    );
  }

  @override
  void end() {
    if (failLifecycle) throw StateError('end unavailable');
    ended += 1;
  }

  @override
  void recordException(Object error, StackTrace stackTrace) {
    if (failLifecycle) throw StateError('record unavailable');
    recorded = error;
  }

  @override
  void setStatus(int code, String description) {
    if (failLifecycle) throw StateError('status unavailable');
    status = code;
  }
}
