import 'dart:async';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:test/test.dart';

void main() {
  group('Dart and Flutter conformance', () {
    test('emits one correlated record through explicit transports', () async {
      final otel = <Map<String, Object?>>[];
      final supabase = <Map<String, Object?>>[];
      final logger = Logger(
        appName: 'payments',
        name: 'audit',
        fields: const {'environment': 'test'},
        idFactory: () => 'dart-record-1',
        clock: () => DateTime.utc(2026, 1, 2, 3, 4, 5),
        console: false,
        transports: <LogTransport>[
          OpenTelemetryTransport(otel.add),
          SupabaseTransport(
              batchSize: 1, sendBatch: (batch) => supabase.addAll(batch)),
        ],
      );

      final record = await runWithLogContext(
        const LogContext(
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          traceFlags: 1,
          traceState: 'vendor=value',
          fields: {'requestId': 'request-1'},
          tags: ['otel', 'flutter'],
        ),
        () => logger
            .error('payment failed')
            .addFields(const {'orderId': 'order-42'}).send(),
      );

      expect(record!.toJson()['schema'], schema);
      expect(record.level, LogLevel.error);
      expect(record.traceId, '0123456789abcdef0123456789abcdef');
      final fields = record.fields;
      expect(fields['otel.span_id'], '0123456789abcdef');
      expect(fields['otel.trace_flags'], 1);
      expect(fields['otel.trace_state'], 'vendor=value');
      expect(fields['requestId'], 'request-1');
      expect(fields['orderId'], 'order-42');
      expect(otel, hasLength(1));
      expect(otel.single['severityNumber'], 17);
      expect(supabase, hasLength(1));
      expect(currentLogContext(), isNull);
    });

    test('Zone context isolates concurrent Futures and restores the caller',
        () async {
      final logger = Logger(
        appName: 'zone-test',
        idFactory: () => 'zone-record',
        clock: () => DateTime.utc(2026, 1, 2, 3, 4, 5),
        console: false,
      );

      final traces = await Future.wait<String>(<Future<String>>[
        Future<String>(() async {
          return runWithLogContext(
            const LogContext(traceId: 'trace-a', spanId: 'span-a'),
            () async {
              await Future<void>.delayed(Duration.zero);
              return (await logger.info('a').send())!.traceId;
            },
          );
        }),
        Future<String>(() async {
          return runWithLogContext(
            const LogContext(traceId: 'trace-b', spanId: 'span-b'),
            () async {
              await Future<void>.delayed(Duration.zero);
              return (await logger.info('b').send())!.traceId;
            },
          );
        }),
      ]);

      expect(traces, ['trace-a', 'trace-b']);
      expect(currentLogContext(), isNull);
    });

    test('Zone context restores after a synchronous failure', () {
      expect(currentLogContext(), isNull);
      expect(
        () => runWithLogContext(
          const LogContext(traceId: 'trace-failure'),
          () => throw StateError('boom'),
        ),
        throwsStateError,
      );
      expect(currentLogContext(), isNull);
    });

    test('per-event OTEL routing preserves ordinary logging', () async {
      final memory = MemoryTransport();
      final otel = <JsonMap>[];
      final logger = Logger(
        console: false,
        transports: [memory, OpenTelemetryTransport(otel.add)],
      );

      await logger.info('default').send();
      await logger.info('ordinary-only').notOtel().send();
      logger.notOtel();
      await logger.info('logger-off').send();
      await logger.info('override').useOtel().send();

      expect(memory.records.map((record) => record.message), [
        'default',
        'ordinary-only',
        'logger-off',
        'override',
      ]);
      expect(otel.map((record) => record['body']), ['default', 'override']);
    });
  });
}
