import 'dart:convert';
import 'dart:io';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:test/test.dart';

/// Cross-language parity corpus shared with the TypeScript and Rust loaders
/// and APM SDKs.
/// Tests run with cwd = sdk/dart.
final _fixtureRoot = Directory('../../tests/fixtures/ores-otel-config');

Object? _normalize(Object? value) => switch (value) {
      num number => number.toDouble(),
      Map<Object?, Object?> map => {
          for (final entry in map.entries)
            entry.key.toString(): _normalize(entry.value),
        },
      List<Object?> list => [for (final item in list) _normalize(item)],
      _ => value,
    };

Map<String, String> _strings(Object? value) =>
    (value as Map<String, dynamic>? ?? const {}).cast<String, String>();

Object? _readJson(Directory dir, String name) =>
    jsonDecode(File('${dir.path}/$name').readAsStringSync());

void main() {
  final cases = _fixtureRoot.listSync().whereType<Directory>().toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  test('fixture corpus contains at least 18 cases', () {
    expect(cases.length, greaterThanOrEqualTo(18));
  });

  final lookup = _readJson(_fixtureRoot.parent, 'ores-otel-config-lookup.json')!
      as Map<String, dynamic>;
  for (final raw in lookup['cases'] as List<dynamic>) {
    final item = raw as Map<String, dynamic>;
    test('lookup: ${item['name']}', () {
      expect(
        oresOtelConfigFilePath(
          cwd: item['cwd'] as String?,
          filePath: item['file_path'] as String?,
          env: effectiveOresOtelEnv(
            _strings(item['env']),
            _strings(item['flag_overrides']),
          ),
          currentDirectory: item['current_directory'] as String,
        ),
        item['expected'],
      );
    });
  }

  for (final dir in cases) {
    final name = dir.uri.pathSegments.lastWhere((s) => s.isNotEmpty);
    test('parity: $name', () {
      final input = File('${dir.path}/input.toml').readAsStringSync();
      final options = _readJson(dir, 'options.json')! as Map<String, dynamic>;
      final expected = _readJson(dir, 'expected.json');
      final role = switch (options['role']) {
        null => null,
        'client' => OresOtelRuntimeRole.client,
        'server' => OresOtelRuntimeRole.server,
        final other => throw StateError('unknown fixture role $other'),
      };
      OresOtelConfig resolve() => resolveOresOtelConfig(
            parseOresOtelToml(input),
            role: role,
            env: _strings(options['env']),
            flagOverrides: _strings(options['flag_overrides']),
          );

      if (expected case {'error': true}) {
        expect(resolve, throwsA(isA<OresOtelConfigException>()));
      } else {
        expect(_normalize(resolve().toJson()), _normalize(expected));
      }
    });
  }

  final diskPressure =
      _readJson(_fixtureRoot.parent, 'ores-otel-apm-disk-pressure.json')!
          as Map<String, dynamic>;
  test('disk-pressure corpus is not empty', () {
    expect(diskPressure['metric'], 'ores.apm.resource.pressure');
    expect(diskPressure['cases'] as List<dynamic>,
        hasLength(greaterThanOrEqualTo(6)));
  });
  for (final raw in diskPressure['cases'] as List<dynamic>) {
    final item = raw as Map<String, dynamic>;
    test('disk pressure: ${item['name']}', () {
      final m = item['measurement'] as Map<String, dynamic>;
      final t = item['thresholds'] as Map<String, dynamic>;
      final pressure = evaluateDiskPressure(
        path: m['path'] as String,
        availableBytes: m['available_bytes'] as int,
        capacityBytes: m['capacity_bytes'] as int,
        availableInodes: m['available_inodes'] as int?,
        totalInodes: m['total_inodes'] as int?,
        thresholds: OresOtelResourceThresholds(
          minFreeBytes: t['min_free_bytes'] as int?,
          minFreeRatio: (t['min_free_ratio'] as num?)?.toDouble(),
          minInodeFreeRatio: (t['min_inode_free_ratio'] as num?)?.toDouble(),
        ),
      );
      final points = pressure.metricPoints();
      for (final point in points) {
        expect(point['name'], diskPressure['metric']);
        expect(point['type'], diskPressure['type']);
        expect(point['unit'], diskPressure['unit']);
      }
      expect(
        _normalize([
          for (final point in points)
            {'value': point['value'], 'attributes': point['attributes']},
        ]),
        _normalize(item['expected']),
      );
    });
  }
}
