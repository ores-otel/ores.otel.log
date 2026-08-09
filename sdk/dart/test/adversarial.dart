import 'dart:async';

import '../lib/next_loggers.dart';

Future<void> main() async {
  await _run(
      'nested async contexts restore the parent', _nestedContextsRestore);
  await _run('context restores after asynchronous failure',
      _contextRestoresAfterFailure);
  await _run('100 concurrent Zones never cross-contaminate',
      _concurrentZonesAreIsolated);
  await _run(
      'field precedence is logger, context, then event', _fieldPrecedence);
  await _run('records without context omit correlation optionals',
      _optionalCorrelationFields);
  await _run('all OTEL severity mappings are stable', _allSeverityMappings);
  await _run('OTEL copies trace and structured fields', _otelCorrelation);
  await _run('OTEL output is deeply immutable', _otelOutputIsImmutable);
  await _run('Supabase receives the canonical immutable record',
      _supabaseGetsCanonicalRecord);
  await _run('transport fanout preserves configuration order', _transportOrder);
  await _run('transport failures aggregate after full fanout',
      _transportFailureAggregation);
  await _run('records and nested values are deeply immutable',
      _recordIsDeeplyImmutable);
  await _run(
      'input mutations cannot change emitted records', _inputMutationIsolation);
  await _run('custom values are copied into the wire record', _customValues);
  await _run(
      'deterministic ID and clock hooks are honored', _deterministicHooks);
  await _run('invalid application names are rejected', _invalidApplicationName);
  await _run('generated IDs are unique', _generatedIdsAreUnique);
  await _run('runtime and logger name are preserved', _runtimeAndName);
  await _run('context tags are copied and frozen', _contextTags);
  await _run('context is empty after every completed scope', _noContextLeak);
  print('Dart/Flutter adversarial next-loggers tests passed');
}

Future<void> _run(String name, FutureOr<void> Function() body) async {
  await body();
  print('ok - $name');
}

Future<void> _nestedContextsRestore() async {
  _check(currentLogContext == null, 'context should start empty');
  const parent = LogContext(traceId: 'parent', spanId: 'span-parent');
  const child = LogContext(traceId: 'child', spanId: 'span-child');
  await withLogContext(parent, () async {
    _check(currentLogContext?.traceId == 'parent', 'parent missing');
    await withLogContext(child, () async {
      await Future<void>.delayed(Duration.zero);
      _check(currentLogContext?.traceId == 'child', 'child missing');
    });
    _check(currentLogContext?.traceId == 'parent', 'parent not restored');
  });
  _check(currentLogContext == null, 'nested context leaked');
}

Future<void> _contextRestoresAfterFailure() async {
  final expected = StateError('boom');
  Object? actual;
  await withLogContext(const LogContext(traceId: 'parent'), () async {
    try {
      await withLogContext(const LogContext(traceId: 'child'), () async {
        await Future<void>.delayed(Duration.zero);
        throw expected;
      });
    } catch (error) {
      actual = error;
    }
    _check(identical(actual, expected), 'exception identity changed');
    _check(currentLogContext?.traceId == 'parent',
        'parent not restored after failure');
  });
  _check(currentLogContext == null, 'failed context leaked');
}

Future<void> _concurrentZonesAreIsolated() async {
  final records = <Map<String, Object?>>[];
  final logger = Logger(
    appName: 'concurrency',
    transports: <LogTransport>[_CaptureTransport(records)],
  );
  const count = 100;
  await Future.wait(List<Future<void>>.generate(count, (index) async {
    final suffix = index.toString().padLeft(3, '0');
    await withLogContext(
      LogContext(traceId: 'trace-$suffix', spanId: 'span-$suffix'),
      () async {
        await Future<void>.delayed(Duration(microseconds: (index % 7) * 10));
        await logger.info('message-$suffix');
      },
    );
  }));
  _check(records.length == count, 'concurrent records missing');
  for (final record in records) {
    final message = record['message']! as String;
    final suffix = message.substring('message-'.length);
    final fields = record['fields']! as Map<String, Object?>;
    _check(record['traceId'] == 'trace-$suffix',
        'trace contamination for $message');
    _check(fields['otel.span_id'] == 'span-$suffix',
        'span contamination for $message');
  }
}

Future<void> _fieldPrecedence() async {
  final logger = Logger(
    appName: 'precedence',
    fields: const <String, Object?>{'source': 'logger', 'loggerOnly': true},
  );
  final record = await withLogContext(
    const LogContext(fields: <String, Object?>{
      'source': 'context',
      'contextOnly': true,
    }),
    () => logger.info('inside', fields: const <String, Object?>{
      'source': 'event',
      'eventOnly': true,
    }),
  );
  final fields = record['fields']! as Map<String, Object?>;
  _check(fields['source'] == 'event', 'event field did not win');
  _check(fields['loggerOnly'] == true, 'logger field missing');
  _check(fields['contextOnly'] == true, 'context field missing');
  _check(fields['eventOnly'] == true, 'event field missing');
}

