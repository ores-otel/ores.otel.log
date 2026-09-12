/// `.ores-otel.toml` v1 configuration: a strict, fail-closed TOML-subset
/// reader, contract validation, and deterministic layered resolution.
///
/// Everything in this file is pure (no `dart:io`); file discovery lives in
/// `ores_otel_config_io.dart`. See `docs/ores-otel-config.md` for the spec.
///
/// Resolution precedence:
/// `defaults < common < selected role < env < flagOverrides < overrides`.
library;

import 'dart:convert';

const String oresOtelConfigBasename = '.ores-otel.toml';
const int oresOtelConfigVersion = 1;

/// Thrown for every malformed file, environment value, flag, or override.
class OresOtelConfigException extends FormatException {
  const OresOtelConfigException(String message) : super(message);

  @override
  String toString() => 'OresOtelConfigException: $message';
}

Never _fail(String message) => throw OresOtelConfigException(message);

// ---------------------------------------------------------------------------
// Strict TOML subset
// ---------------------------------------------------------------------------

/// Parses the TOML subset `.ores-otel.toml` uses and returns a deeply
/// unmodifiable table.
///
/// Supported: `[table]` / `[dotted.table]` headers, bare and basic-quoted
/// keys, basic strings (with `\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`),
/// integers, floats, booleans, single- or multi-line arrays of only strings or
/// only numbers, and comments. Everything else (inline tables, arrays of
/// tables, dotted keys, literal/multi-line strings, dates, nested or mixed
/// arrays, duplicate keys or tables) throws [OresOtelConfigException].
Map<String, Object> parseTomlSubset(String input) =>
    _freeze(_TomlReader(input).read()) as Map<String, Object>;

Object _freeze(Object value) => switch (value) {
      Map<String, Object> table => Map<String, Object>.unmodifiable({
          for (final entry in table.entries) entry.key: _freeze(entry.value),
        }),
      List<Object> list => List<Object>.unmodifiable(list.map(_freeze)),
      _ => value,
    };

final _tomlInteger = RegExp(r'^[+-]?(0|[1-9][0-9]*)$');
final _tomlFloat =
    RegExp(r'^[+-]?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$');
final _hexDigits = RegExp(r'^[0-9A-Fa-f]+$');

/// HOT-PATH (imperative by design): a cursor-based scanner. The mutable
/// cursor and tables are private to one `read()` call, whose result is frozen
/// before it escapes.
class _TomlReader {
  _TomlReader(String input)
      : _src = input.startsWith('﻿') ? input.substring(1) : input;

  final String _src;
  final Map<String, Object> _root = {};
  final Set<Map<String, Object>> _definedTables = Set.identity();
  int _pos = 0;

  bool get _eof => _pos >= _src.length;
  String get _ch => _src[_pos];
  bool get _atNewline => !_eof && (_ch == '\n' || _ch == '\r');

  Never _error(String message) {
    final line = '\n'.allMatches(_src.substring(0, _pos)).length + 1;
    _fail('invalid TOML: $message (line $line)');
  }

  Map<String, Object> read() {
    var current = _root;
    while (true) {
      _skipSpaces();
      _skipComment();
      if (_eof) return _root;
      if (_atNewline) {
        _consumeNewline();
        continue;
      }
      if (_ch == '[') {
        current = _tableHeader();
      } else {
        _keyValue(current);
      }
      _endOfLine();
    }
  }

  void _skipSpaces() {
    while (!_eof && (_ch == ' ' || _ch == '\t')) {
      _pos++;
    }
  }

  void _skipComment() {
    if (_eof || _ch != '#') return;
    while (!_eof && !_atNewline) {
      _pos++;
    }
  }

  void _consumeNewline() {
    if (_ch == '\r') {
      if (_pos + 1 < _src.length && _src[_pos + 1] == '\n') {
        _pos += 2;
        return;
      }
      _error('bare carriage return');
    }
    _pos++;
  }

  void _endOfLine() {
    _skipSpaces();
    _skipComment();
    if (_eof) return;
    if (!_atNewline) _error('unexpected content after value');
    _consumeNewline();
  }

  Map<String, Object> _tableHeader() {
    _pos++;
    if (!_eof && _ch == '[') _error('arrays of tables are not supported');
    _skipSpaces();
    final path = <String>[_key()];
    _skipSpaces();
    while (!_eof && _ch == '.') {
      _pos++;
      _skipSpaces();
      path.add(_key());
      _skipSpaces();
    }
    if (_eof || _ch != ']') _error('unterminated table header');
    _pos++;
    var node = _root;
    for (final segment in path) {
      final existing = node[segment];
      if (existing == null) {
        final created = <String, Object>{};
        node[segment] = created;
        node = created;
      } else if (existing is Map<String, Object>) {
        node = existing;
      } else {
        _error('"$segment" is already a value, not a table');
      }
    }
    if (!_definedTables.add(node)) {
      _error('table [${path.join('.')}] is defined more than once');
    }
    return node;
  }

  String _key() {
    if (_eof) _error('missing key');
    if (_ch == '"') {
      if (_src.startsWith('"""', _pos)) _error('multi-line keys');
      return _basicString();
    }
    if (_ch == "'") _error('literal strings are not supported');
    final start = _pos;
    while (!_eof && _isBareKeyUnit(_src.codeUnitAt(_pos))) {
      _pos++;
    }
    if (start == _pos) _error('invalid key');
    return _src.substring(start, _pos);
  }

