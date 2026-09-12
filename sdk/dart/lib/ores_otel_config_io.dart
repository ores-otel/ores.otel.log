/// `dart:io` file discovery for `.ores-otel.toml`. Parsing and resolution are
/// pure and live in `ores_otel_config.dart`.
library;

import 'dart:io';

import 'ores_otel_config.dart';

class LoadedOresOtelConfig {
  const LoadedOresOtelConfig(this.config, this.parsed, this.filePath);

  final OresOtelConfig config;
  final OresOtelFileConfig parsed;

  /// The file that was read, or null when none existed (defaults applied).
  final String? filePath;
}

String? _nonBlank(String? value) =>
    value == null || value.trim().isEmpty ? null : value.trim();

/// Picks the config file path. Precedence: [filePath] argument, [cwd]
/// argument, `ORES_OTEL_CONFIG_FILE`, `ORES_OTEL_CONFIG_DIR`, then
/// [currentDirectory]. [env] must already include flag overrides.
String oresOtelConfigFilePath({
  String? cwd,
  String? filePath,
  required Map<String, String> env,
  required String currentDirectory,
}) {
  String inDirectory(String directory) =>
      '${directory.replaceFirst(RegExp(r'[\\/]+$'), '')}/'
      '$oresOtelConfigBasename';
  return _nonBlank(filePath) ??
      (_nonBlank(cwd) == null ? null : inDirectory(cwd!.trim())) ??
      _nonBlank(env['ORES_OTEL_CONFIG_FILE']) ??
      inDirectory(_nonBlank(env['ORES_OTEL_CONFIG_DIR']) ?? currentDirectory);
}

/// Reads `.ores-otel.toml` when present and resolves it. A missing file
/// resolves library defaults. [env] defaults to `Platform.environment`;
/// [flagOverrides] are applied on top of it, both for file selection
/// (`ORES_OTEL_CONFIG_FILE` / `ORES_OTEL_CONFIG_DIR`) and for resolution.
Future<LoadedOresOtelConfig> loadOresOtelConfig({
  String? cwd,
  String? filePath,
  OresOtelRuntimeRole? role,
  Map<String, String>? env,
  Map<String, String> flagOverrides = const {},
  Map<String, Object?>? overrides,
}) async {
  final sourceEnv = env ?? Platform.environment;
  final path = oresOtelConfigFilePath(
    cwd: cwd,
    filePath: filePath,
    env: effectiveOresOtelEnv(sourceEnv, flagOverrides),
    currentDirectory: Directory.current.path,
  );
  final String? input;
  try {
    input = await File(path).readAsString();
  } on PathNotFoundException {
    return LoadedOresOtelConfig(
      resolveOresOtelConfig(
        OresOtelFileConfig.empty,
        role: role,
        env: sourceEnv,
        flagOverrides: flagOverrides,
        overrides: overrides,
      ),
      OresOtelFileConfig.empty,
      null,
    );
  } on FileSystemException catch (error) {
    throw OresOtelConfigException('cannot read $path: ${error.message}');
  }
  final parsed = parseOresOtelToml(input);
  return LoadedOresOtelConfig(
    resolveOresOtelConfig(
      parsed,
      role: role,
      env: sourceEnv,
      flagOverrides: flagOverrides,
      overrides: overrides,
    ),
    parsed,
    path,
  );
}
