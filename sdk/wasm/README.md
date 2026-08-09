# oresoftware-next-loggers-wasm

WASM-safe Rust implementation of the shared `next-loggers/v1` structured
logging contract. Context and telemetry sinks are injected explicitly; the
crate does not install global OpenTelemetry providers or patch a host runtime.

The crate is suitable for `wasm32-unknown-unknown` and native conformance tests.
