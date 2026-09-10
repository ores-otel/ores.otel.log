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

## Security

Do not put credentials, tokens, cookies, authorization headers, passwords, API keys, private keys, or arbitrary headers in `.ores-otel.toml`. Unknown and secret-shaped keys are rejected. Exporter endpoints are referenced using `endpoint_env`; `resolveOresOtelExporterEndpoint()` reads the endpoint value at runtime without persisting it in the tracked config object.

Supported exporter protocols in v1 are `none`, `otlp_http`, and `otlp_grpc`. Supported propagators are `tracecontext` and `baggage`.

## TypeScript/JavaScript

```ts
import {
  loadOresOtelConfig,
  resolveOresOtelExporterEndpoint,
} from '@oresoftware/next-loggers/config';

const { config } = await loadOresOtelConfig({ role: 'server' });
const endpoint = resolveOresOtelExporterEndpoint(config);
```

`createLoggerFromOresOtelConfig()` applies the resolved logging policy to next-loggers. OpenTelemetry providers remain application-owned: the resolved tracing/exporter settings are inputs to the application's provider setup rather than a hidden global provider installed by this package.

The legacy executable `.next-logger.{ts,mts,mjs,js}` configuration remains supported for compatibility. It is a separate, JavaScript-specific surface and is not a substitute for the cross-runtime `.ores-otel.toml` contract.
