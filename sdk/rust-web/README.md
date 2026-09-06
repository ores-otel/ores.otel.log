# ores-otel-web: Rust browser/server bridge

Tracking: DEN-3432. This wraps the canonical WASM and native `next-loggers/v1`
SDKs. It is not another telemetry provider or an OTLP exporter.

## Browser (Leptos hydrate/CSR or Dioxus web)

Enable `browser` only for the wasm32-unknown-unknown target. Construct
`browser::BrowserLogger::new("my-app", sink)` in the hydration/CSR entrypoint,
not in a component render or during SSR. The sink receives the existing WASM
`LogRecord` and can capture `Rc`, `JsValue`, or an application-owned JS OTEL SDK.
The wrapper injects a real browser UTC clock and crypto-prefixed record IDs.
No console patch, panic hook, global subscriber, or provider is installed.

Create `browser::new_trace(false)` (sampling is application policy), derive a
`child_trace` for each operation, and explicitly pass it to `logger.info` and
`browser::traced_request`. Explicit context avoids bleeding between interleaved
WASM futures and independently mounted Leptos/Dioxus islands. Application-owned
exporters remain responsible for redaction, consent, bounded queues, backoff,
page lifecycle flush, and authentication. Never send secrets or raw user input
in a message. The adapter itself neither fetches nor transmits records.

`traced_request(url, &RequestInit, &trace)` retains the requested method/body,
requires the page's exact HTTP(S) origin, forces same-origin credentials/mode,
and rejects redirects to prevent trace-header leakage. Pass the resulting
Request to the application's fetch client. Cross-origin APIs need a separately
reviewed origin/redirect/CORS policy; they are intentionally not enabled here.
Leptos server functions and Dioxus fullstack clients are NOT monkey-patched:
use their explicit custom-client integration or issue this Request directly.

## Native Axum 0.8

Enable `axum` only on the native server target, then wrap the fully assembled
router (including existing auth/audit middleware):

```rust,ignore
let app = ores_otel_web::server::install(app, env!("CARGO_PKG_NAME"));
```

Use `install_with_logger` to retain an application-owned next-loggers Logger,
its transports, and its shutdown/flush guard. The convenience installer emits
structured next-loggers JSON to stdout, without installing a global provider.
It accepts exactly one valid version-00 `traceparent`, creates a new server
span ID, preserves the trace ID/flags, scopes the existing poll-safe carrier,
and records only method/status plus correlation. Invalid/duplicate headers
start a new unsampled root. No incoming user/tenant/session identity, baggage,
tracestate, URL, query, body, cookies or authorization is trusted or recorded.
Auth remains entirely independent. HTTP/export failure paths remain separate.
The scope covers handler execution through response creation, NOT subsequent
streaming response-body polling or detached tasks; explicitly carry context to
those tasks using the canonical context helpers.

## Verification

`cargo test -p ores-otel-web --features axum`; compile the same crate for
wasm32-unknown-unknown with `--features browser`; `wasm-pack test --headless
--chrome sdk/rust-web --features browser`. CI rejects native server dependencies
in the browser graph. Independent consumer and framework compile fixtures live
in the sibling ores-otel-test organization. Do not call production deployment,
OTLP delivery, framework custom-client installation, or page lifecycle delivery
verified based only on these tests.