  static bool _isBareKeyUnit(int c) =>
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c == 0x5f ||
      c == 0x2d;

  static bool _isScalarUnit(int c) =>
      _isBareKeyUnit(c) || c == 0x2b || c == 0x2e || c == 0x3a;

  void _keyValue(Map<String, Object> table) {
    final key = _key();
    _skipSpaces();
    if (!_eof && _ch == '.') _error('dotted keys are not supported');
    if (_eof || _ch != '=') _error('expected "=" after key "$key"');
    _pos++;
    _skipSpaces();
    if (table.containsKey(key)) _error('duplicate key "$key"');
    table[key] = _value(allowArray: true);
  }

  Object _value({required bool allowArray}) {
    if (_eof || _atNewline) _error('missing value');
    switch (_ch) {
      case '"':
        if (_src.startsWith('"""', _pos)) {
          _error('multi-line strings are not supported');
        }
        return _basicString();
      case "'":
        _error('literal strings are not supported');
      case '{':
        _error('inline tables are not supported');
      case '[':
        if (!allowArray) _error('nested arrays are not supported');
        return _array();
    }
    final start = _pos;
    while (!_eof && _isScalarUnit(_src.codeUnitAt(_pos))) {
      _pos++;
    }
    final token = _src.substring(start, _pos);
    if (token == 'true') return true;
    if (token == 'false') return false;
    if (_tomlInteger.hasMatch(token)) {
      return int.tryParse(token) ?? _error('integer out of range: $token');
    }
    if (_tomlFloat.hasMatch(token) &&
        (token.contains('.') || token.contains('e') || token.contains('E'))) {
      final parsed = double.parse(token);
      if (!parsed.isFinite) _error('float out of range: $token');
      return parsed;
    }
    _error('unsupported value "$token"');
  }

  List<Object> _array() {
    _pos++;
    final items = <Object>[];
    while (true) {
      _skipArrayTrivia();
      if (_eof) _error('unterminated array');
      if (_ch == ']') break;
      items.add(_value(allowArray: false));
      _skipArrayTrivia();
      if (_eof) _error('unterminated array');
      if (_ch == ',') {
        _pos++;
        continue;
      }
      if (_ch != ']') _error('expected "," or "]" in array');
      break;
    }
    _pos++;
    final allStrings = items.every((item) => item is String);
    final allNumbers = items.every((item) => item is num);
    if (!allStrings && !allNumbers) {
      _error('arrays must contain only strings or only numbers');
    }
    return items;
  }

  void _skipArrayTrivia() {
    while (true) {
      _skipSpaces();
      _skipComment();
      if (!_atNewline) return;
      _consumeNewline();
    }
  }

  String _basicString() {
    _pos++;
    final out = StringBuffer();
    while (true) {
      if (_eof || _atNewline) _error('unterminated string');
      final char = _ch;
      _pos++;
      if (char == '"') return out.toString();
      if (char == r'\') {
        if (_eof) _error('unterminated string');
        final escape = _ch;
        _pos++;
        switch (escape) {
          case 'b':
            out.write('\b');
          case 't':
            out.write('\t');
          case 'n':
            out.write('\n');
          case 'f':
            out.write('\f');
          case 'r':
            out.write('\r');
          case '"':
            out.write('"');
          case r'\':
            out.write(r'\');
          case 'u':
            out.writeCharCode(_unicodeEscape(4));
          case 'U':
            out.writeCharCode(_unicodeEscape(8));
          default:
            _error('unsupported escape \\$escape');
        }
        continue;
      }
      final unit = char.codeUnitAt(0);
      if ((unit < 0x20 && unit != 0x09) || unit == 0x7f) {
        _error('control character in string');
      }
      out.write(char);
    }
  }

  int _unicodeEscape(int digits) {
    if (_pos + digits > _src.length) _error('truncated unicode escape');
    final hex = _src.substring(_pos, _pos + digits);
    if (!_hexDigits.hasMatch(hex)) _error('invalid unicode escape');
    final scalar = int.parse(hex, radix: 16);
    if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
      _error('invalid unicode scalar value');
    }
    _pos += digits;
    return scalar;
  }
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

enum OresOtelRuntimeRole { client, server }

enum OresOtelRole { client, server, shared }

enum OresOtelLogLevel { trace, debug, info, warn, error, fatal }

enum OresOtelExporterProtocol {
  none('none'),
  otlpHttp('otlp_http'),
  otlpGrpc('otlp_grpc');

