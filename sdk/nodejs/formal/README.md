# Formal verification

This directory covers behavioral properties that JSON Schema cannot express.
Schema validation remains authoritative for wire shape; the models here cover
state transitions, accounting, bounded resources, shutdown, and progress.

## Models

- `ShutdownLifecycle.tla` specifies the shared TypeScript, Dart, and Rust
  graceful/forced shutdown lifecycle. TLC checks terminality, flush ordering,
  at-most-once flushing, and eventual completion after shutdown begins.
- `LogDelivery.tla` specifies a bounded OTEL/Supabase queue with admission,
  acknowledgement, retry, transport-drop, shutdown-drop, flush, and close.
  TLC checks queue/retry bounds and conservation equations that prohibit silent
  loss.
- `shutdown-transitions.v1.json` is the executable cross-language transition
  relation. Its closed JSON Schema lives under `contracts/schemas`; TypeScript,
  Dart, and Rust tests all consume the same vectors.
- `scripts/check-formal-model.mjs` exhaustively explores the finite delivery
  graph independently of TLC. This is intentionally redundant: a model or its
  implementation must be wrong in two different ways to escape both checks.

## Checked invariants

For delivery:

```text
attempted = accepted
accepted = acknowledged + queued + inFlight + overflowDropped
           + transportDropped + shutdownDropped
queued <= MaxQueue
retries <= MaxRetries
closed => drained && flushRequested && flushed && terminal
```

For shutdown:

```text
flushCount <= 1
done => flushStarted && flushCompleted && flushCount = 1
done => phase in {forced, closed} && terminal
phase != running ~> done
```

## Local checks

Run the executable model and language refinements:

```sh
npm run test:formal
cargo test --manifest-path sdk/rust/Cargo.toml --test shutdown_model --locked
(cd sdk/dart && dart test test/formal_shutdown_test.dart)
```

Run TLC 1.7.4 after verifying the published tool checksum:

```sh
curl -fsSL --proto '=https' --tlsv1.2 \
  https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o /tmp/tla2tools-1.7.4.jar
printf '%s  %s\n' \
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88' \
  /tmp/tla2tools-1.7.4.jar | sha256sum -c -
java -jar /tmp/tla2tools-1.7.4.jar \
  -config formal/ShutdownLifecycle.cfg formal/ShutdownLifecycle.tla
java -jar /tmp/tla2tools-1.7.4.jar \
  -config formal/LogDelivery.cfg formal/LogDelivery.tla
```

## Proof boundary

TLC exhaustively checks the configured finite state spaces, not arbitrary queue
sizes or the network itself. The executable language tests establish refinement
of the shared transition relation; they do not turn Dart, Rust, or JavaScript
runtime scheduling into a mathematical proof. Production observability and
fault-injection tests remain necessary alongside these checks.
