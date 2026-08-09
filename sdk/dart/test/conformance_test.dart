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
        clock: () => '2026-01-02T03:04:05.000Z',
        transports: <LogTransport>[
          OpenTelemetryTransport(otel.add),
          SupabaseTransport(supabase.add),
        ],
      );

      final record = await withLogContext(
        const LogContext(
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          traceFlags: 1,
          traceState: 'vendor=value',
          fields: {'requestId': 'request-1'},
          tags: ['otel', 'flutter'],
        ),
        () => logger.error(
          'payment failed',
          fields: const {'orderId': 'order-42'},
        ),
      );

      expect(record['schema'], nextLoggersSchema);
      expect(record['level'], 'ERROR');
      expect(record['traceId'], '0123456789abcdef0123456789abcdef');
      final fields = record['fields']! as Map<String, Object?>;
      expect(fields['otel.span_id'], '0123456789abcdef');
      expect(fields['otel.trace_flags'], 1);
      expect(fields['otel.trace_state'], 'vendor=value');
      expect(fields['requestId'], 'request-1');
      expect(fields['orderId'], 'order-42');
      expect(otel, hasLength(1));
      expect(otel.single['severityNumber'], 17);
      expect(supabase, hasLength(1));
      expect(currentLogContext, isNull);
    });

    test('Zone context isolates concurrent Futures and restores the caller',
        () async {
      final logger = Logger(
        appName: 'zone-test',
        idFactory: () => 'zone-record',
        clock: () => '2026-01-02T03:04:05.000Z',
      );

      final traces = await Future.wait<String>(<Future<String>>[
        Future<String>(() async {
          return withLogContext(
            const LogContext(traceId: 'trace-a', spanId: 'span-a'),
            () async {
              await Future<void>.delayed(Duration.zero);
              return (await logger.info('a'))['traceId']! as String;
            },
          );
        }),
        Future<String>(() async {
          return withLogContext(
            const LogContext(traceId: 'trace-b', spanId: 'span-b'),
            () async {
              await Future<void>.delayed(Duration.zero);
              return (await logger.info('b'))['traceId']! as String;
            },
          );
        }),
      ]);

      expect(traces, ['trace-a', 'trace-b']);
      expect(currentLogContext, isNull);
    });

    test('Zone context restores after a synchronous failure', () {
      expect(currentLogContext, isNull);
      expect(
        () => withLogContext(
          const LogContext(traceId: 'trace-failure'),
          () => throw StateError('boom'),
        ),
        throwsStateError,
      );
      expect(currentLogContext, isNull);
    });
  });
}