  const OresOtelExporterProtocol(this.wireName);
  final String wireName;
}

enum OresOtelPropagator { tracecontext, baggage }

// ---------------------------------------------------------------------------
// Contract validation (snake_case layers)
// ---------------------------------------------------------------------------

final _envName = RegExp(r'^[A-Z][A-Z0-9_]{0,127}$');
final _sensitiveKey = RegExp(
  r'(?:authorization|token|secret|password|cookie|api[_-]?key|private[_-]?key|headers?)',
  caseSensitive: false,
);

const _rootKeys = {'version', 'common', 'client', 'server'};
const _layerKeys = {
  'enabled',
  'service_name',
  'environment',
  'logging',
  'tracing',
  'metrics',
  'exporter',
};
const _loggingKeys = {'enabled', 'level', 'console', 'auto_send'};
const _tracingKeys = {'enabled', 'sample_ratio', 'propagators'};
const _exporterKeys = {'protocol', 'endpoint_env'};
const _metricsBools = [
  'enabled',
  'exemplars',
  'span_metrics',
  'service_graphs'
];
const _metricsKeys = {
  ..._metricsBools,
  'process',
  'filesystem',
  'latency',
  'runtime',
  'saturation',
};
const _processBools = [
  'enabled',
  'rss_bytes',
  'virtual_memory_bytes',
  'heap_bytes',
  'cpu_seconds',
  'thread_count',
  'open_file_descriptors',
];
const _filesystemBools = [
  'enabled',
  'capacity_bytes',
  'free_bytes',
  'free_ratio',
  'inode_free_ratio',
];
const _latencyBools = [
  'enabled',
  'request_duration_ms',
  'operation_duration_ms',
  'queue_wait_ms',
  'event_loop_lag_ms',
];
const _runtimeBools = [
  'enabled',
  'gc_pause_ms',
  'gc_heap_bytes',
  'event_loop_utilization',
  'scheduler_queue_depth',
];
const _saturationRatios = [
  'cpu_ratio_warning',
  'memory_ratio_warning',
  'disk_free_ratio_warning',
];

Map<String, Object?> _table(Object? value, String path, Set<String> allowed) {
  if (value is! Map) _fail('$path must be a TOML table');
  for (final key in value.keys) {
    if (key is! String) _fail('$path keys must be strings');
    if (_sensitiveKey.hasMatch(key)) {
      _fail('$path.$key is forbidden: credentials and secret-shaped settings '
          'do not belong in .ores-otel.toml');
    }
    if (!allowed.contains(key)) {
      _fail('$path.$key is not a supported .ores-otel.toml v1 key');
    }
  }
  return value.cast<String, Object?>();
}

Map<String, Object> _bools(
  Map<String, Object?> table,
  String path,
  List<String> names,
) =>
    {
      for (final name in names)
        if (table[name] case final value?)
          name: value is bool ? value : _fail('$path.$name must be a boolean'),
    };

String? _string(Map<String, Object?> table, String key, String path, int max) {
  final value = table[key];
  if (value == null) return null;
  if (value is! String) _fail('$path.$key must be a string');
  final normalized = value.trim();
  if (normalized.isEmpty || normalized.length > max) {
    _fail('$path.$key must contain 1..$max non-whitespace characters');
  }
  return normalized;
}

num? _number(
  Map<String, Object?> table,
  String key,
  String path, {
  required num min,
  num? max,
  bool integer = false,
}) {
  final value = table[key];
  if (value == null) return null;
  if (integer ? value is! int : (value is! num || !value.isFinite)) {
    _fail('$path.$key must be ${integer ? 'an integer' : 'a finite number'}');
  }
  final number = value as num;
  if (number < min || (max != null && number > max)) {
    _fail('$path.$key must be between $min and ${max ?? 'infinity'}');
  }
  return number;
}

List<Object?>? _list(Map<String, Object?> table, String key, String path) {
  final value = table[key];
  if (value == null) return null;
  if (value is! List) _fail('$path.$key must be an array');
  return value;
}

Map<String, Object> _logging(Object? value, String path) {
  final table = _table(value, path, _loggingKeys);
  final level = _string(table, 'level', path, 16)?.toLowerCase();
  if (level != null && !OresOtelLogLevel.values.any((l) => l.name == level)) {
    _fail('$path.level must be trace|debug|info|warn|error|fatal');
  }
  return {
    ..._bools(table, path, const ['enabled', 'console', 'auto_send']),
    if (level != null) 'level': level,
  };
}

Map<String, Object> _tracing(Object? value, String path) {
  final table = _table(value, path, _tracingKeys);
  final ratio = _number(table, 'sample_ratio', path, min: 0, max: 1);
  final raw = _list(table, 'propagators', path);
  final propagators = raw?.map((item) {
    if (item is! String) _fail('$path.propagators must be an array of strings');
    final normalized = item.trim().toLowerCase();
    if (!OresOtelPropagator.values.any((p) => p.name == normalized)) {
      _fail('$path.propagators contains unsupported value $normalized');
    }
    return normalized;
  }).toList();
  if (propagators != null) {
    if (propagators.length > 8) {
      _fail('$path.propagators may contain at most 8 entries');
    }
    if (propagators.toSet().length != propagators.length) {
      _fail('$path.propagators must not contain duplicates');
    }
  }
  return {
    ..._bools(table, path, const ['enabled']),
    if (ratio != null) 'sample_ratio': ratio,
    if (propagators != null)
      'propagators': List<String>.unmodifiable(propagators),
  };
}

Map<String, Object> _exporter(Object? value, String path) {
  final table = _table(value, path, _exporterKeys);
  final protocol = _string(table, 'protocol', path, 32)?.toLowerCase();
  if (protocol != null &&
      !OresOtelExporterProtocol.values.any((p) => p.wireName == protocol)) {
    _fail('$path.protocol must be none|otlp_http|otlp_grpc');
  }
  final endpointEnv = _string(table, 'endpoint_env', path, 128);
  if (endpointEnv != null && !_envName.hasMatch(endpointEnv)) {
    _fail('$path.endpoint_env must be an uppercase environment-variable name');
  }
  return {
    if (protocol != null) 'protocol': protocol,
    if (endpointEnv != null) 'endpoint_env': endpointEnv,
  };
}

Map<String, Object> _process(Object? value, String path) {
  final table = _table(
    value,
    path,
    {..._processBools, 'sample_interval_ms'},
  );
  final interval = _number(
    table,
    'sample_interval_ms',
    path,
    min: 100,
    max: 3600000,
    integer: true,
  );
  return {
    ..._bools(table, path, _processBools),
    if (interval != null) 'sample_interval_ms': interval,
  };
}

Map<String, Object> _filesystem(Object? value, String path) {
  final table = _table(value, path, {
    ..._filesystemBools,
    'paths',
    'min_free_bytes',
    'min_free_ratio',
    'min_inode_free_ratio',
  });
  final paths = _list(table, 'paths', path)?.map((item) {
    if (item is! String || item.trim().isEmpty) {
      _fail('$path.paths must contain non-empty strings');
    }
    return item;
  }).toList();
  if (paths != null) {
    if (paths.isEmpty || paths.length > 32) {
      _fail('$path.paths must contain 1..32 entries');
    }
    if (paths.toSet().length != paths.length) {
      _fail('$path.paths must not contain duplicates');
    }
  }
  final minFreeBytes =
      _number(table, 'min_free_bytes', path, min: 0, integer: true);
  final minFreeRatio = _number(table, 'min_free_ratio', path, min: 0, max: 1);
  final minInodeFreeRatio =
      _number(table, 'min_inode_free_ratio', path, min: 0, max: 1);
  return {
    ..._bools(table, path, _filesystemBools),
    if (paths != null) 'paths': List<String>.unmodifiable(paths),
    if (minFreeBytes != null) 'min_free_bytes': minFreeBytes,
    if (minFreeRatio != null) 'min_free_ratio': minFreeRatio,
    if (minInodeFreeRatio != null) 'min_inode_free_ratio': minInodeFreeRatio,
  };
}

/// Validates latency histogram boundaries: 1..32 finite values, each > 0,
/// strictly increasing. Returns an unmodifiable copy.
List<double> validateHistogramBoundaries(Iterable<Object?> raw, String path) {
  final boundaries = raw.map((item) {
    if (item is! num || !item.isFinite || item <= 0) {
      _fail('$path must contain finite numbers greater than 0');
    }
    return item.toDouble();
  }).toList();
  if (boundaries.isEmpty || boundaries.length > 32) {
    _fail('$path must contain 1..32 entries');
  }
  for (var index = 1; index < boundaries.length; index++) {
    if (boundaries[index] <= boundaries[index - 1]) {
      _fail('$path must be strictly increasing');
    }
  }
  return List<double>.unmodifiable(boundaries);
}

Map<String, Object> _latency(Object? value, String path) {
  final table =
      _table(value, path, {..._latencyBools, 'histogram_boundaries_ms'});
  final raw = _list(table, 'histogram_boundaries_ms', path);
  return {
    ..._bools(table, path, _latencyBools),
    if (raw != null)
      'histogram_boundaries_ms':
          validateHistogramBoundaries(raw, '$path.histogram_boundaries_ms'),
  };
}

Map<String, Object> _saturation(Object? value, String path) {
  final table = _table(
    value,
    path,
    {'enabled', ..._saturationRatios, 'queue_depth_warning'},
  );
  final queueDepth =
      _number(table, 'queue_depth_warning', path, min: 0, integer: true);
  return {
    ..._bools(table, path, const ['enabled']),
    for (final name in _saturationRatios)
      if (_number(table, name, path, min: 0, max: 1) case final ratio?)
        name: ratio,
    if (queueDepth != null) 'queue_depth_warning': queueDepth,
  };
}

Map<String, Object> _metrics(Object? value, String path) {
  final table = _table(value, path, _metricsKeys);
  final sections = <String, Map<String, Object> Function(Object?, String)>{
    'process': _process,
    'filesystem': _filesystem,
    'latency': _latency,
    'runtime': (v, p) => _bools(_table(v, p, _runtimeBools.toSet()), p,
        _runtimeBools), // runtime is booleans only
    'saturation': _saturation,
  };
  return {
    ..._bools(table, path, _metricsBools),
    for (final MapEntry(:key, value: parse) in sections.entries)
      if (table[key] case final section?)
        key: Map<String, Object>.unmodifiable(parse(section, '$path.$key')),
  };
}

Map<String, Object> _layer(Object? value, String path) {
  final table = _table(value, path, _layerKeys);
  final sections = <String, Map<String, Object> Function(Object?, String)>{
    'logging': _logging,
    'tracing': _tracing,
    'metrics': _metrics,
    'exporter': _exporter,
  };
  return Map<String, Object>.unmodifiable({
    ..._bools(table, path, const ['enabled']),
    if (_string(table, 'service_name', path, 256) case final name?)
      'service_name': name,
    if (_string(table, 'environment', path, 128) case final environment?)
      'environment': environment,
    for (final MapEntry(:key, value: parse) in sections.entries)
      if (table[key] case final section?)
        key: Map<String, Object>.unmodifiable(parse(section, '$path.$key')),
  });
}

/// The validated, normalized snake_case object parsed from a file.
class OresOtelFileConfig {
  const OresOtelFileConfig._({this.common, this.client, this.server});

