import 'dart:async';

import 'package:oresoftware_next_loggers/next_loggers.dart';
import 'package:test/test.dart';

void main() {
  test('Zone context flows into records and remains isolated', () async {
    final transport = MemoryTransport();
    final logger = Logger(console: false, transports: [transport]);
    await Future.wait([
      runWithLogContext(
        const LogContext(traceId: 'left', spanId: 's1', traceFlags: 1),
        () async {
          await Future<void>.delayed(const Duration(milliseconds: 2));
          await logger.info('left').send();
        },
      ),
      runWithLogContext(
        const LogContext(traceId: 'right', spanId: 's2', traceFlags: 1),
        () async => logger.info('right').send(),
      ),
    ]);
    final byMessage = {
      for (final record in transport.records) record.message: record,
    };
    expect(byMessage['left']!.traceId, 'left');
    expect(byMessage['left']!.fields['otel.span_id'], 's1');
    expect(byMessage['right']!.traceId, 'right');
    expect(currentLogContext(), isNull);
  });

  test('Supabase transport batches client records through injected sender',
      () async {
    final batches = <List<JsonMap>>[];
    final transport = SupabaseTransport(batchSize: 2, sendBatch: batches.add);
    final logger = Logger(console: false, transports: [transport]);
    await Future.wait([
      logger.info('one').send(),
      logger.warn('two').send(),
    ]);
    expect(batches, hasLength(1));
    expect(
      batches.single.map((record) => record['message']),
      ['one', 'two'],
    );
    await transport.close();
  });

  test('explicit OTEL span lifecycle is wrapped by next-loggers', () async {
    final transport = MemoryTransport();
    final logger = Logger(
      minimumLevel: LogLevel.debug,
      console: false,
      transports: [transport],
    );
    final span = _Span();
    final value = await withOtelSpan(
      logger,
      _Tracer(span),
      'operation',
      (_) async => 7,
    );
    expect(value, 7);
    expect(span.status, 1);
    expect(span.ended, 1);
    expect(
      transport.records.map((record) => record.message),
      ['span started: operation', 'span completed: operation'],
    );
  });

  test('OTEL lifecycle and start failures do not replace results', () async {
    final transport = MemoryTransport();
    final logger = Logger(
      minimumLevel: LogLevel.debug,
      console: false,
      transports: [transport],
    );
    final broken = _Span()..failLifecycle = true;
    final value = await withOtelSpan(
      logger,
      _Tracer(broken),
      'resilient',
      (_) async => 11,
    );
    expect(value, 11);
    expect(
      transport.records.any(
        (record) => record.message.contains('set success status'),
      ),
      isTrue,
    );
    expect(
      transport.records.any((record) => record.message.contains('end span')),
      isTrue,
    );

    final fallback = await withOtelSpan(
      logger,
      _FailingTracer(),
      'fallback',
      (_) async => 12,
    );
    expect(fallback, 12);
    expect(
      transport.records.any((record) => record.message.contains('start span')),
      isTrue,
    );
  });
}

class _Tracer implements OtelTracer {
  _Tracer(this.span);
  final _Span span;
  @override
  OtelSpan startSpan(String name, JsonMap attributes) => span;
}

class _Span implements OtelSpan {
  int status = 0;
  int ended = 0;
  Object? recorded;
  bool failLifecycle = false;

  @override
  LogContext get context => const LogContext(
        traceId: 'trace',
        spanId: 'span',
        traceFlags: 1,
      );

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

class _FailingTracer implements OtelTracer {
  @override
  OtelSpan startSpan(String name, JsonMap attributes) {
    throw StateError('sdk unavailable');
  }
}