Future<void> _optionalCorrelationFields() async {
  final record = await Logger(appName: 'plain').info('plain');
  _check(!record.containsKey('traceId'), 'traceId should be omitted');
  _check(!record.containsKey('traceIds'), 'traceIds should be omitted');
  _check(!record.containsKey('tags'), 'tags should be omitted');
  final fields = record['fields']! as Map<String, Object?>;
  _check(!fields.containsKey('otel.span_id'), 'span ID should be omitted');
  _check(
      !fields.containsKey('otel.trace_flags'), 'trace flags should be omitted');
}

Future<void> _allSeverityMappings() async {
  final emitted = <Map<String, Object?>>[];
  final logger = Logger(
    appName: 'severity',
    transports: <LogTransport>[OpenTelemetryTransport(emitted.add)],
  );
  for (final level in LogLevel.values) {
    await logger.log(level, level.name);
  }
  final expected = <String, int>{
    'TRACE': 1,
    'DEBUG': 5,
    'INFO': 9,
    'WARN': 13,
    'ERROR': 17,
    'FATAL': 21,
  };
  _check(emitted.length == expected.length, 'severity records missing');
  for (final value in emitted) {
    final text = value['severityText']! as String;
    _check(
        value['severityNumber'] == expected[text], 'wrong severity for $text');
  }
}

Future<void> _otelCorrelation() async {
  Map<String, Object?>? emitted;
  final logger = Logger(
    appName: 'otel',
    transports: <LogTransport>[
      OpenTelemetryTransport((value) => emitted = value)
    ],
  );
  await withLogContext(
    const LogContext(
      traceId: 'trace-otel',
      spanId: 'span-otel',
      traceFlags: 1,
      fields: <String, Object?>{'requestId': 'request-1'},
    ),
    () => logger.error('failed',
        fields: const <String, Object?>{'orderId': 'order-42'}),
  );
  final attributes = emitted!['attributes']! as Map<String, Object?>;
  _check(emitted!['severityNumber'] == 17, 'error severity missing');
  _check(attributes['trace.id'] == 'trace-otel', 'trace attribute missing');
  _check(attributes['next_logger.field.otel.span_id'] == 'span-otel',
      'span attribute missing');
  _check(attributes['next_logger.field.orderId'] == 'order-42',
      'event field missing');
}

Future<void> _otelOutputIsImmutable() async {
  Map<String, Object?>? emitted;
  final logger = Logger(
    appName: 'immutable-otel',
    transports: <LogTransport>[
      OpenTelemetryTransport((value) => emitted = value)
    ],
  );
  await logger.info('immutable');
  _expectUnsupported(() => emitted!['body'] = 'mutated');
  final attributes = emitted!['attributes']! as Map<String, Object?>;
  _expectUnsupported(() => attributes['x'] = true);
}

Future<void> _supabaseGetsCanonicalRecord() async {
  Map<String, Object?>? captured;
  final logger = Logger(
    appName: 'supabase',
    transports: <LogTransport>[
      SupabaseTransport((record) => captured = record)
    ],
  );
  final returned = await logger
      .info('client', fields: const <String, Object?>{'safe': true});
  _check(identical(captured, returned),
      'Supabase did not receive canonical record');
  _expectUnsupported(() => captured!['message'] = 'mutated');
  final fields = captured!['fields']! as Map<String, Object?>;
  _expectUnsupported(() => fields['safe'] = false);
}

Future<void> _transportOrder() async {
  final order = <int>[];
  final logger = Logger(
    appName: 'order',
    transports: <LogTransport>[
      _FunctionTransport((_) => order.add(1)),
      _FunctionTransport((_) async {
        await Future<void>.delayed(Duration.zero);
        order.add(2);
      }),
      _FunctionTransport((_) => order.add(3)),
    ],
  );
  await logger.info('ordered');
  _check(_listEquals(order, <int>[1, 2, 3]), 'transport order changed: $order');
}

Future<void> _transportFailureAggregation() async {
  final calls = <String>[];
  final first = StateError('first');
  final second = ArgumentError('second');
  final logger = Logger(
    appName: 'fanout',
    transports: <LogTransport>[
      _FunctionTransport((_) {
        calls.add('first');
        throw first;
      }),
      _FunctionTransport((_) => calls.add('middle')),
      _FunctionTransport((_) async {
        calls.add('last');
        throw second;
      }),
    ],
  );
  LogTransportException? actual;
  try {
    await logger.error('fanout');
  } on LogTransportException catch (error) {
    actual = error;
  }
  _check(actual != null, 'transport failures were not aggregated');
  _check(_listEquals(calls, <String>['first', 'middle', 'last']),
      'fanout stopped early');
  _check(actual!.errors.length == 2, 'wrong failure count');
  _check(identical(actual.errors[0], first), 'first error identity changed');
  _check(identical(actual.errors[1], second), 'second error identity changed');
  _check(actual.stackTraces.length == 2, 'stack traces missing');
}