  /// The value used when no `.ores-otel.toml` file exists.
  static const OresOtelFileConfig empty = OresOtelFileConfig._();

  final int version = oresOtelConfigVersion;
  final Map<String, Object>? common;
  final Map<String, Object>? client;
  final Map<String, Object>? server;

  Map<String, Object> toJson() => {
        'version': version,
        if (common case final layer?) 'common': layer,
        if (client case final layer?) 'client': layer,
        if (server case final layer?) 'server': layer,
      };
}

/// Strictly parses `.ores-otel.toml` text and applies the v1 contract checks.
OresOtelFileConfig parseOresOtelToml(String input) {
  final root = _table(parseTomlSubset(input), 'root', _rootKeys);
  if (root['version'] != oresOtelConfigVersion || root['version'] is! int) {
    _fail('root.version must equal $oresOtelConfigVersion');
  }
  Map<String, Object>? layer(String name) =>
      root[name] == null ? null : _layer(root[name], name);
  return OresOtelFileConfig._(
    common: layer('common'),
    client: layer('client'),
    server: layer('server'),
  );
}

// ---------------------------------------------------------------------------
// Environment and flags-2-env overrides
// ---------------------------------------------------------------------------

typedef _EnvParser = Object Function(String raw, String name);

final _envIntegerPattern = RegExp(r'^[+-]?[0-9]+$');
final _envNumberPattern =
    RegExp(r'^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$');

Object _envBool(String raw, String name) => switch (raw.trim().toLowerCase()) {
      '1' || 'true' || 'yes' || 'on' => true,
      '0' || 'false' || 'no' || 'off' => false,
      _ => _fail('$name must be true/false, 1/0, yes/no, or on/off'),
    };

Object _envString(String raw, String name) => raw;

Object _envInteger(String raw, String name) {
  final trimmed = raw.trim();
  final parsed =
      _envIntegerPattern.hasMatch(trimmed) ? int.tryParse(trimmed) : null;
  return parsed ?? _fail('$name must be an integer');
}

num _parseEnvNumber(String raw, String name) {
  final trimmed = raw.trim();
  final parsed =
      _envNumberPattern.hasMatch(trimmed) ? double.tryParse(trimmed) : null;
  if (parsed == null || !parsed.isFinite) _fail('$name must be a number');
  return parsed;
}

Object _envNumber(String raw, String name) => _parseEnvNumber(raw, name);

/// A JSON array (what flags-2-env emits) or a comma-separated list.
List<Object?> _envArrayItems(String raw, String name) {
  final trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    final Object? decoded;
    try {
      decoded = jsonDecode(trimmed);
    } on FormatException {
      _fail('$name must be a JSON array or a comma-separated list');
    }
    if (decoded is! List) _fail('$name must be a JSON array');
    return decoded;
  }
  final items = trimmed.split(',').map((item) => item.trim()).toList();
  if (items.any((item) => item.isEmpty)) {
    _fail('$name must not contain empty list entries');
  }
  return items;
}

