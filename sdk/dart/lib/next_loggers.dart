import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

const nextLoggersSchema = 'next-loggers/v1';

enum LogLevel { trace, debug, info, warn, error, fatal }

extension LogLevelWire on LogLevel {
  String get wire => name.toUpperCase();
  int get severityNumber => const <LogLevel, int>{
        LogLevel.trace: 1,
        LogLevel.debug: 5,
        LogLevel.info: 9,
        LogLevel.warn: 13,
        LogLevel.error: 17,
        LogLevel.fatal: 21,
      }[this]!;

  int get otelSeverityNumber => severityNumber;
}

class LogContext {
  const LogContext({
    this.loggedInUser = const <String, Object?>{},
    this.users = const <Map<String, Object?>>[],
    this.fields = const <String, Object?>{},
    this.traceId,
    this.traceIds = const <String>[],
    this.spanId,
    this.traceFlags,
    this.traceState,
    this.baggage = const <String, String>{},
    this.routineId,
    this.tags = const <String>[],
    this.context = const <Object?>[],
    this.meta = const <Object?>[],
  });

  final Map<String, Object?> loggedInUser;
  final List<Map<String, Object?>> users;
  final Map<String, Object?> fields;
  final String? traceId;
  final List<String> traceIds;
  final String? spanId;
  final int? traceFlags;
  final String? traceState;
  final Map<String, String> baggage;
  final String? routineId;
  final List<String> tags;
  final List<Object?> context;
  final List<Object?> meta;

  LogContext copy() => LogContext(
        loggedInUser: Map<String, Object?>.from(loggedInUser),
        users: users
            .map((value) => Map<String, Object?>.from(value))
            .toList(growable: false),
        fields: Map<String, Object?>.from(fields),
        traceId: traceId,
        traceIds: List<String>.from(traceIds),
        spanId: spanId,
        traceFlags: traceFlags,
        traceState: traceState,
        baggage: Map<String, String>.from(baggage),
        routineId: routineId,
        tags: List<String>.from(tags),
        context: List<Object?>.from(context),
        meta: List<Object?>.from(meta),
      );

  LogContext merge(LogContext patch) {
    final traces = <String>[];
    void addTrace(String? value) {
      if (value != null && value.isNotEmpty && !traces.contains(value)) {
        traces.add(value);
      }
    }

    addTrace(traceId);
    for (final value in traceIds) {
      addTrace(value);
    }
    addTrace(patch.traceId);
    for (final value in patch.traceIds) {
      addTrace(value);
    }

    final mergedTags = <String>[];
    for (final value in <String>[...tags, ...patch.tags]) {
      if (value.isNotEmpty && !mergedTags.contains(value)) {
        mergedTags.add(value);
      }
    }

    return LogContext(
      loggedInUser: <String, Object?>{...loggedInUser, ...patch.loggedInUser},
      users: <Map<String, Object?>>[
        ...users.map(Map<String, Object?>.from),
        ...patch.users.map(Map<String, Object?>.from),
      ],
      fields: <String, Object?>{...fields, ...patch.fields},
      traceId:
          patch.traceId ?? traceId ?? (traces.isEmpty ? null : traces.first),
      traceIds: traces,
      spanId: patch.spanId ?? spanId,
      traceFlags: patch.traceFlags ?? traceFlags,
      traceState: patch.traceState ?? traceState,
      baggage: <String, String>{...baggage, ...patch.baggage},
      routineId: patch.routineId ?? routineId,
      tags: mergedTags,
      context: <Object?>[...context, ...patch.context],
      meta: <Object?>[...meta, ...patch.meta],
    );
  }
}

final Object _logContextZoneKey = Object();

class _LogContextFrame {
  _LogContextFrame(this.value);
  LogContext value;
}

LogContext? get currentLogContext {
  final value = Zone.current[_logContextZoneKey];
  if (value is _LogContextFrame) {
    return value.value.copy();
  }
  if (value is LogContext) {
    return value.copy();
  }
  return null;
}

Map<String, Object?>? get currentLoggedInUser {
  final user = currentLogContext?.loggedInUser;
  if (user == null || user.isEmpty) return null;
  return Map<String, Object?>.from(user);
}

