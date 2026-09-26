# Native desktop shared runtime rollout

Tracking: https://github.com/ores-otel/ores.otel.log/issues/105

Use `next_loggers::desktop::DesktopSession::start(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))` at the application lifecycle boundary and retain the guard until the event loop returns. It emits next-loggers/v1 structured JSON on stderr, collects no argv/environment/user data, installs no global subscriber, and makes no network calls. Existing tracing remains independent. This is lifecycle coverage, not complete migration of application logging.

Call `finish()` to observe shutdown transport failures. Drop attempts best-effort close, distinguishes unwinding, and cannot run after process::exit/abort/forced termination. Custom transports must be local and nonblocking. OS stderr itself can be backpressured; this is not a bounded shutdown guarantee. Keep authentication and personal payloads out of supplied identity fields.

Rust desktop shells retain their native toolkit or typed QML/FFI layer. Flutter shares provider contracts and Dart SDKs, not UI source. This repository already has Rust, WASM, Dart, TypeScript and Gleam SDK directories; the new lifecycle convenience adapter is currently Rust-only. Do not claim equivalent lifecycle adapters in other runtimes until their own tests pass.

The full program also needs forms, support/sales bots, human groups, sync, pipelines, embeddings, drag/drop, cache deltas, time series, WASM loading, locks/leases, visualizations, contract admission, and zed installation. Provider existence is not API/behavioral parity. Never import private server ORM or provider credentials into desktops. Human-authored TypeSpec and JSON Schema stay peer authorities with TJSV admission. Keep external multi-language SDKs broader than the four internal runtimes.

Acceptance: test error/cleanup/unwind behavior; compile each consumer at the exact shared revision; update Cargo and zed locks with their authoritative tools; prove macOS/Linux/Windows packaging and feature-specific native builds before promotion. Draft consumers are incomplete until these gates pass.