Object _envStringArray(String raw, String name) =>
    _envArrayItems(raw, name).map((item) {
      if (item is! String) _fail('$name must contain strings');
      return item;
    }).toList();

Object _envNumberArray(String raw, String name) =>
    _envArrayItems(raw, name).map((item) {
      return switch (item) {
        num number => number,
        String text => _parseEnvNumber(text, name),
        _ => _fail('$name must contain numbers'),
      };
    }).toList();

Object _envPropagators(String raw, String name) {
  final items = raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .where((item) => item.isNotEmpty)
      .toList();
  if (items.isEmpty) {
    _fail('$name must be a comma-separated subset of tracecontext,baggage');
  }
  return items;
}

Map<String, Object> _fromEnv(
  Map<String, String> env,
  Map<String, (String, _EnvParser)> spec,
) =>
    {
      for (final MapEntry(:key, value: (name, parse)) in spec.entries)
        if (env[name] case final raw?) key: parse(raw, name),
    };

Map<String, Object> _nonEmpty(Map<String, Map<String, Object>> sections) => {
      for (final MapEntry(:key, :value) in sections.entries)
        if (value.isNotEmpty) key: value,
    };

/// Returns `env` with `flagOverrides` applied on top (flags win).
Map<String, String> effectiveOresOtelEnv(
  Map<String, String> env,
  Map<String, String> flagOverrides,
) =>
    Map<String, String>.unmodifiable({...env, ...flagOverrides});

