import 'dart:async';
import 'dart:convert';
import 'dart:math';

const schema = 'next-loggers/v1';
typedef JsonMap = Map<String, Object?>;
typedef SupabaseBatchSender = FutureOr<void> Function(List<JsonMap> records);

enum LogLevel { trace, debug, info, warn, error, fatal }

extension LogLevelWire on LogLevel {
  String get wireName => name.toUpperCase();
}

class LogContext {
  const LogContext({
    this.loggedInUser = const {},
    this.users = const [],
    this.traceId = '',
    this.traceIds = const [],
    this.spanId = '',
    this.traceFlags,
    this.traceState = '',
    this.baggage = const {},
    this.fields = const {},
    this.routineId = '',
    this.tags = const [],
    this.context = const [],
    this.meta = const [],
  });

  final JsonMap loggedInUser;
  final List<JsonMap> users;
  final String traceId;
  final List<String> traceIds;
  final String spanId;
  final int? traceFlags;
  final String traceState;
  final Map<String, String> baggage;
  final JsonMap fields;
  final String routineId;
  final List<String> tags;
  final List<Object?> context;
  final List<Object?> meta;

  LogContext copyWith({
    JsonMap? loggedInUser,
    List<JsonMap>? users,
    String? traceId,
    List<String>? traceIds,
    String? spanId,
    int? traceFlags,
    String? traceState,
    Map<String, String>? baggage,
    JsonMap? fields,
    String? routineId,
    List<String>? tags,
    List<Object?>? context,
    List<Object?>? meta,
  }) =>
      LogContext(
        loggedInUser: Map.unmodifiable(loggedInUser ?? this.loggedInUser),
        users: List.unmodifiable(
          (users ?? this.users).map((value) => Map.unmodifiable(value)),
        ),
        traceId: traceId ?? this.traceId,
        traceIds: List.unmodifiable(traceIds ?? this.traceIds),
        spanId: spanId ?? this.spanId,
        traceFlags: traceFlags ?? this.traceFlags,
        traceState: traceState ?? this.traceState,
        baggage: Map.unmodifiable(baggage ?? this.baggage),
        fields: Map.unmodifiable(fields ?? this.fields),
        routineId: routineId ?? this.routineId,
        tags: List.unmodifiable(tags ?? this.tags),
        context: List.unmodifiable(context ?? this.context),
        meta: List.unmodifiable(meta ?? this.meta),
      );

  LogContext copy() => copyWith();

  LogContext merge(LogContext patch) {
    final mergedTraceIds = <String>{
      if (traceId.isNotEmpty) traceId,
      ...traceIds.where((value) => value.isNotEmpty),
      if (patch.traceId.isNotEmpty) patch.traceId,
      ...patch.traceIds.where((value) => value.isNotEmpty),
    };
    return LogContext(
      loggedInUser: {...loggedInUser, ...patch.loggedInUser},
      users: [
        ...users.map((value) => Map<String, Object?>.of(value)),
        ...patch.users.map((value) => Map<String, Object?>.of(value)),
      ],
      traceId: patch.traceId.isNotEmpty ? patch.traceId : traceId,
      traceIds: mergedTraceIds.toList(growable: false),
      spanId: patch.spanId.isNotEmpty ? patch.spanId : spanId,
      traceFlags: patch.traceFlags ?? traceFlags,
      traceState: patch.traceState.isNotEmpty ? patch.traceState : traceState,
      baggage: {...baggage, ...patch.baggage},
      fields: {...fields, ...patch.fields},
      routineId: patch.routineId.isNotEmpty ? patch.routineId : routineId,
      tags: {...tags, ...patch.tags}.toList(growable: false),
      context: [...context, ...patch.context],
      meta: [...meta, ...patch.meta],
    ).copyWith();
  }
}

final Object _contextKey = Object();

class _LogContextFrame {
  _LogContextFrame(this.value);
  LogContext value;
}

LogContext? currentLogContext() {
  final value = Zone.current[_contextKey];
  if (value is _LogContextFrame) return value.value.copy();
  if (value is LogContext) return value.copy();
  return null;
}

JsonMap? currentLoggedInUser() {
  final user = currentLogContext()?.loggedInUser;
  return user == null || user.isEmpty ? null : Map.of(user);
}

