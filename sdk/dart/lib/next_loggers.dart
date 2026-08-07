import 'dart:async';
import 'dart:convert';
import 'dart:math';

const String nextLoggersSchema = 'next-loggers/v1';
final Object _contextZoneKey = Object();

enum LogLevel { trace, debug, info, warn, error, fatal }

extension LogLevelWire on LogLevel {
  String get wire => name.toUpperCase();

  int get otelSeverityNumber => switch (this) {
        LogLevel.trace => 1,
        LogLevel.debug => 5,
        LogLevel.info => 9,
        LogLevel.warn => 13,
        LogLevel.error => 17,
        LogLevel.fatal => 21,
      };
}

class LogContext {
  const LogContext({
    this.traceId,
    this.spanId,
    this.traceFlags = 0,
    this.traceState,
    this.fields = const <String, Object?>{},
    this.tags = const <String>[],
  });

  final String? traceId;
  final String? spanId;
  final int traceFlags;
  final String? traceState;
  final Map<String, Object?> fields;
  final List<String> tags;
}

LogContext? get currentLogContext => Zone.current[_contextZoneKey] as LogContext?;

R withLogContext<R>(LogContext context, R Function() callback) {
  return runZoned(callback, zoneValues: <Object, Object?>{_contextZoneKey: context});
}

typedef RecordSender = FutureOr<void> Function(Map<String, Object?> record);

abstract interface class LogTransport {
  FutureOr<void> write(Map<String, Object?> record);
}

/// Aggregates transport failures after every configured sink has received the record.
final class LogTransportException implements Exception {
  LogTransportException(List<Object> errors, List<StackTrace> stackTraces)
      : errors = List<Object>.unmodifiable(errors),
        stackTraces = List<StackTrace>.unmodifiable(stackTraces);

  final List<Object> errors;
  final List<StackTrace> stackTraces;

  @override
  String toString() => 'LogTransportException(${errors.join(', ')})';
}

/// Application-owned OTEL sink. This package never registers a global SDK.
final class OpenTelemetryTransport implements LogTransport {
  OpenTelemetryTransport(this.emit);

  final RecordSender emit;

  @override
  FutureOr<void> write(Map<String, Object?> record) {
    final level = LogLevel.values.firstWhere(
      (value) => value.wire == record['level'],
    );
    final fields = (record['fields'] as Map<String, Object?>?) ?? const {};
    final attributes = <String, Object?>{
      'service.name': record['appName'],
      'next_logger.schema': record['schema'],
      'next_logger.runtime': record['runtime'],
      'log.record.uid': record['id'],
      if (record['traceId'] != null) 'trace.id': record['traceId'],
      for (final entry in fields.entries) 'next_logger.field.${entry.key}': entry.value,
    };
    return emit(_freezeMap(<String, Object?>{
      'body': record['message'],
      'severityText': level.wire,
      'severityNumber': level.otelSeverityNumber,
      'timestamp': record['timestamp'],
      'attributes': attributes,
    }));
  }
}

/// Flutter/browser-safe Supabase transport with an injected authenticated sender.
final class SupabaseTransport implements LogTransport {
  SupabaseTransport(this.send);

  final RecordSender send;

  @override
  FutureOr<void> write(Map<String, Object?> record) => send(record);
}

final class Logger {
  Logger({
    required this.appName,
    this.name,
    this.runtime = 'dart',
    Map<String, Object?> fields = const <String, Object?>{},
    List<LogTransport> transports = const <LogTransport>[],
    String Function()? idFactory,
    String Function()? clock,
  })  : fields = _freezeMap(fields),
        transports = List<LogTransport>.unmodifiable(transports),
        _idFactory = idFactory ?? _randomId,
        _clock = clock ?? (() => DateTime.now().toUtc().toIso8601String());

  final String appName;
  final String? name;
  final String runtime;
  final Map<String, Object?> fields;
  final List<LogTransport> transports;
  final String Function() _idFactory;
  final String Function() _clock;

  Future<Map<String, Object?>> log(
    LogLevel level,
    String message, {
    Map<String, Object?> eventFields = const <String, Object?>{},
    List<Object?> values = const <Object?>[],
  }) async {
    if (appName.trim().isEmpty) {
      throw ArgumentError.value(appName, 'appName', 'must not be empty');
    }
    final context = currentLogContext;
    final mergedFields = <String, Object?>{
      ...fields,
      ...?context?.fields,
      if (context?.spanId != null) 'otel.span_id': context!.spanId,
      if (context != null) 'otel.trace_flags': context.traceFlags,
      if (context?.traceState != null) 'otel.trace_state': context!.traceState,
      ...eventFields,
    };
    final traceId = context?.traceId;
    final record = <String, Object?>{
      'schema': nextLoggersSchema,
      'id': _idFactory(),
      'timestamp': _clock(),
      'level': level.wire,
      'runtime': runtime,
      'appName': appName,
      if (name != null && name!.isNotEmpty) 'name': name,
      'message': message,
      'values': values.isEmpty ? <Object?>[message] : List<Object?>.from(values),
      'fields': mergedFields,
      if (traceId != null && traceId.isNotEmpty) 'traceId': traceId,
      if (traceId != null && traceId.isNotEmpty) 'traceIds': <String>[traceId],
      if (context != null && context.tags.isNotEmpty) 'tags': List<String>.from(context.tags),
    };
    final immutable = _freezeMap(record);
    final errors = <Object>[];
    final stackTraces = <StackTrace>[];
    for (final transport in transports) {
      try {
        await transport.write(immutable);
      } catch (error, stackTrace) {
        errors.add(error);
        stackTraces.add(stackTrace);
      }
    }
    if (errors.isNotEmpty) {
      throw LogTransportException(errors, stackTraces);
    }
    return immutable;
  }

  Future<Map<String, Object?>> info(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.info, message, eventFields: fields);

  Future<Map<String, Object?>> error(
    String message, {
    Map<String, Object?> fields = const <String, Object?>{},
  }) =>
      log(LogLevel.error, message, eventFields: fields);

  static String _randomId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
  }
}

Map<String, Object?> _freezeMap(Map<String, Object?> value) {
  return Map<String, Object?>.unmodifiable(
    value.map((key, item) => MapEntry(key, _freeze(item))),
  );
}

Object? _freeze(Object? value) {
  if (value is Map<String, Object?>) return _freezeMap(value);
  if (value is Map) {
    return Map<String, Object?>.unmodifiable(
      value.map((key, item) => MapEntry(key.toString(), _freeze(item))),
    );
  }
  if (value is Iterable) {
    return List<Object?>.unmodifiable(value.map(_freeze));
  }
  return value;
}