Map<String, Object> _envLayer(Map<String, String> env) {
  const prefix = 'ORES_OTEL_';
  const metricsPrefix = '${prefix}METRICS_';
  final metrics = {
    ..._fromEnv(env, {'enabled': ('${metricsPrefix}ENABLED', _envBool)}),
    ..._nonEmpty({
      'process': _fromEnv(env, {
        'enabled': ('${metricsPrefix}PROCESS_ENABLED', _envBool),
        'sample_interval_ms': (
          '${metricsPrefix}SAMPLE_INTERVAL_MS',
          _envInteger
        ),
      }),
      'filesystem': _fromEnv(env, {
        'enabled': ('${metricsPrefix}FILESYSTEM_ENABLED', _envBool),
        'paths': ('${metricsPrefix}FILESYSTEM_PATHS', _envStringArray),
        'min_free_bytes': ('${metricsPrefix}MIN_FREE_BYTES', _envInteger),
        'min_free_ratio': ('${metricsPrefix}MIN_FREE_RATIO', _envNumber),
      }),
      'latency': _fromEnv(env, {
        'enabled': ('${metricsPrefix}LATENCY_ENABLED', _envBool),
        'histogram_boundaries_ms': (
          '${metricsPrefix}HISTOGRAM_BOUNDARIES_MS',
          _envNumberArray
        ),
      }),
      'runtime': _fromEnv(env, {
        'enabled': ('${metricsPrefix}RUNTIME_ENABLED', _envBool),
      }),
      'saturation': _fromEnv(env, {
        'enabled': ('${metricsPrefix}SATURATION_ENABLED', _envBool),
        'memory_ratio_warning': (
          '${metricsPrefix}MEMORY_RATIO_WARNING',
          _envNumber
        ),
      }),
    }),
  };
  final raw = {
    ..._fromEnv(env, {
      'enabled': ('${prefix}ENABLED', _envBool),
      'service_name': ('${prefix}SERVICE_NAME', _envString),
      'environment': ('${prefix}ENVIRONMENT', _envString),
    }),
    ..._nonEmpty({
      'logging': _fromEnv(env, {
        'enabled': ('${prefix}LOGGING_ENABLED', _envBool),
        'level': ('${prefix}LOG_LEVEL', _envString),
        'console': ('${prefix}LOG_CONSOLE', _envBool),
        'auto_send': ('${prefix}LOG_AUTO_SEND', _envBool),
      }),
      'tracing': _fromEnv(env, {
        'enabled': ('${prefix}TRACING_ENABLED', _envBool),
        'sample_ratio': ('${prefix}TRACE_SAMPLE_RATIO', _envNumber),
        'propagators': ('${prefix}PROPAGATORS', _envPropagators),
      }),
      'metrics': metrics,
      'exporter': _fromEnv(env, {
        'protocol': ('${prefix}EXPORTER_PROTOCOL', _envString),
        'endpoint_env': ('${prefix}EXPORTER_ENDPOINT_ENV', _envString),
      }),
    }),
  };
  try {
    return _layer(raw, 'env');
  } on OresOtelConfigException catch (error) {
    _fail('ORES_OTEL_* environment/flag override rejected: ${error.message}');
  }
}

OresOtelRuntimeRole? _requestedRole(
  Map<String, String> env,
  OresOtelRuntimeRole? explicit,
) {
  if (explicit != null) return explicit;
  final raw = env['ORES_OTEL_ROLE']?.trim().toLowerCase();
  return switch (raw) {
    null || '' => null,
    'client' => OresOtelRuntimeRole.client,
    'server' => OresOtelRuntimeRole.server,
    _ => _fail('ORES_OTEL_ROLE must be client or server'),
  };
}

OresOtelRole _selectRole(
  OresOtelFileConfig parsed,
  OresOtelRuntimeRole? requested,
) {
  final hasClient = parsed.client != null;
  final hasServer = parsed.server != null;
  return switch (requested) {
    OresOtelRuntimeRole.client when !hasClient && hasServer =>
      _fail('client telemetry role was requested but the file defines only a '
          'server role'),
    OresOtelRuntimeRole.server when !hasServer && hasClient =>
      _fail('server telemetry role was requested but the file defines only a '
          'client role'),
    OresOtelRuntimeRole.client => OresOtelRole.client,
    OresOtelRuntimeRole.server => OresOtelRole.server,
    null when hasClient && hasServer =>
      _fail('ambiguous .ores-otel.toml: both client and server sections exist; '
          'set ORES_OTEL_ROLE or pass role explicitly'),
    null when hasClient => OresOtelRole.client,
    null when hasServer => OresOtelRole.server,
    null => OresOtelRole.shared,
  };
}

/// Sub-tables merge key-by-key; scalars and arrays in [overlay] replace.
Map<String, Object> _merge(
  Map<String, Object> base,
  Map<String, Object> overlay,
) =>
    {
      ...base,
      for (final MapEntry(:key, :value) in overlay.entries)
        key: switch ((base[key], value)) {
          (Map<String, Object> left, Map<String, Object> right) =>
            _merge(left, right),
          _ => value,
        },
    };

/// Resolves [parsed] into the runtime value.
///
/// [env] is the process environment, [flagOverrides] (a flags-2-env map) is
/// applied on top of it, and [overrides] is an explicit snake_case layer
/// validated exactly like a file layer.
OresOtelConfig resolveOresOtelConfig(
  OresOtelFileConfig parsed, {
  OresOtelRuntimeRole? role,
  Map<String, String> env = const {},
  Map<String, String> flagOverrides = const {},
  Map<String, Object?>? overrides,
}) {
  final effective = effectiveOresOtelEnv(env, flagOverrides);
  final selected = _selectRole(parsed, _requestedRole(effective, role));
  final layers = [
    parsed.common,
    if (selected == OresOtelRole.client) parsed.client,
    if (selected == OresOtelRole.server) parsed.server,
    _envLayer(effective),
    if (overrides != null) _layer(overrides, 'overrides'),
  ].whereType<Map<String, Object>>();
  return OresOtelConfig._fromLayer(
    selected,
    layers.fold(const <String, Object>{}, _merge),
  );
}

/// Reads the exporter endpoint from the variable named by `endpoint_env`
/// without persisting it in the resolved config.
String? resolveOresOtelExporterEndpoint(
  OresOtelConfig config,
  Map<String, String> env,
) {
  final name = config.exporter.endpointEnv;
  final value = name == null ? null : env[name]?.trim();
  return value == null || value.isEmpty ? null : value;
}

// ---------------------------------------------------------------------------
// Resolved, deeply immutable values
// ---------------------------------------------------------------------------

