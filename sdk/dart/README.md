# oresoftware_next_loggers

Dart and Flutter implementation of the shared `next-loggers/v1` structured
logging contract. It uses Dart Zones for scoped context and accepts explicit,
application-owned OpenTelemetry and Supabase transports. It does not register
or monkey-patch global runtime instrumentation.

```dart
import 'package:oresoftware_next_loggers/oresoftware_next_loggers.dart';

final logger = Logger(appName: 'payments');
final record = await withLogContext(
  const LogContext(traceId: 'trace-1', spanId: 'span-1'),
  () => logger.info('charged order', fields: const {'orderId': 'order-42'}),
);
```

## Per-event OpenTelemetry routing

`Logger(otel: true)` is the default. Existing immediate methods remain
unchanged; use `event` when a record needs an explicit OTEL decision:

```dart
final log = Logger(appName: 'app', otel: false, transports: transports);
await log.event(LogLevel.info, 'sampled in').useOtel().send();
await log.event(LogLevel.warn, 'OTEL excluded').notOtel().send();
await log.event(LogLevel.info, 'computed').withOtel(routeToOtel).send();
```

`resetOtel()` restores the logger default and `isOtelEnabled(fallback)`
resolves it. Logger `setOtelEnabled`, `useOtel`, and `notOtel` update the
default. Other transports still receive records excluded from OTEL.

## `.ores-otel.toml` configuration and APM helpers

The loader follows the shared v1 contract in
[`docs/ores-otel-config.md`](../../docs/ores-otel-config.md). Precedence is
`defaults < common < role < env < flagOverrides < overrides`, and every
malformed file, environment value, or flag throws `OresOtelConfigException`.

```dart
final loaded = await loadOresOtelConfig(
  role: OresOtelRuntimeRole.server,
  flagOverrides: flags2EnvMap, // e.g. {'ORES_OTEL_METRICS_SAMPLE_INTERVAL_MS': '2000'}
);
final endpoint =
    resolveOresOtelExporterEndpoint(loaded.config, Platform.environment);
```

`parseOresOtelToml` and `resolveOresOtelConfig` are pure (no `dart:io`); only
`loadOresOtelConfig` in `ores_otel_config_io.dart` reads files. Resolved values
are immutable, and `toJson()` produces the snake_case shape checked against
`tests/fixtures/ores-otel-config`.

APM helpers stay application-owned and pure:
`OresOtelResourceThresholds.fromResolved`, `evaluateDiskPressure` (caller
supplies free and capacity numbers; emits `ores.apm.resource.pressure` gauge
points), and `LatencyHistogram` (`record` returns a new value; `toMetricPoint`
emits an `ores.apm.latency` histogram in `ms`).
