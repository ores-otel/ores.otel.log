# `.ores-otel.toml` configuration

ORES telemetry supports a repository-root `.ores-otel.toml` file for logging, tracing, metrics, and exporter policy. The cross-language data contract lives in `ores-otel/ores-otel-interfaces` and is admitted by `ORESoftware/typespec-json-schema-validator` (TJSV) against independently authored TypeSpec and JSON Schema Draft 2020-12 authorities.

The TOML file is only a serialization. Each language may use a native TOML reader, but the parsed object and runtime semantics must match the shared v1 contract.

## Mixed client/server repository

```toml
version = 1

[common]
enabled = true
environment = "production"

[common.logging]
enabled = true
level = "info"
console = true
auto_send = false

[common.tracing]
enabled = true
sample_ratio = 0.1
propagators = ["tracecontext", "baggage"]

[client]
service_name = "example-web"

[client.logging]
console = false

[client.exporter]
protocol = "otlp_http"
endpoint_env = "EXAMPLE_CLIENT_OTEL_ENDPOINT"

[server]
service_name = "example-api"

[server.tracing]
sample_ratio = 1.0

[server.metrics]
enabled = true

[server.exporter]
protocol = "otlp_grpc"
endpoint_env = "EXAMPLE_SERVER_OTEL_ENDPOINT"
```

When both `client` and `server` sections exist, loading without `role: 'client' | 'server'` or `ORES_OTEL_ROLE=client|server` fails. This prevents browser code from accidentally receiving server policy and prevents server processes from silently inheriting client telemetry settings.

A file with only `client` or only `server` may infer that role. A `common`-only file resolves to the role-neutral `shared` role.

## Precedence

Resolution is deterministic:

`library defaults < common < selected role < ORES_OTEL_* environment < explicit runtime overrides`

Malformed environment overrides fail rather than being silently ignored.

## File lookup

Every loader picks the file the same way (first non-blank input wins; values are trimmed and trailing directory separators stripped):

1. an explicit file path argument (`filePath` / `file_path`);
2. an explicit directory argument (`cwd`);
3. `ORES_OTEL_CONFIG_FILE`;
4. `ORES_OTEL_CONFIG_DIR`;
5. the process working directory.

Steps 3 and 4 read the environment with flags-2-env overrides already applied, so `--otel-config-file` beats an exported `ORES_OTEL_CONFIG_DIR`, while an application that passes `cwd` in code keeps control of discovery. A missing file resolves library defaults. `tests/fixtures/ores-otel-config-lookup.json` pins this order for all three SDKs.

## Parsing rules shared by every loader

The TOML readers are deliberately stricter than general TOML libraries, and the shared fixtures pin each rule:

- a table header may appear only once (`[common.logging]` twice fails; `[a.b]` followed by `[a]` is allowed);
- integer keys (`version`, `sample_interval_ms`, `min_free_bytes`, `queue_depth_warning`) reject float spellings such as `5000.0`, while ratio and histogram-boundary keys accept integers;
- literal, multi-line, and unescaped-quote strings, inline tables, arrays of tables, dotted keys, dates, leading zeros, and mixed or nested arrays fail;
- string settings are trimmed, but `metrics.filesystem.paths` entries are only checked to be non-blank and are kept verbatim;
- in comma-separated environment arrays an empty entry (`/a,,/b`) fails, while `ORES_OTEL_PROPAGATORS` ignores empty entries.

## Security

Do not put credentials, tokens, cookies, authorization headers, passwords, API keys, private keys, or arbitrary headers in `.ores-otel.toml`. Unknown and secret-shaped keys are rejected. Exporter endpoints are referenced using `endpoint_env`; `resolveOresOtelExporterEndpoint()` reads the endpoint value at runtime without persisting it in the tracked config object.

Supported exporter protocols in v1 are `none`, `otlp_http`, and `otlp_grpc`. Supported propagators are `tracecontext` and `baggage`.

## TypeScript/JavaScript