Map<String, Object> _section(Map<String, Object> layer, String key) =>
    (layer[key] as Map<String, Object>?) ?? const {};

bool _flag(Map<String, Object> layer, String key, {bool fallback = true}) =>
    (layer[key] as bool?) ?? fallback;

double? _ratio(Map<String, Object> layer, String key) =>
    (layer[key] as num?)?.toDouble();

class OresOtelLoggingConfig {
  OresOtelLoggingConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        level = OresOtelLogLevel.values.byName(
          (layer['level'] as String?) ?? OresOtelLogLevel.info.name,
        ),
        console = _flag(layer, 'console'),
        autoSend = _flag(layer, 'auto_send', fallback: false);

  final bool enabled;
  final OresOtelLogLevel level;
  final bool console;
  final bool autoSend;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'level': level.name,
        'console': console,
        'auto_send': autoSend,
      };
}

class OresOtelTracingConfig {
  OresOtelTracingConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        sampleRatio = _ratio(layer, 'sample_ratio') ?? 1.0,
        propagators = List.unmodifiable(
          ((layer['propagators'] as List<String>?) ??
                  const ['tracecontext', 'baggage'])
              .map(OresOtelPropagator.values.byName),
        );

  final bool enabled;
  final double sampleRatio;
  final List<OresOtelPropagator> propagators;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'sample_ratio': sampleRatio,
        'propagators': [for (final p in propagators) p.name],
      };
}

class OresOtelExporterConfig {
  OresOtelExporterConfig._(Map<String, Object> layer)
      : protocol = OresOtelExporterProtocol.values.firstWhere(
          (p) => p.wireName == ((layer['protocol'] as String?) ?? 'none'),
        ),
        endpointEnv = layer['endpoint_env'] as String?;

  final OresOtelExporterProtocol protocol;

  /// Name of the environment variable holding the endpoint (never the value).
  final String? endpointEnv;

  Map<String, Object> toJson() => {
        'protocol': protocol.wireName,
        if (endpointEnv case final name?) 'endpoint_env': name,
      };
}

class OresOtelProcessMetricsConfig {
  OresOtelProcessMetricsConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        sampleIntervalMs = (layer['sample_interval_ms'] as int?) ?? 10000,
        rssBytes = _flag(layer, 'rss_bytes'),
        virtualMemoryBytes = _flag(layer, 'virtual_memory_bytes'),
        heapBytes = _flag(layer, 'heap_bytes'),
        cpuSeconds = _flag(layer, 'cpu_seconds'),
        threadCount = _flag(layer, 'thread_count'),
        openFileDescriptors = _flag(layer, 'open_file_descriptors');

  final bool enabled;
  final int sampleIntervalMs;
  final bool rssBytes;
  final bool virtualMemoryBytes;
  final bool heapBytes;
  final bool cpuSeconds;
  final bool threadCount;
  final bool openFileDescriptors;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'sample_interval_ms': sampleIntervalMs,
        'rss_bytes': rssBytes,
        'virtual_memory_bytes': virtualMemoryBytes,
        'heap_bytes': heapBytes,
        'cpu_seconds': cpuSeconds,
        'thread_count': threadCount,
        'open_file_descriptors': openFileDescriptors,
      };
}

class OresOtelFilesystemMetricsConfig {
  OresOtelFilesystemMetricsConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        paths = List.unmodifiable(
          (layer['paths'] as List<String>?) ?? const ['.'],
        ),
        capacityBytes = _flag(layer, 'capacity_bytes'),
        freeBytes = _flag(layer, 'free_bytes'),
        freeRatio = _flag(layer, 'free_ratio'),
        inodeFreeRatio = _flag(layer, 'inode_free_ratio'),
        minFreeBytes = layer['min_free_bytes'] as int?,
        minFreeRatio = _ratio(layer, 'min_free_ratio'),
        minInodeFreeRatio = _ratio(layer, 'min_inode_free_ratio');

  final bool enabled;
  final List<String> paths;
  final bool capacityBytes;
  final bool freeBytes;
  final bool freeRatio;
  final bool inodeFreeRatio;
  final int? minFreeBytes;
  final double? minFreeRatio;
  final double? minInodeFreeRatio;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'paths': paths,
        'capacity_bytes': capacityBytes,
        'free_bytes': freeBytes,
        'free_ratio': freeRatio,
        'inode_free_ratio': inodeFreeRatio,
        if (minFreeBytes case final value?) 'min_free_bytes': value,
        if (minFreeRatio case final value?) 'min_free_ratio': value,
        if (minInodeFreeRatio case final value?) 'min_inode_free_ratio': value,
      };
}

const List<double> oresOtelDefaultHistogramBoundariesMs = [
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
];

class OresOtelLatencyMetricsConfig {
  OresOtelLatencyMetricsConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        requestDurationMs = _flag(layer, 'request_duration_ms'),
        operationDurationMs = _flag(layer, 'operation_duration_ms'),
        queueWaitMs = _flag(layer, 'queue_wait_ms'),
        eventLoopLagMs = _flag(layer, 'event_loop_lag_ms'),
        histogramBoundariesMs = List.unmodifiable(
          (layer['histogram_boundaries_ms'] as List<double>?) ??
              oresOtelDefaultHistogramBoundariesMs,
        );