FutureOr<T> withLogContext<T>(
  LogContext context,
  FutureOr<T> Function() callback,
) {
  final parent = currentLogContext;
  final value = parent == null ? context.copy() : parent.merge(context);
  return runZoned<FutureOr<T>>(
    callback,
    zoneValues: <Object?, Object?>{_logContextZoneKey: _LogContextFrame(value)},
  );
}

FutureOr<T> runWithLogContext<T>(
  LogContext context,
  FutureOr<T> Function() callback,
) =>
    withLogContext(context, callback);

/// Mutates only the current Zone frame. Returns false outside a context scope.
bool updateLogContext(LogContext patch) {
  final value = Zone.current[_logContextZoneKey];
  if (value is! _LogContextFrame) {
    return false;
  }
  value.value = value.value.merge(patch);
  return true;
}

bool setContextLoggedInUser(Map<String, Object?> user) =>
    updateLogContext(LogContext(loggedInUser: Map<String, Object?>.from(user)));

typedef RecordSender = FutureOr<void> Function(Map<String, Object?> record);

abstract interface class LogTransport {
  FutureOr<void> write(Map<String, Object?> record);
}

abstract interface class FlushableLogTransport {
  FutureOr<void> flush();
}

abstract interface class ExitFlushableLogTransport {
  FutureOr<void> flushOnExit(List<Map<String, Object?>> recoveredRecords);
}

abstract interface class ClosableLogTransport {
  FutureOr<void> close();
}

class Logger {
  Logger({
    required this.appName,
    this.name,
    this.runtime = 'dart',
    this.minimumLevel = LogLevel.trace,
    Map<String, Object?> fields = const <String, Object?>{},
    Map<String, Object?> loggedInUser = const <String, Object?>{},
    List<LogTransport> transports = const <LogTransport>[],
    String Function()? idFactory,
    String Function()? clock,
  })  : fields = Map<String, Object?>.from(fields),
        loggedInUser = Map<String, Object?>.from(loggedInUser),
        transports = List<LogTransport>.unmodifiable(transports),
        idFactory = idFactory ?? _defaultId,
        clock = clock ?? (() => DateTime.now().toUtc().toIso8601String());

  final String appName;
  final String? name;
  final String runtime;
  final LogLevel minimumLevel;
  final Map<String, Object?> fields;
  final Map<String, Object?> loggedInUser;
  final List<LogTransport> transports;
  final String Function() idFactory;
  final String Function() clock;
  bool _closed = false;

  Logger addFields(Map<String, Object?> values) {
    fields.addAll(Map<String, Object?>.from(values));
    return this;
  }

  Logger setCurrentUser(Map<String, Object?> user) {
    loggedInUser.addAll(Map<String, Object?>.from(user));
    return this;
  }