```ts
import {
  loadOresOtelConfig,
  resolveOresOtelExporterEndpoint,
} from '@oresoftware/next-loggers/config';

const { config } = await loadOresOtelConfig({
  role: 'server',
  flagOverrides, // the ORES_OTEL_* map flags-2-env produced from argv
});
const endpoint = resolveOresOtelExporterEndpoint(config);
```

`oresOtelConfigToJson(config)` renders the snake_case resolved shape the parity fixtures compare, and `oresOtelConfigFilePath()` exposes the lookup order as a pure function. Resolved configs are deeply frozen; explicit `overrides` are validated exactly like a file layer.

`createLoggerFromOresOtelConfig()` applies the resolved logging policy to next-loggers. OpenTelemetry providers remain application-owned: the resolved tracing/exporter settings are inputs to the application's provider setup rather than a hidden global provider installed by this package.

The legacy executable `.next-logger.{ts,mts,mjs,js}` configuration remains supported for compatibility. It is a separate, JavaScript-specific surface and is not a substitute for the cross-runtime `.ores-otel.toml` contract.

## APM metrics (`metrics.*`)

The v1 contract (`ores-otel-interfaces` commit `09258f8`, DEN-390) adds APM sub-tables under every layer's `metrics` table. All SDK loaders (TypeScript, Rust, Dart) parse them strictly and resolve them identically:

```toml
[server.metrics.process]            # RSS / virtual / heap memory, CPU, threads, fds
sample_interval_ms = 5000           # integer 100..3600000

[server.metrics.filesystem]         # disk-space checks
paths = ["/", "/var/lib/data"]      # 1..32 unique non-empty paths
min_free_bytes = 1073741824         # integer >= 0; pressure when available bytes drop below
min_free_ratio = 0.1                # 0..1; pressure when available/capacity drops below
min_inode_free_ratio = 0.05         # 0..1

[server.metrics.latency]            # request/operation/queue-wait/event-loop-lag histograms
histogram_boundaries_ms = [1, 5, 10, 25, 50, 100, 250, 500, 1000]  # 1..32, > 0, strictly increasing

[server.metrics.runtime]            # gc_pause_ms, gc_heap_bytes, event_loop_utilization, scheduler_queue_depth
[server.metrics.saturation]         # cpu_ratio_warning, memory_ratio_warning, disk_free_ratio_warning (0..1), queue_depth_warning (integer >= 0)
```

`metrics` itself also accepts `enabled`, `exemplars`, `span_metrics`, and `service_graphs` booleans.

### Resolved shape and defaults

Every loader can render its resolved value as this snake_case JSON object; the cross-language parity fixtures in `tests/fixtures/ores-otel-config/` compare exactly this shape (numbers compare numerically, so `1` equals `1.0`). Optional keys (`service_name`, `environment`, `exporter.endpoint_env`, filesystem `min_*` thresholds, saturation thresholds) are omitted when unset.

| Key | Default |
| --- | --- |
| `metrics.enabled` | `true` |
| `metrics.process` | `enabled = true`, `sample_interval_ms = 10000`, every signal boolean `true` |
| `metrics.filesystem` | `enabled = true`, `paths = ["."]`, every signal boolean `true`, no thresholds |
| `metrics.latency` | `enabled = true`, every signal boolean `true`, `histogram_boundaries_ms = [1,5,10,25,50,100,250,500,1000,2500,5000,10000]` |
| `metrics.runtime` | `enabled = true`, every signal boolean `true` |
| `metrics.saturation` | `enabled = true`, no thresholds |
| `metrics.exemplars` / `span_metrics` / `service_graphs` | `false` |

Sub-tables merge key-by-key across layers; arrays (`paths`, `histogram_boundaries_ms`, `propagators`) replace rather than concatenate. `metrics.enabled = false` does not rewrite sub-table flags in the resolved value; probes run only when both the master switch and the sub-table switch are true.

### Environment and flags-2-env overrides

Precedence is:

`library defaults < common < selected role < process environment < flags-2-env overrides < explicit runtime overrides`

