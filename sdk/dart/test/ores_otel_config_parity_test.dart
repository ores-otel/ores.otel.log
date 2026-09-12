import 'dart:convert';
import 'dart:io';

import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';
import 'package:test/test.dart';

/// Cross-language parity corpus shared with the TypeScript and Rust loaders.
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
}