  Future<Map<String, Object?>> trace(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
  }) =>
      log(LogLevel.trace, message, fields: fields, values: values);

  Future<Map<String, Object?>> debug(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
  }) =>
      log(LogLevel.debug, message, fields: fields, values: values);

  Future<Map<String, Object?>> info(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
  }) =>
      log(LogLevel.info, message, fields: fields, values: values);

  Future<Map<String, Object?>> warn(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
  }) =>
      log(LogLevel.warn, message, fields: fields, values: values);

  Future<Map<String, Object?>> error(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
    Object? error,
    StackTrace? stackTrace,
  }) =>
      log(
        LogLevel.error,
        message,
        fields: fields,
        values: values,
        errors: error == null ? const <Object?>[] : <Object?>[error],
        stackTrace: stackTrace == null
            ? const <String>[]
            : <String>[stackTrace.toString()],
      );

  Future<Map<String, Object?>> fatal(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
    Object? error,
    StackTrace? stackTrace,
  }) =>
      log(
        LogLevel.fatal,
        message,
        fields: fields,
        values: values,
        errors: error == null ? const <Object?>[] : <Object?>[error],
        stackTrace: stackTrace == null
            ? const <String>[]
            : <String>[stackTrace.toString()],
      );

  Future<Map<String, Object?>> log(
    LogLevel level,
    String message, {
    Map<String, Object?> eventFields = const <String, Object?>{},
    Map<String, Object?> fields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
    Map<String, Object?> loggedInUser = const <String, Object?>{},
    List<Map<String, Object?>> users = const <Map<String, Object?>>[],
    String? traceId,
    List<String> traceIds = const <String>[],
    String? routineId,
    List<String> tags = const <String>[],
    List<Object?> context = const <Object?>[],
    List<Object?> meta = const <Object?>[],
    List<Object?> errors = const <Object?>[],
    List<String> stackTrace = const <String>[],
  }) async {
    if (appName.trim().isEmpty) {
      throw ArgumentError.value(appName, 'appName', 'must not be empty');
    }
    if (_closed) {
      throw StateError('next-loggers Logger is closed');
    }

    final ambient = currentLogContext;
    final mergedFields = <String, Object?>{
      ...this.fields,
      ...?ambient?.fields,
      ...eventFields,
      ...fields,
    };
    if (ambient?.spanId != null) {
      mergedFields['otel.span_id'] = ambient!.spanId;
    }
    if (ambient != null) {
      if (ambient.traceFlags != null) {
        mergedFields['otel.trace_flags'] = ambient.traceFlags;
      }
      if (ambient.traceState != null) {
        mergedFields['otel.trace_state'] = ambient.traceState;
      }
      if (ambient.baggage.isNotEmpty) {
        mergedFields['otel.baggage'] = Map<String, String>.from(
          ambient.baggage,
        );
      }
    }

    final traces = <String>[];
    void addTrace(String? value) {
      if (value != null && value.isNotEmpty && !traces.contains(value)) {
        traces.add(value);
      }
    }

    addTrace(traceId);
    addTrace(ambient?.traceId);
    for (final value in ambient?.traceIds ?? const <String>[]) {
      addTrace(value);
    }
    for (final value in traceIds) {
      addTrace(value);
    }

    final mergedTags = <String>[];
    for (final value in <String>[...?ambient?.tags, ...tags]) {
      if (value.isNotEmpty && !mergedTags.contains(value)) {
        mergedTags.add(value);
      }
    }

    final mergedUser = <String, Object?>{
      ...this.loggedInUser,
      ...?ambient?.loggedInUser,
      ...loggedInUser,
    };
    final mergedUsers = <Map<String, Object?>>[
      ...?ambient?.users.map(Map<String, Object?>.from),
      ...users.map(Map<String, Object?>.from),
    ];

    final record = <String, Object?>{
      'schema': nextLoggersSchema,
      'id': idFactory(),
      'timestamp': clock(),
      'level': level.wire,
      'runtime': runtime,
      'appName': appName,
      'message': message,
      'values': _normalize(values.isEmpty ? <Object?>[message] : values),
      'fields': _normalize(mergedFields),
      if (name != null && name!.isNotEmpty) 'name': name,
      if (mergedUser.isNotEmpty) 'loggedInUser': _normalize(mergedUser),
      if (mergedUsers.isNotEmpty) 'users': _normalize(mergedUsers),
      if (traces.isNotEmpty) 'traceId': traces.first,
      if (traces.isNotEmpty) 'traceIds': traces,
      if ((routineId ?? ambient?.routineId) != null)
        'routineId': routineId ?? ambient?.routineId,
      if (mergedTags.isNotEmpty) 'tags': mergedTags,
      if (<Object?>[...?ambient?.context, ...context].isNotEmpty)
        'context': _normalize(<Object?>[...?ambient?.context, ...context]),
      if (<Object?>[...?ambient?.meta, ...meta].isNotEmpty)
        'meta': _normalize(<Object?>[...?ambient?.meta, ...meta]),
      if (errors.isNotEmpty) 'errors': _normalize(errors),
      if (stackTrace.isNotEmpty) 'stackTrace': stackTrace,
    };

    if (level.index >= minimumLevel.index) {
      for (final transport in transports) {
        await transport.write(_recordCopy(record));
      }
    }
    return _recordCopy(record);
  }

  Future<void> flush() async {
    for (final transport in transports) {
      if (transport is FlushableLogTransport) {
        await (transport as FlushableLogTransport).flush();
      }
    }
  }

  Future<void> flushOnExit() async {
    for (final transport in transports) {
      if (transport is ExitFlushableLogTransport) {
        await (transport as ExitFlushableLogTransport).flushOnExit(
          const <Map<String, Object?>>[],
        );
      }
    }
    await flush();
  }

  Future<void> close() async {
    if (_closed) {
      return;
    }
    await flushOnExit();
    for (final transport in transports) {
      if (transport is ClosableLogTransport) {
        await (transport as ClosableLogTransport).close();
      }
    }
    _closed = true;
  }
}