R withLogContext<R>(LogContext context, R Function() callback) {
  final parent = currentLogContext();
  final value = parent == null ? context.copy() : parent.merge(context);
  return runZoned(callback, zoneValues: {_contextKey: _LogContextFrame(value)});
}

R runWithLogContext<R>(LogContext context, R Function() callback) =>
    withLogContext(context, callback);

/// Captures a defensive snapshot for queue, isolate, or callback handoff.
LogContext? captureLogContext() => currentLogContext();

R withCapturedLogContext<R>(LogContext? captured, R Function() callback) =>
    captured == null ? callback() : withLogContext(captured, callback);

R Function() bindLogContext<R>(R Function() callback) {
  final captured = captureLogContext();
  return () => withCapturedLogContext(captured, callback);
}

/// Mutates only the current Zone frame. Returns false outside a context scope.
bool updateLogContext(LogContext patch) {
  final value = Zone.current[_contextKey];
  if (value is! _LogContextFrame) return false;
  value.value = value.value.merge(patch);
  return true;
}

bool setContextLoggedInUser(JsonMap user) =>
    updateLogContext(LogContext(loggedInUser: Map.of(user)));

abstract interface class LogTransport {
  FutureOr<void> write(LogRecord record);
  FutureOr<void> flush() {}
  FutureOr<void> close() {}
}

abstract interface class OpenTelemetryLogTransport implements LogTransport {}

class MemoryTransport implements LogTransport {
  final List<LogRecord> records = [];
  bool _closed = false;

  bool get closed => _closed;

  @override
  void write(LogRecord record) {
    if (_closed) throw StateError('transport is closed');
    records.add(record);
  }

  @override
  void flush() {}

  @override
  void close() => _closed = true;
}

class LogRecord {
  const LogRecord({
    required this.id,
    required this.timestamp,
    required this.level,
    required this.runtime,
    required this.appName,
    required this.message,
    required this.values,
    required this.fields,
    this.name = '',
    this.loggedInUser = const {},
    this.users = const [],
    this.traceId = '',
    this.traceIds = const [],
    this.routineId = '',
    this.tags = const [],
    this.context = const [],
    this.meta = const [],
    this.errors = const [],
    this.stackTrace = const [],
  });

  final String id;
  final String timestamp;
  final LogLevel level;
  final String runtime;
  final String appName;
  final String name;
  final String message;
  final List<Object?> values;
  final JsonMap fields;
  final JsonMap loggedInUser;
  final List<JsonMap> users;
  final String traceId;
  final List<String> traceIds;
  final String routineId;
  final List<String> tags;
  final List<Object?> context;
  final List<Object?> meta;
  final List<Object?> errors;
  final List<String> stackTrace;

  JsonMap toJson() => {
        'schema': schema,
        'id': id,
        'timestamp': timestamp,
        'level': level.wireName,
        'runtime': runtime,
        'appName': appName,
        if (name.isNotEmpty) 'name': name,
        'message': message,
        'values': values,
        'fields': fields,
        if (loggedInUser.isNotEmpty) 'loggedInUser': loggedInUser,
        if (users.isNotEmpty) 'users': users,
        if (traceId.isNotEmpty) 'traceId': traceId,
        if (traceIds.isNotEmpty) 'traceIds': traceIds,
        if (routineId.isNotEmpty) 'routineId': routineId,
        if (tags.isNotEmpty) 'tags': tags,
        if (context.isNotEmpty) 'context': context,
        if (meta.isNotEmpty) 'meta': meta,
        if (errors.isNotEmpty) 'errors': errors,
        if (stackTrace.isNotEmpty) 'stackTrace': stackTrace,
      };

  String toJsonString() => jsonEncode(toJson());
}

class Logger {
  Logger({
    this.appName = 'app',
    this.name = '',
    this.runtime = 'dart',
    this.minimumLevel = LogLevel.info,
    this.console = true,
    bool otelEnabled = true,
    JsonMap fields = const {},
    JsonMap loggedInUser = const {},
    List<LogTransport> transports = const [],
    String Function()? idFactory,
    DateTime Function()? clock,
  })  : fields = Map.of(fields),
        currentUser = Map.of(loggedInUser),
        transports = List.of(transports),
        idFactory = idFactory ?? _randomId,
        clock = clock ?? DateTime.now,
        _otelEnabled = otelEnabled;