`contracts/ores-otel.cli-flags.toml` is a [flags-2-env](https://github.com/flags-2-env/flags-2-env) fragment declaring one flag per supported variable (`--otel-role`, `--otel-disk-paths`, `--otel-metrics-sample-interval-ms`, ...). Merge it into an application's `.cli-flags.toml`, parse argv with flags-2-env, and pass the returned map to the loader (`flagOverrides` in TypeScript/Dart, `flag_overrides` in Rust). The map is applied as an environment layer on top of the real environment, so `ORES_OTEL_ROLE`, `ORES_OTEL_CONFIG_DIR`, and `ORES_OTEL_CONFIG_FILE` supplied as flags also select the role and file.

APM variables: `ORES_OTEL_METRICS_PROCESS_ENABLED`, `ORES_OTEL_METRICS_SAMPLE_INTERVAL_MS`, `ORES_OTEL_METRICS_FILESYSTEM_ENABLED`, `ORES_OTEL_METRICS_FILESYSTEM_PATHS`, `ORES_OTEL_METRICS_MIN_FREE_BYTES`, `ORES_OTEL_METRICS_MIN_FREE_RATIO`, `ORES_OTEL_METRICS_LATENCY_ENABLED`, `ORES_OTEL_METRICS_HISTOGRAM_BOUNDARIES_MS`, `ORES_OTEL_METRICS_RUNTIME_ENABLED`, `ORES_OTEL_METRICS_SATURATION_ENABLED`, `ORES_OTEL_METRICS_MEMORY_RATIO_WARNING`. Array variables accept a JSON array of strings/numbers (what flags-2-env emits for `type = "array"`) or a comma-separated list; booleans accept `true/false`, `1/0`, `yes/no`, `on/off`; integer variables reject fractional values. Every malformed value fails loading.

### Emitting OTel metrics

Providers stay application-owned. The SDKs sample resources and hand OpenTelemetry semantic-convention points to a meter you supply:

| Signal | Instrument | Unit |
| --- | --- | --- |
| `process.memory.usage` (RSS) | gauge | `By` |
| `process.memory.virtual` | gauge | `By` |
| `process.runtime.heap.used` / `process.runtime.heap.total` | gauge | `By` |
| `process.cpu.time` (`cpu.mode` = `user`/`system`) | counter (cumulative) | `s` |
| `process.thread.count` | gauge | `{thread}` |
| `process.open_file_descriptor.count` | gauge | `{file_descriptor}` |
| `system.filesystem.usage` (`system.filesystem.state` = `used`/`free`/`reserved`, `system.filesystem.mountpoint`) | gauge | `By` |
| `system.filesystem.utilization` | gauge | `1` |
| `ores.apm.resource.pressure` (`ores.apm.pressure.kind`, `ores.apm.pressure.target`) | gauge (1 while breached) | `1` |
| `ores.apm.latency` (`ores.apm.latency.kind` = `request`/`operation`/`queue_wait`) | histogram | `ms` |
| `nodejs.eventloop.delay.{p50,p99,max}` | gauge | `s` |
| `nodejs.eventloop.utilization` | gauge | `1` |

TypeScript: `@oresoftware/next-loggers/apm`.

- **Wiring:** `startOresOtelApm({ meter, config })` registers the enabled instruments, samples `metrics.filesystem.paths` every `metrics.process.sample_interval_ms`, and returns a handle with `latency`, `refreshFilesystem()`, and an idempotent `stop()`. `createLatencyRecorder(meter, config)` gives `record` / `time` / `timeAsync`.
- **Pure helpers:** `oresOtelResourceThresholds`, `evaluateDiskPressure`, `evaluateSaturation`, `createLatencyHistogramSnapshot`, `recordLatency`.
- **Samplers:** `sampleProcessMemory`, `sampleFilesystem`.
- **Meter typing:** the meter is structural, so an `@opentelemetry/api` `Meter` works without this package depending on it.
- **Node limits:** Node exposes no portable virtual-memory, thread-count, or open-fd reading, so the TypeScript SDK does not emit `process.memory.virtual`, `process.thread.count`, or `process.open_file_descriptor.count`.

 Rust: `next_loggers::apm::resource_metric_points` and `LatencyHistogramSnapshot::metric_points` (the `apm` feature enables live sampling).