Future<void> _recordIsDeeplyImmutable() async {
  final record = await Logger(appName: 'freeze').info(
    'freeze',
    fields: <String, Object?>{
      'nested': <String, Object?>{'value': 1},
      'list': <Object?>[
        1,
        <String, Object?>{'two': 2}
      ],
    },
  );
  _expectUnsupported(() => record['message'] = 'mutated');
  final fields = record['fields']! as Map<String, Object?>;
  _expectUnsupported(() => fields['x'] = true);
  final nested = fields['nested']! as Map<String, Object?>;
  _expectUnsupported(() => nested['value'] = 2);
  final list = fields['list']! as List<Object?>;
  _expectUnsupported(() => list.add(3));
  final nestedInList = list[1]! as Map<String, Object?>;
  _expectUnsupported(() => nestedInList['two'] = 3);
}

Future<void> _inputMutationIsolation() async {
  final loggerFields = <String, Object?>{
    'nested': <String, Object?>{'value': 'logger'},
  };
  final eventFields = <String, Object?>{
    'items': <Object?>['one', 'two'],
  };
  final logger = Logger(appName: 'snapshot', fields: loggerFields);
  loggerFields['nested'] = <String, Object?>{'value': 'mutated-before-log'};
  final record = await logger.info('snapshot', fields: eventFields);
  (eventFields['items']! as List<Object?>).add('mutated-after-log');
  final fields = record['fields']! as Map<String, Object?>;
  final nested = fields['nested']! as Map<String, Object?>;
  final items = fields['items']! as List<Object?>;
  _check(nested['value'] == 'logger', 'logger fields were not snapshotted');
  _check(_listEquals(items, <Object?>['one', 'two']),
      'event values alias caller list');
}

Future<void> _customValues() async {
  final input = <Object?>[
    'message',
    42,
    <String, Object?>{'safe': true}
  ];
  final record = await Logger(appName: 'values').log(
    LogLevel.info,
    'message',
    values: input,
  );
  input.add('mutated');
  final values = record['values']! as List<Object?>;
  _check(values.length == 3, 'custom values changed after input mutation');
  _expectUnsupported(() => values.add('x'));
}

Future<void> _deterministicHooks() async {
  final logger = Logger(
    appName: 'deterministic',
    idFactory: () => 'fixed-id',
    clock: () => '2026-01-02T03:04:05.000Z',
  );
  final record = await logger.info('fixed');
  _check(record['id'] == 'fixed-id', 'ID hook ignored');
  _check(
      record['timestamp'] == '2026-01-02T03:04:05.000Z', 'clock hook ignored');
}

Future<void> _invalidApplicationName() async {
  Object? actual;
  try {
    await Logger(appName: ' ').info('invalid');
  } catch (error) {
    actual = error;
  }
  _check(actual is ArgumentError, 'blank appName was accepted');
}

Future<void> _generatedIdsAreUnique() async {
  final logger = Logger(appName: 'ids');
  final ids = <Object?>{};
  for (var index = 0; index < 500; index += 1) {
    ids.add((await logger.info('id-$index'))['id']);
  }
  _check(ids.length == 500, 'generated IDs collided');
}

Future<void> _runtimeAndName() async {
  final record = await Logger(
    appName: 'named',
    name: 'audit',
    runtime: 'flutter',
  ).info('named');
  _check(record['name'] == 'audit', 'logger name missing');
  _check(record['runtime'] == 'flutter', 'runtime missing');
}

Future<void> _contextTags() async {
  final record = await withLogContext(
    const LogContext(
      traceId: 'trace',
      tags: <String>['otel', 'flutter', 'request'],
    ),
    () => Logger(appName: 'tags').info('tagged'),
  );
  final tags = record['tags']! as List<Object?>;
  _check(
    _listEquals(tags, <Object?>['otel', 'flutter', 'request']),
    'context tags missing',
  );
  _expectUnsupported(() => tags.add('mutated'));
}

Future<void> _noContextLeak() async {
  for (var index = 0; index < 50; index += 1) {
    await withLogContext(
      LogContext(traceId: 'trace-$index'),
      () async => Future<void>.delayed(Duration.zero),
    );
    _check(currentLogContext == null, 'context leaked at iteration $index');
  }
}

void _expectUnsupported(void Function() body) {
  Object? actual;
  try {
    body();
  } catch (error) {
    actual = error;
  }
  _check(actual is UnsupportedError, 'expected UnsupportedError, got $actual');
}

bool _listEquals(List<Object?> left, List<Object?> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

void _check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

final class _CaptureTransport implements LogTransport {
  _CaptureTransport(this.records);
  final List<Map<String, Object?>> records;

  @override
  void write(Map<String, Object?> record) => records.add(record);
}

final class _FunctionTransport implements LogTransport {
  _FunctionTransport(this.callback);
  final RecordSender callback;

  @override
  FutureOr<void> write(Map<String, Object?> record) => callback(record);
}