  final String appName;
  final String name;
  final String runtime;
  final LogLevel minimumLevel;
  final bool console;
  final JsonMap fields;
  final JsonMap currentUser;
  final List<LogTransport> transports;
  final String Function() idFactory;
  final DateTime Function() clock;
  bool _otelEnabled;
  bool _closed = false;

  Logger useOtel() {
    _otelEnabled = true;
    return this;
  }

  Logger notOtel() {
    _otelEnabled = false;
    return this;
  }

  LogEvent trace(Object? message, [List<Object?> values = const []]) =>
      _event(LogLevel.trace, message, values);
  LogEvent debug(Object? message, [List<Object?> values = const []]) =>
      _event(LogLevel.debug, message, values);
  LogEvent info(Object? message, [List<Object?> values = const []]) =>
      _event(LogLevel.info, message, values);
  LogEvent warn(Object? message, [List<Object?> values = const []]) =>
      _event(LogLevel.warn, message, values);
  LogEvent error(Object? message, [List<Object?> values = const []]) =>
      _event(LogLevel.error, message, values);
  LogEvent fatal(Object? message, [List<Object?> values = const []]) =>
      _event(LogLevel.fatal, message, values);

  LogEvent _event(LogLevel level, Object? message, List<Object?> values) {
    if (_closed) throw StateError('next-loggers logger is closed');
    return LogEvent._(this, level, [message, ...values]);
  }

  bool _enabled(LogLevel level) => level.index >= minimumLevel.index;

  Future<void> _emit(LogRecord record, bool? eventOtel) async {
    if (!_enabled(record.level)) return;
    if (console) {
      // Explicit boundary write; no console/Zone/runtime patching.
      // ignore: avoid_print
      print(
        '[${record.timestamp}] [${record.level.wireName}] '
        '[$appName] ${record.message}',
      );
    }
    final failures = <Object>[];
    for (final transport in transports) {
      if (transport is OpenTelemetryLogTransport &&
          !(eventOtel ?? _otelEnabled)) {
        continue;
      }
      try {
        await Future.sync(() => transport.write(record));
      } catch (error) {
        failures.add(error);
      }
    }
    if (failures.isNotEmpty) {
      throw StateError('next-loggers transport failures: $failures');
    }
  }

  Future<void> flush({bool throwOnError = false}) async {
    final failures = <Object>[];
    for (final transport in transports) {
      try {
        await Future.sync(transport.flush);
      } catch (error) {
        failures.add(error);
      }
    }
    if (throwOnError && failures.isNotEmpty) {
      throw StateError('next-loggers flush failed: $failures');
    }
  }

  Future<void> close() async {
    if (_closed) return;
    await flush();
    await Future.wait(
      transports.map((transport) => Future.sync(transport.close)),
    );
    _closed = true;
  }
}

class LogEvent {
  LogEvent._(this.logger, this.level, this.values);

  final Logger logger;
  final LogLevel level;
  final List<Object?> values;
  final JsonMap fields = {};
  final JsonMap loggedInUser = {};
  final List<JsonMap> users = [];
  final Set<String> traceIds = {};
  final Set<String> tags = {};
  final List<Object?> context = [];
  final List<Object?> meta = [];
  String traceId = '';
  String routineId = '';
  LogRecord? _record;
  Future<LogRecord?>? _send;
  bool? _otelEnabled;

  LogEvent addFields(JsonMap value) {
    fields.addAll(value);
    return this;
  }

  LogEvent useOtel() => withOtel(true);

  LogEvent notOtel() => withOtel(false);

  LogEvent withOtel(bool enabled) {
    _otelEnabled = enabled;
    return this;
  }

  LogEvent resetOtel() {
    _otelEnabled = null;
    return this;
  }

  bool isOtelEnabled([bool fallback = true]) => _otelEnabled ?? fallback;

  LogEvent addTrace(String value, {bool makeFirst = false}) {
    final normalized = value.trim();
    if (normalized.isEmpty) return this;
    if (traceId.isEmpty || makeFirst) traceId = normalized;
    traceIds.add(normalized);
    return this;
  }

  LogEvent addTags(Iterable<String> values) {
    tags.addAll(values.where((value) => value.trim().isNotEmpty));
    return this;
  }

  LogEvent addRoutineId(String value) {
    routineId = value;
    return this;
  }

  LogEvent addContext(Object? value) {
    context.add(value);
    return this;
  }

  LogEvent addMeta(Object? value) {
    meta.add(value);
    return this;
  }

