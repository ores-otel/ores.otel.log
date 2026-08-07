# Next Loggers local observability stack

This directory provides a pinned, single-host reference stack for validating the
`next-loggers` OpenTelemetry, Prometheus, Loki, Tempo, and Grafana integration.
It is intentionally local-only: every published port binds to `127.0.0.1`,
anonymous Grafana access is disabled, and Grafana refuses to start without an
explicit administrator password.

## Components

- OpenTelemetry Collector Contrib `0.157.0`
- Loki `3.7.2`
- Tempo `2.10.5`
- Prometheus `3.12.0`
- Grafana `13.1.0`

The Collector accepts explicit OTLP gRPC/HTTP from application-owned SDKs. It
redacts a conservative set of credential and contact fields, then routes logs
to Loki, metrics to Prometheus, and traces to Tempo. No runtime auto-
instrumentation or monkey patching is involved.

Tempo's metrics-generator remote-writes bounded span/service-graph metrics to
Prometheus, including exemplars. Grafana is provisioned for logs-to-traces,
traces-to-logs, metrics-to-traces, trace-derived RED metrics, and service graphs.

## Start locally

```sh
cd observability
cp .env.example .env
# Set GRAFANA_ADMIN_PASSWORD to a random value of at least 24 characters.
docker compose up -d
```

Local endpoints:

| Signal or UI | Endpoint |
| --- | --- |
| OTLP gRPC | `127.0.0.1:4317` |
| OTLP HTTP | `http://127.0.0.1:4318` |
| Collector health | `http://127.0.0.1:13133` |
| Collector internal metrics | `http://127.0.0.1:8888/metrics` |
| Loki | `http://127.0.0.1:3100` |
| Tempo | `http://127.0.0.1:3200` |
| Prometheus | `http://127.0.0.1:9090` |
| Grafana | `http://127.0.0.1:3000` |

Use the root repository smoke test after startup:

```sh
node scripts/observability-smoke.mjs
```

Stop the stack and remove local test data with:

```sh
docker compose down -v --remove-orphans
```

## Browser and mobile boundary

Do not enable broad CORS on the Collector or put OTLP credentials in browser or
mobile bundles. Those clients should use the authenticated, bounded Supabase
transport and Edge Function in `examples/supabase/`. Realtime may be added as a
separate live-tail transport, but it is not the durable ingestion path.

## Cardinality boundary

Loki indexes only low-cardinality resource dimensions. `service.instance.id`,
`k8s.pod.name`, trace IDs, and span IDs stay in structured metadata. Tempo span
metrics disable instance/target labels and add only the deployment environment
as a custom dimension. Application Prometheus metrics must likewise keep users,
request IDs, record IDs, raw paths, and arbitrary log fields out of labels.

## Production boundary

This Compose stack is not a production multi-tenant deployment. Before exposing
any component beyond localhost, add authenticated TLS ingress, network policy,
secret management, object storage, backup/retention policy, resource sizing,
horizontal scaling, tenant isolation, and an Alertmanager notification route.
Do not expose backend ports directly to the public internet.