  final bool enabled;
  final bool requestDurationMs;
  final bool operationDurationMs;
  final bool queueWaitMs;
  final bool eventLoopLagMs;
  final List<double> histogramBoundariesMs;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'request_duration_ms': requestDurationMs,
        'operation_duration_ms': operationDurationMs,
        'queue_wait_ms': queueWaitMs,
        'event_loop_lag_ms': eventLoopLagMs,
        'histogram_boundaries_ms': histogramBoundariesMs,
      };
}

class OresOtelRuntimeMetricsConfig {
  OresOtelRuntimeMetricsConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        gcPauseMs = _flag(layer, 'gc_pause_ms'),
        gcHeapBytes = _flag(layer, 'gc_heap_bytes'),
        eventLoopUtilization = _flag(layer, 'event_loop_utilization'),
        schedulerQueueDepth = _flag(layer, 'scheduler_queue_depth');

  final bool enabled;
  final bool gcPauseMs;
  final bool gcHeapBytes;
  final bool eventLoopUtilization;
  final bool schedulerQueueDepth;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'gc_pause_ms': gcPauseMs,
        'gc_heap_bytes': gcHeapBytes,
        'event_loop_utilization': eventLoopUtilization,
        'scheduler_queue_depth': schedulerQueueDepth,
      };
}

class OresOtelSaturationMetricsConfig {
  OresOtelSaturationMetricsConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        cpuRatioWarning = _ratio(layer, 'cpu_ratio_warning'),
        memoryRatioWarning = _ratio(layer, 'memory_ratio_warning'),
        diskFreeRatioWarning = _ratio(layer, 'disk_free_ratio_warning'),
        queueDepthWarning = layer['queue_depth_warning'] as int?;

  final bool enabled;
  final double? cpuRatioWarning;
  final double? memoryRatioWarning;
  final double? diskFreeRatioWarning;
  final int? queueDepthWarning;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        if (cpuRatioWarning case final value?) 'cpu_ratio_warning': value,
        if (memoryRatioWarning case final value?) 'memory_ratio_warning': value,
        if (diskFreeRatioWarning case final value?)
          'disk_free_ratio_warning': value,
        if (queueDepthWarning case final value?) 'queue_depth_warning': value,
      };
}

class OresOtelMetricsConfig {
  OresOtelMetricsConfig._(Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        process = OresOtelProcessMetricsConfig._(_section(layer, 'process')),
        filesystem =
            OresOtelFilesystemMetricsConfig._(_section(layer, 'filesystem')),
        latency = OresOtelLatencyMetricsConfig._(_section(layer, 'latency')),
        runtime = OresOtelRuntimeMetricsConfig._(_section(layer, 'runtime')),
        saturation =
            OresOtelSaturationMetricsConfig._(_section(layer, 'saturation')),
        exemplars = _flag(layer, 'exemplars', fallback: false),
        spanMetrics = _flag(layer, 'span_metrics', fallback: false),
        serviceGraphs = _flag(layer, 'service_graphs', fallback: false);

  /// Master switch. It does not rewrite sub-table flags; probes run only when
  /// both this and the sub-table `enabled` are true.
  final bool enabled;
  final OresOtelProcessMetricsConfig process;
  final OresOtelFilesystemMetricsConfig filesystem;
  final OresOtelLatencyMetricsConfig latency;
  final OresOtelRuntimeMetricsConfig runtime;
  final OresOtelSaturationMetricsConfig saturation;
  final bool exemplars;
  final bool spanMetrics;
  final bool serviceGraphs;

  Map<String, Object> toJson() => {
        'enabled': enabled,
        'process': process.toJson(),
        'filesystem': filesystem.toJson(),
        'latency': latency.toJson(),
        'runtime': runtime.toJson(),
        'saturation': saturation.toJson(),
        'exemplars': exemplars,
        'span_metrics': spanMetrics,
        'service_graphs': serviceGraphs,
      };
}

/// The resolved `.ores-otel.toml` value. Every field and list is immutable.
class OresOtelConfig {
  OresOtelConfig._fromLayer(this.role, Map<String, Object> layer)
      : enabled = _flag(layer, 'enabled'),
        serviceName = layer['service_name'] as String?,
        environment = layer['environment'] as String?,
        logging = OresOtelLoggingConfig._(_section(layer, 'logging')),
        tracing = OresOtelTracingConfig._(_section(layer, 'tracing')),
        metrics = OresOtelMetricsConfig._(_section(layer, 'metrics')),
        exporter = OresOtelExporterConfig._(_section(layer, 'exporter'));

  /// Library defaults with the role-neutral `shared` role.
  factory OresOtelConfig.defaults() =>
      resolveOresOtelConfig(OresOtelFileConfig.empty);

  final int version = oresOtelConfigVersion;
  final OresOtelRole role;
  final bool enabled;
  final String? serviceName;
  final String? environment;
  final OresOtelLoggingConfig logging;
  final OresOtelTracingConfig tracing;
  final OresOtelMetricsConfig metrics;
  final OresOtelExporterConfig exporter;

  /// The snake_case resolved shape compared by the cross-language fixtures.
  Map<String, Object> toJson() => {
        'version': version,
        'role': role.name,
        'enabled': enabled,
        if (serviceName case final name?) 'service_name': name,
        if (environment case final value?) 'environment': value,
        'logging': logging.toJson(),
        'tracing': tracing.toJson(),
        'metrics': metrics.toJson(),
        'exporter': exporter.toJson(),
      };
}