  LogEvent setLoggedInUser(JsonMap value) {
    loggedInUser.addAll(value);
    return this;
  }

  LogEvent addUser(JsonMap value) {
    users.add(Map.of(value));
    return this;
  }

  LogRecord toRecord() {
    final cached = _record;
    if (cached != null) return cached;
    final ambient = currentLogContext();
    final mergedFields = <String, Object?>{
      ...logger.fields,
      ...?ambient?.fields,
      ...fields,
    };
    if (ambient != null) {
      if (ambient.spanId.isNotEmpty) {
        mergedFields['otel.span_id'] = ambient.spanId;
      }
      if (ambient.traceFlags != null) {
        mergedFields['otel.trace_flags'] = ambient.traceFlags;
      }
      if (ambient.traceState.isNotEmpty) {
        mergedFields['otel.trace_state'] = ambient.traceState;
      }
      if (ambient.baggage.isNotEmpty) {
        mergedFields['otel.baggage'] = Map.of(ambient.baggage);
      }
      if (traceId.isEmpty && ambient.traceId.isNotEmpty) {
        traceId = ambient.traceId;
      }
      if (ambient.traceId.isNotEmpty) traceIds.add(ambient.traceId);
      traceIds.addAll(ambient.traceIds.where((value) => value.isNotEmpty));
      if (routineId.isEmpty && ambient.routineId.isNotEmpty) {
        routineId = ambient.routineId;
      }
      tags
        ..add('otel')
        ..addAll(ambient.tags);
    }
    final normalizedValues = values.map(_normalize).toList(growable: false);
    final foundErrors = values
        .where((value) => value is Error || value is Exception)
        .map(_normalize)
        .toList(growable: false);
    final record = LogRecord(
      id: logger.idFactory(),
      timestamp: logger.clock().toUtc().toIso8601String(),
      level: level,
      runtime: logger.runtime,
      appName: logger.appName,
      name: logger.name,
      message: values.map(_messagePart).join(' '),
      values: normalizedValues,
      fields: Map.unmodifiable(mergedFields),
      loggedInUser: Map.unmodifiable({
        ...logger.currentUser,
        ...?ambient?.loggedInUser,
        ...loggedInUser,
      }),
      users: List.unmodifiable(
        [
          ...?ambient?.users,
          ...users,
        ].map((value) => Map<String, Object?>.unmodifiable(value)),
      ),
      traceId: traceId,
      traceIds: List.unmodifiable(traceIds),
      routineId: routineId,
      tags: List.unmodifiable(tags),
      context: List.unmodifiable(
        [...?ambient?.context, ...context].map(_normalize),
      ),
      meta: List.unmodifiable([...?ambient?.meta, ...meta].map(_normalize)),
      errors: foundErrors,
    );
    _record = record;
    return record;
  }

  Future<LogRecord?> send() => _send ??= _sendNow();

  Future<LogRecord?> _sendNow() async {
    final record = toRecord();
    await logger._emit(record, _otelEnabled);
    return logger._enabled(level) ? record : null;
  }
}

/// Browser/mobile client transport. The application injects a Supabase sender
/// so this package never embeds credentials or patches HTTP/WebSocket clients.
class SupabaseTransport implements LogTransport {
  SupabaseTransport({
    required this.sendBatch,
    this.batchSize = 50,
    this.flushInterval = const Duration(seconds: 1),
    this.maxQueueSize = 2000,
    this.onDrop,
  })  : assert(batchSize > 0),
        assert(maxQueueSize >= batchSize);

  final SupabaseBatchSender sendBatch;
  final int batchSize;
  final Duration flushInterval;
  final int maxQueueSize;
  final void Function(LogRecord record)? onDrop;
  final List<LogRecord> _queue = [];
  Timer? _timer;
  Future<void>? _flushing;
  bool _closed = false;

  @override
  Future<void> write(LogRecord record) async {
    if (_closed) throw StateError('Supabase transport is closed');
    if (_queue.length >= maxQueueSize) {
      final dropped = _queue.removeAt(0);
      try {
        onDrop?.call(dropped);
      } catch (_) {
        // Optional diagnostics cannot break record delivery.
      }
    }
    _queue.add(record);
    if (_queue.length >= batchSize) {
      if (_flushing == null) {
        await flush();
      }
    } else {
      _timer ??= Timer(flushInterval, () {
        _timer = null;
        unawaited(flush().catchError((_) {}));
      });
    }
  }

