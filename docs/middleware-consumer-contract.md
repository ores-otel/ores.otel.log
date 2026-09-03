# Middleware consumer contract

`ores.otel.log` owns the canonical logger implementations and the
`next-loggers/v1` record/context contract. HTTP and RPC request-lifecycle
middleware belongs in [`ORESoftware/ores-middleware`](https://github.com/ORESoftware/ores-middleware).

The dependency direction is intentionally one-way:

```text
application
  -> ores-middleware
       -> ores.otel.log SDK for the application's language
```

`ores.otel.log` must not import a middleware package. This keeps logging usable
in CLIs, daemons, workers, tests, and non-HTTP processes while allowing
`ores-middleware` to bind transport-specific request state to the same logger
contract.

## Supported middleware package coordinates

The middleware repository consumes these canonical packages:

| Runtime | Canonical logger package |
| --- | --- |
| TypeScript / Node.js | root package `@oresoftware/next-loggers` |
| Rust | Cargo package `oresoftware-next-loggers` in `sdk/rust` |
| Go | module `github.com/ores-otel/ores.otel.log/sdk/go` |
| Gleam | package `oresoftware_next_loggers` in `sdk/gleam` |
| Elixir | Mix application in `sdk/elixir` |
| Erlang | Rebar3 application in `sdk/erlang` |

Source consumers should pin a full commit SHA. The root Node.js package exposes
a `prepare` lifecycle script so a Git dependency builds its `dist` artifacts
from the pinned source before it is linked into the consumer.

## Request correlation

A middleware request context maps into the logger context without creating a
second logging implementation:

| Middleware value | Logger value |
| --- | --- |
| request ID | `fields["request.id"]` |
| trace ID | primary `trace_id` |
| span ID | `span_id` |
| authenticated user ID | `logged_in_user.id` and `fields["user.id"]` |
| tenant ID | `fields["tenant.id"]` |
| locale | `fields["request.locale"]` |
| request start/deadline | Unix-millisecond fields |
| baggage | canonical OpenTelemetry baggage |
| request scope | `middleware` and `request` tags |

Applications may keep one logger per source file. Context-aware log methods
resolve the active request at emission time. Framework adapters may additionally
expose a request-bound facade such as `req.log`, a Go `context.Context` value, a
Rust request extension, or a BEAM request/process map.

Context scopes must be nested and restored. They must not leak between
concurrent requests, and child tasks/processes must use each runtime's explicit
context propagation rules.
