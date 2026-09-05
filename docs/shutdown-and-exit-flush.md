# Shutdown hooks and exit flush, per runtime and per language

A buffered logger is a promise to deliver later. Every place that promise can
be broken is a teardown: a container stop, a Ctrl-C, a tab closing, an isolate
being evicted. This is what each runtime and each SDK actually does about it.

## JavaScript runtimes

| Runtime | Hooks | Auto | Second signal | Notes |
| --- | --- | --- | --- | --- |
| Node | `beforeExit`, SIGINT, SIGTERM, SIGHUP, SIGQUIT | yes, on import | abandons the drain and re-raises | `beforeExit` re-attaches after a drain, so a revived loop still flushes |
| Bun | same as Node | yes, on import | abandons the drain and re-raises | |
| Deno | `unload`, `beforeunload`, SIGTERM, SIGINT, SIGHUP | yes, on import | exits 130 | `unload` alone was useless: it does not fire for a signal, and a signal is how a container stops |
| Browser | `pagehide`, `visibilitychange:hidden`, `freeze` | yes, on import | n/a | see below |
| Edge / Cloudflare | `ctx.waitUntil` | n/a | n/a | an isolate has no exit event; `flush()` and `close()` hand the drain to `waitUntil` |
| WASM host | host-driven | no | n/a | the embedder calls `host.flush()`; nothing fires on instance teardown |

Every runtime's hooks are removed by `close()`, so tests and embedded uses do
not leak listeners.

### Why the browser set is what it is

`beforeunload` and `unload` are gone. Both disqualify a page from the
back/forward cache, and neither fires reliably on mobile. `pagehide` fires in
every case they would have, `visibilitychange:hidden` is the last reliable
moment on mobile Safari — which routinely discards a tab without firing
`pagehide` at all — and `freeze` catches a bfcache eviction.

One teardown fires several of these in sequence, so the flush is guarded
against re-entry. The guard releases on the next task rather than never,
because a tab restored from bfcache goes on living and its next teardown has to
flush again.

`BrowserStreamTransport.flushOnExit` tries `sendBeacon` first and falls back to
a keepalive `fetch` when the beacon is refused — the per-origin beacon quota is
around 64 KiB and `sendBeacon` returns `false` once it is spent. With no
`beaconUrl` configured the records are genuinely lost, and that is reported by
count through `onError` rather than passed over in silence.

### The coordinator

`ShutdownCoordinator` (`@oresoftware/next-loggers/shutdown`) runs one graceful
drain and then an optional force phase. `gracePeriodMillis` (30 s) bounds the
drain; `flushTimeoutMillis` (5 s, `0` to disable) bounds the flush that follows
it. Those are two separate deadlines on purpose: the drain timer is cleared
before the flush begins, so without its own deadline a wedged exporter hangs
shutdown indefinitely.

## Language SDKs

| SDK | Hooks | Auto | Idempotent | Second signal | Removable |
| --- | --- | --- | --- | --- | --- |
| Node/TS | process + document events | yes | yes | yes | yes |
| Python | `atexit`, SIGTERM, SIGINT | no | yes | yes | yes |
| Go | SIGINT, SIGTERM, context cancellation | no | yes | yes | yes |
| Ruby | `at_exit`, SIGTERM, SIGINT | no | yes | yes | yes |
| Java | JVM shutdown hook | no | yes | n/a | yes |
| Rust | `Drop` (partial) | no | yes | no | n/a |
| WASM | host-driven | no | no | no | n/a |
| Dart | SIGINT, SIGTERM (`dart:io` only) | no | yes | yes | yes |
| Gleam | OTP actor call | no | no | no | no |
| Erlang | none | no | no | no | no |
| Elixir | none | no | no | no | no |

Each SDK's row is declared in `contracts/sdk-manifests/<lang>.json` under
`shutdown`, and `tests/shutdown-manifest-conformance.test.mjs` checks that the
symbols a manifest claims actually exist in the sources it lists. A manifest
that declares no process hooks must carry a promotion blocker: an SDK that
cannot drain on exit is losing records, not awaiting polish.

### Shared invariants

Where an SDK implements the lifecycle at all, it holds to the same rules:

1. **Every transport is attempted.** A failure is collected, not thrown, until
   all transports have been driven. During shutdown one unreachable
   destination must not hide the state of the rest.
2. **Close is claimed before the work, not after it.** A signal handler racing
   an ordinary `defer`/`ensure`/try-with-resources is the normal case; the
   winner is decided by an atomic claim so exactly one caller drains.
3. **The budget is a deadline, not a per-call timeout.** The remaining time is
   computed from a monotonic clock and passed down, so N transports cannot each
   consume the full allowance.
4. **A second signal wins.** Attaching a handler suppresses the kernel default.
   Swallowing the second signal leaves a process wedged on an unreachable
   collector unkillable by ordinary means, so the drain is abandoned and the
   signal re-raised.
5. **After draining, the process still dies.** A handler that drains a SIGTERM
   and then returns has made the service unstoppable. Either a caller-supplied
   handler is chained, or the default disposition is restored and the signal
   re-raised.

### Language-specific constraints worth knowing

- **Python**: `signal.signal` is legal only on the main thread of the main
  interpreter. `install_process_hooks` detects this, installs `atexit` only,
  and reports why through `ProcessHooks.reason`.
- **Ruby**: `Mutex#synchronize` raises `ThreadError` inside a trap context. The
  handler sets a plain flag — indivisible under the GVL with respect to a trap
  — and performs the blocking drain on a thread started from the handler, which
  is permitted. `at_exit` blocks cannot be deregistered, so uninstall flips a
  flag the block reads.
- **Go**: a transport that ignores its `context` is run on a worker the caller
  abandons at the deadline, so it cannot outlive the shutdown budget.
- **Java**: the JVM gives shutdown hooks no deadline, so the hook waits on a
  daemon worker for at most the configured timeout. No hook runs for `SIGKILL`
  or `Runtime.halt`, and the JVM offers no second-signal escalation.
- **Rust**: the crate is dependency-free by design and will not pull in a
  signal crate. `ShutdownStateMachine` is provided for the application to drive
  from its own `ctrlc`/`tokio::signal` wiring. Note that `std::process::exit`
  bypasses `Drop`.
- **WASM**: there is no exit event of any kind. Nothing fires when an instance
  is dropped or `proc_exit` is called, so the embedder must drain explicitly.