  @override
  Future<void> flush() {
    final active = _flushing;
    if (active != null) return active;
    _timer?.cancel();
    _timer = null;
    if (_queue.isEmpty) return Future.value();
    final batch = _queue.take(batchSize).toList(growable: false);
    _queue.removeRange(0, batch.length);
    var failed = false;
    final task = Future.sync(
      () => sendBatch(
        batch.map((record) => record.toJson()).toList(growable: false),
      ),
    ).catchError((Object error) {
      failed = true;
      final available = maxQueueSize - _queue.length;
      _queue.insertAll(0, batch.take(available));
      throw error;
    }).whenComplete(() {
      _flushing = null;
      // A failed batch stays queued for an explicit flush or a later write.
      // Retrying immediately here creates an unbounded microtask loop while a
      // device is offline or encryption is misconfigured.
      if (!failed && _queue.isNotEmpty && !_closed) {
        unawaited(flush().catchError((_) {}));
      }
    });
    _flushing = task;
    return task;
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    while (_queue.isNotEmpty || _flushing != null) {
      await flush();
    }
    _timer?.cancel();
    _timer = null;
  }
}

/// Application-owned OTEL log sink. No provider or global instrumentation is installed.
class OpenTelemetryTransport implements OpenTelemetryLogTransport {
  OpenTelemetryTransport(
    this.emit, {
    List<FutureOr<void> Function()> forceFlushCallbacks = const [],
  }) : forceFlushCallbacks = List.unmodifiable(forceFlushCallbacks) {
    if (forceFlushCallbacks.length > 32) {
      throw RangeError.range(
        forceFlushCallbacks.length,
        0,
        32,
        'forceFlushCallbacks.length',
      );
    }
  }

  final FutureOr<void> Function(JsonMap record) emit;
  final List<FutureOr<void> Function()> forceFlushCallbacks;
  Future<void>? _forceFlushOperation;

  @override
  FutureOr<void> write(LogRecord record) {
    final attributes = <String, Object?>{
      'service.name': record.appName,
      'next_logger.schema': schema,
      'next_logger.runtime': record.runtime,
      'log.record.uid': record.id,
      if (record.traceId.isNotEmpty) 'trace.id': record.traceId,
      for (final entry in record.fields.entries)
        'next_logger.field.${entry.key}': entry.value,
    };
    return emit(
      Map.unmodifiable(<String, Object?>{
        'body': record.message,
        'severityText': record.level.wireName,
        'severityNumber': const <LogLevel, int>{
          LogLevel.trace: 1,
          LogLevel.debug: 5,
          LogLevel.info: 9,
          LogLevel.warn: 13,
          LogLevel.error: 17,
          LogLevel.fatal: 21,
        }[record.level],
        'timestamp': record.timestamp,
        'attributes': Map.unmodifiable(attributes),
      }),
    );
  }

  @override
  Future<void> flush() {
    final active = _forceFlushOperation;
    if (active != null) return active;
    if (forceFlushCallbacks.isEmpty) return Future<void>.value();
    late final Future<void> operation;
    operation = Future.wait(
      forceFlushCallbacks.map((callback) => Future<void>.sync(callback)),
      eagerError: false,
    ).whenComplete(() {
      if (identical(_forceFlushOperation, operation)) {
        _forceFlushOperation = null;
      }
    });
    _forceFlushOperation = operation;
    return operation;
  }

  @override

  /// The application owns provider shutdown; Logger.close only force-flushes it.
  FutureOr<void> close() {}
}

abstract interface class OtelSpan {
  LogContext get context;
  void recordException(Object error, StackTrace stackTrace);
  void setStatus(int code, String description);
  void end();
}

/// Optional capability exposed by current OpenTelemetry span implementations.
/// Older adapters remain compatible and are treated as recording spans.
abstract interface class RecordingOtelSpan {
  bool get isRecording;
}

abstract interface class OtelTracer {
  OtelSpan startSpan(String name, JsonMap attributes);
}

class _NoopOtelSpan implements OtelSpan, RecordingOtelSpan {
  const _NoopOtelSpan();

  @override
  LogContext get context => const LogContext();
  @override
  bool get isRecording => false;
  @override
  void end() {}
  @override
  void recordException(Object error, StackTrace stackTrace) {}
  @override
  void setStatus(int code, String description) {}
}

