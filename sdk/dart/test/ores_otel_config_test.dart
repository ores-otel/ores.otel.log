import 'dart:io';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:test/test.dart';

final Matcher _throwsConfig = throwsA(isA<OresOtelConfigException>());

void main() {
  group('TOML subset', () {
    test('parses tables, quoted keys, escapes, numbers and arrays', () {
      final table = parseTomlSubset('''
# leading comment
title = "a \\"quoted\\" \\u00e9 # not a comment" # trailing
"quoted key" = -12
ratio = 1.5e1
flag = false

[a.b]
list = [
  "x", # comment inside
  "y",
]
nums = [1, 2.5, 3]
empty = []
''');
      expect(table['title'], 'a "quoted" é # not a comment');
      expect(table['quoted key'], -12);
      expect(table['ratio'], 15.0);
      expect(table['flag'], isFalse);
      final ab = (table['a']! as Map)['b']! as Map;
      expect(ab['list'], ['x', 'y']);
      expect(ab['nums'], [1, 2.5, 3]);
      expect(ab['empty'], isEmpty);
    });

    test('accepts CRLF line endings', () {
      expect(parseTomlSubset('a = 1\r\nb = "x"\r\n'), {'a': 1, 'b': 'x'});
    });

    for (final (label, input) in [
      ('inline table', 'a = { b = 1 }'),
      ('array of tables', '[[a]]'),
      ('duplicate key', 'a = 1\na = 2'),
      ('duplicate table', '[a]\n[a]'),
      ('mixed array', 'a = [1, "x"]'),
      ('boolean array', 'a = [true]'),
      ('nested array', 'a = [[1]]'),
      ('dotted key', 'a.b = 1'),
      ('literal string', "a = 'x'"),
      ('multi-line string', 'a = """x"""'),
      ('unterminated string', 'a = "x'),
      ('unterminated array', 'a = [1,'),
      ('unsupported escape', r'a = "\q"'),
      ('leading zero', 'a = 01'),
      ('date', 'a = 2024-01-01'),
      ('missing value', 'a ='),
      ('trailing garbage', 'a = 1 2'),
      ('value redefined as table', 'a = 1\n[a]'),
      ('empty array slot', 'a = [1,,2]'),
    ]) {
      test('rejects $label', () {
        expect(() => parseTomlSubset(input), _throwsConfig);
      });
    }

    test('result is deeply unmodifiable', () {
      final table = parseTomlSubset('[a]\nlist = ["x"]');
      expect(() => table['b'] = 1, throwsUnsupportedError);
      final a = table['a']! as Map<String, Object>;
      expect(() => a['c'] = 1, throwsUnsupportedError);
      expect(() => (a['list']! as List).add('y'), throwsUnsupportedError);
    });
  });

  group('resolution', () {
    test('defaults are immutable', () {
      final config = OresOtelConfig.defaults();
      expect(config.role, OresOtelRole.shared);
      expect(
        () => config.tracing.propagators.add(OresOtelPropagator.baggage),
        throwsUnsupportedError,
      );
      expect(() => config.metrics.filesystem.paths.add('/'),
          throwsUnsupportedError);
      expect(() => config.metrics.latency.histogramBoundariesMs.add(1),
          throwsUnsupportedError);
    });

    test('flag overrides outrank env; explicit overrides outrank both', () {
      final config = resolveOresOtelConfig(
        parseOresOtelToml('version = 1\n[common.logging]\nlevel = "error"'),
        env: const {'ORES_OTEL_LOG_LEVEL': 'debug'},
        flagOverrides: const {'ORES_OTEL_LOG_LEVEL': 'warn'},
      );
      expect(config.logging.level, OresOtelLogLevel.warn);
      final overridden = resolveOresOtelConfig(
        OresOtelFileConfig.empty,
        flagOverrides: const {'ORES_OTEL_LOG_LEVEL': 'warn'},
        overrides: const {
          'logging': {'level': 'fatal'},
        },
      );
      expect(overridden.logging.level, OresOtelLogLevel.fatal);
    });

    test('secret-shaped overrides are rejected', () {
      expect(
        () => resolveOresOtelConfig(
          OresOtelFileConfig.empty,
          overrides: const {
            'exporter': {'headers': 'x'},
          },
        ),
        _throwsConfig,
      );
    });

    test('env boolean spellings and malformed arrays', () {
      final config = resolveOresOtelConfig(
        OresOtelFileConfig.empty,
        env: const {
          'ORES_OTEL_METRICS_RUNTIME_ENABLED': 'off',
          'ORES_OTEL_METRICS_SATURATION_ENABLED': 'YES',
        },
      );
      expect(config.metrics.runtime.enabled, isFalse);
      expect(config.metrics.saturation.enabled, isTrue);
      for (final bad in ['[1,', 'a,,b', '[1]']) {
        expect(
          () => resolveOresOtelConfig(
            OresOtelFileConfig.empty,
            env: {'ORES_OTEL_METRICS_FILESYSTEM_PATHS': bad},
          ),
          _throwsConfig,
          reason: bad,
        );
      }
    });

    test('role must exist when requested against a single-role file', () {
      final parsed = parseOresOtelToml('version = 1\n[server]\nenabled = true');
      expect(resolveOresOtelConfig(parsed).role, OresOtelRole.server);
      expect(
        () => resolveOresOtelConfig(parsed, role: OresOtelRuntimeRole.client),
        _throwsConfig,
      );
      expect(
        () => resolveOresOtelConfig(parsed,
            env: const {'ORES_OTEL_ROLE': 'edge'}),
        _throwsConfig,
      );
    });

    test('exporter endpoint is read from the named variable only', () {
      final config = resolveOresOtelConfig(
        parseOresOtelToml(
            'version = 1\n[common.exporter]\nendpoint_env = "MY_ENDPOINT"'),
      );
      expect(config.toJson().toString(), isNot(contains('http://collector')));
      expect(
        resolveOresOtelExporterEndpoint(
            config, const {'MY_ENDPOINT': ' http://collector '}),
        'http://collector',
      );
      expect(resolveOresOtelExporterEndpoint(config, const {}), isNull);
    });
  });

  group('IO loader', () {
    late Directory temp;
    setUp(() => temp = Directory.systemTemp.createTempSync('ores-otel-'));
    tearDown(() => temp.deleteSync(recursive: true));

    test('missing file resolves defaults', () async {
      final loaded = await loadOresOtelConfig(cwd: temp.path, env: const {});
      expect(loaded.filePath, isNull);
      expect(loaded.config.toJson(), OresOtelConfig.defaults().toJson());
    });

    test('reads cwd, config dir, and config file from flags', () async {
      File('${temp.path}/.ores-otel.toml')
          .writeAsStringSync('version = 1\n[client]\nservice_name = "web"');
      final other = File('${temp.path}/other.toml')
        ..writeAsStringSync('version = 1\n[server]\nservice_name = "api"');

      final fromCwd = await loadOresOtelConfig(cwd: temp.path, env: const {});
      expect(fromCwd.config.serviceName, 'web');

      final fromDir = await loadOresOtelConfig(
        env: const {},
        flagOverrides: {'ORES_OTEL_CONFIG_DIR': temp.path},
      );
      expect(fromDir.filePath, '${temp.path}/.ores-otel.toml');

      final fromFile = await loadOresOtelConfig(
        env: {'ORES_OTEL_CONFIG_DIR': temp.path},
        flagOverrides: {'ORES_OTEL_CONFIG_FILE': other.path},
      );
      expect(fromFile.config.serviceName, 'api');
      expect(fromFile.config.role, OresOtelRole.server);
    });

    test('malformed file throws', () async {
      File('${temp.path}/.ores-otel.toml').writeAsStringSync('version = 2');
      expect(loadOresOtelConfig(cwd: temp.path, env: const {}), _throwsConfig);
    });
  });

  group('APM helpers', () {
    OresOtelConfig serverConfig(String extra) => resolveOresOtelConfig(
          parseOresOtelToml('version = 1\n$extra'),
          role: OresOtelRuntimeRole.server,
        );

    test('thresholds honour master and sub-table switches', () {
      const toml = '[server.metrics.filesystem]\nmin_free_bytes = 100\n'
          '[server.metrics.saturation]\nqueue_depth_warning = 5';
      final on = OresOtelResourceThresholds.fromResolved(serverConfig(toml));
      expect(on.minFreeBytes, 100);
      expect(on.queueDepthWarning, 5);
      final off = OresOtelResourceThresholds.fromResolved(
          serverConfig('$toml\n[server.metrics]\nenabled = false'));
      expect(off.minFreeBytes, isNull);
      expect(off.queueDepthWarning, isNull);
    });

    test('evaluateDiskPressure reports breaches as gauge points', () {
      final pressure = evaluateDiskPressure(
        path: '/data',
        availableBytes: 50,
        capacityBytes: 1000,
        availableInodes: 900,
        totalInodes: 1000,
        thresholds: const OresOtelResourceThresholds(
          minFreeBytes: 10,
          minFreeRatio: 0.1,
          minInodeFreeRatio: 0.5,
        ),
      );
      expect(pressure.freeRatio, 0.05);
      expect(pressure.underPressure, isTrue);
      expect(pressure.breaches, [OresOtelDiskPressureKind.freeRatio]);
      final points = pressure.metricPoints();
      expect(points, hasLength(3));
      expect(points.map((p) => p['value']), [0, 1, 0]);
      expect(points.first['name'], 'ores.apm.resource.pressure');
      expect(
        (points[1]['attributes']! as Map)['ores.apm.pressure.target'],
        '/data',
      );
      expect(
        () => evaluateDiskPressure(
          path: '/',
          availableBytes: -1,
          capacityBytes: 0,
          thresholds: const OresOtelResourceThresholds(),
        ),
        throwsArgumentError,
      );
    });

    test('LatencyHistogram records into new immutable values', () {
      final empty =
          LatencyHistogram.fromConfig(serverConfig('[server.metrics.latency]\n'
                  'histogram_boundaries_ms = [10, 100]')
              .metrics
              .latency);
      final filled = empty.record(10).record(50).record(500);
      expect(empty.count, 0);
      expect(empty.bucketCounts, [0, 0, 0]);
      expect(filled.bucketCounts, [1, 1, 1]);
      expect(() => filled.bucketCounts[0] = 9, throwsUnsupportedError);
      final point = filled.toMetricPoint(kind: OresOtelLatencyKind.queueWait);
      expect(point['name'], 'ores.apm.latency');
      expect(point['unit'], 'ms');
      expect(point['sum'], 560.0);
      expect(point['min'], 10.0);
      expect(point['max'], 500.0);
      expect(
          (point['attributes']! as Map)['ores.apm.latency.kind'], 'queue_wait');
      expect(() => LatencyHistogram([5, 5]), _throwsConfig);
      expect(() => filled.record(-1), throwsArgumentError);
    });
  });
}