class OpenTelemetryTransport implements LogTransport {
  OpenTelemetryTransport(this.emit);
  final FutureOr<void> Function(Map<String, Object?> record) emit;

  @override
  FutureOr<void> write(Map<String, Object?> record) {
    final level = LogLevel.values.firstWhere(
      (value) => value.wire == record['level'],
    );
    final fields = Map<String, Object?>.from(
      (record['fields'] as Map?)?.cast<String, Object?>() ??
          const <String, Object?>{},
    );
    final attributes = <String, Object?>{
      'service.name': record['appName'],
      'next_logger.schema': record['schema'],
      'next_logger.runtime': record['runtime'],
      'log.record.uid': record['id'],
      if (record['traceId'] != null) 'trace.id': record['traceId'],
      for (final entry in fields.entries)
        'next_logger.field.${entry.key}': entry.value,
    };
    return emit(<String, Object?>{
      'body': record['message'],
      'severityText': level.wire,
      'severityNumber': level.severityNumber,
      'timestamp': record['timestamp'],
      'attributes': attributes,
      'record': _recordCopy(record),
    });
  }
}

class SupabaseTransport implements LogTransport {
  SupabaseTransport(this.insert);
  final FutureOr<void> Function(Map<String, Object?> record) insert;

  @override
  FutureOr<void> write(Map<String, Object?> record) =>
      insert(_recordCopy(record));
}

class MemoryTransport
    implements
        LogTransport,
        FlushableLogTransport,
        ExitFlushableLogTransport,
        ClosableLogTransport {
  final List<Map<String, Object?>> records = <Map<String, Object?>>[];
  int flushCount = 0;
  bool closed = false;

  @override
  void write(Map<String, Object?> record) => records.add(_recordCopy(record));

  @override
  void flush() {
    flushCount += 1;
  }

  @override
  void flushOnExit(List<Map<String, Object?>> recoveredRecords) {
    flushCount += 1;
  }

  @override
  void close() {
    closed = true;
  }
}

String _defaultId() {
  final random = Random.secure();
  final timestamp = DateTime.now().microsecondsSinceEpoch.toRadixString(16);
  final suffix = List<int>.generate(
    8,
    (_) => random.nextInt(256),
  ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  return 'dart-$timestamp-$suffix';
}

Object? _normalize(Object? value) =>
    _normalizeValue(value, 0, HashSet<Object>.identity());

Object? _normalizeValue(Object? value, int depth, Set<Object> ancestors) {
  if (depth > 12) {
    return '[Truncated: max depth]';
  }
  if (value == null || value is num || value is bool || value is String) {
    return value;
  }
  if (value is DateTime) {
    return value.toUtc().toIso8601String();
  }
  if (value is StackTrace || value is Error || value is Exception) {
    return value.toString();
  }
  if (value is Map) {
    if (!ancestors.add(value)) {
      return '[Circular]';
    }
    try {
      final result = <String, Object?>{};
      for (final entry in value.entries.take(200)) {
        result[entry.key.toString()] = _normalizeValue(
          entry.value,
          depth + 1,
          ancestors,
        );
      }
      if (value.length > 200) {
        result['[Truncated]'] = '${value.length - 200} properties omitted';
      }
      return result;
    } finally {
      ancestors.remove(value);
    }
  }
  if (value is Iterable) {
    if (!ancestors.add(value)) {
      return '[Circular]';
    }
    try {
      final result = <Object?>[];
      var truncated = false;
      for (final entry in value) {
        if (result.length >= 1000) {
          truncated = true;
          break;
        }
        result.add(_normalizeValue(entry, depth + 1, ancestors));
      }
      if (truncated) {
        result.add('[Truncated: more items omitted]');
      }
      return result;
    } finally {
      ancestors.remove(value);
    }
  }
  try {
    return jsonDecode(jsonEncode(value));
  } catch (_) {
    return value.toString();
  }
}

Map<String, Object?> _recordCopy(Map<String, Object?> record) {
  final normalized = _normalize(record);
  if (normalized is! Map) {
    throw StateError('normalized log record is not an object');
  }
  return normalized.map<String, Object?>(
    (key, value) => MapEntry<String, Object?>(key.toString(), value),
  );
}