const OtelSpan _noopOtelSpan = _NoopOtelSpan();

Future<T> withOtelSpan<T>(
  Logger logger,
  OtelTracer tracer,
  String name,
  FutureOr<T> Function(OtelSpan span) callback, {
  JsonMap attributes = const {},
}) async {
  OtelSpan span;
  try {
    span = tracer.startSpan(name, Map.of(attributes));
  } catch (error, stackTrace) {
    await _logOtelFailure(logger, name, 'start span', error, stackTrace);
    return callback(_noopOtelSpan);
  }

  LogContext context;
  try {
    context = span.context.copyWith();
  } catch (error, stackTrace) {
    await _logOtelFailure(logger, name, 'read span context', error, stackTrace);
    context = const LogContext();
  }

  final stopwatch = Stopwatch()..start();
  return runWithLogContext(context, () async {
    await _sendSafely(
      logger.debug('span started:', [name]).addFields({
        'otel.span_name': name,
        'otel.span_phase': 'start'
      }).addTags(['otel-span']),
    );
    try {
      final result = await callback(span);
      if (await _isRecordingSafely(logger, span, name)) {
        await _invokeOtelSafely(
          logger,
          name,
          'set success status',
          () => span.setStatus(1, ''),
        );
      }
      await _sendSafely(
        logger.debug('span completed:', [name]).addFields({
          'otel.span_name': name,
          'otel.span_phase': 'end',
          'otel.duration_ms': stopwatch.elapsedMicroseconds / 1000,
        }).addTags(['otel-span']),
      );
      return result;
    } catch (error, stackTrace) {
      if (await _isRecordingSafely(logger, span, name)) {
        await _invokeOtelSafely(
          logger,
          name,
          'record exception',
          () => span.recordException(error, stackTrace),
        );
        await _invokeOtelSafely(
          logger,
          name,
          'set error status',
          () => span.setStatus(2, error.toString()),
        );
      }
      await _sendSafely(
        logger.error('span failed:', [name, error]).addFields({
          'otel.span_name': name,
          'otel.span_phase': 'error',
          'otel.duration_ms': stopwatch.elapsedMicroseconds / 1000,
        }).addTags(['otel-span']),
      );
      Error.throwWithStackTrace(error, stackTrace);
    } finally {
      stopwatch.stop();
      await _invokeOtelSafely(logger, name, 'end span', span.end);
    }
  });
}

Future<bool> _isRecordingSafely(
  Logger logger,
  OtelSpan span,
  String spanName,
) async {
  if (span is! RecordingOtelSpan) return true;
  try {
    return (span as RecordingOtelSpan).isRecording;
  } catch (error, stackTrace) {
    await _logOtelFailure(
      logger,
      spanName,
      'read recording state',
      error,
      stackTrace,
    );
    return false;
  }
}

Future<void> _invokeOtelSafely(
  Logger logger,
  String spanName,
  String operation,
  FutureOr<void> Function() callback,
) async {
  try {
    await Future.sync(callback);
  } catch (error, stackTrace) {
    await _logOtelFailure(logger, spanName, operation, error, stackTrace);
  }
}

Future<void> _logOtelFailure(
  Logger logger,
  String spanName,
  String operation,
  Object error,
  StackTrace stackTrace,
) =>
    _sendSafely(
      logger.warn('OpenTelemetry $operation failed:', [error]).addFields({
        'otel.bridge_operation': operation,
        'otel.span_name': spanName,
      }).addTags(['otel-span', 'otel-bridge-error']).addMeta(
          stackTrace.toString()),
    );

Future<void> _sendSafely(LogEvent event) async {
  try {
    await event.send();
  } catch (_) {
    // Telemetry failure must not replace the application result.
  }
}

String _randomId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

Object? _normalize(Object? value) {
  if (value == null || value is String || value is num || value is bool) {
    return value;
  }
  if (value is Error || value is Exception) {
    return {'name': value.runtimeType.toString(), 'message': value.toString()};
  }
  if (value is Map) {
    return value.map(
      (key, entry) => MapEntry(key.toString(), _normalize(entry)),
    );
  }
  if (value is Iterable) return value.map(_normalize).toList(growable: false);
  return value.toString();
}

String _messagePart(Object? value) {
  if (value is String) return value;
  if (value is Error || value is Exception) return value.toString();
  return jsonEncode(_normalize(value));
}
