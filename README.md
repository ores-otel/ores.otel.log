<!-- ores-otel-canonical -->
> **Canonical repository:** [`ores-otel/ores.otel.log`](https://github.com/ores-otel/ores.otel.log). `ORESoftware/next-loggers.ts` remains the legacy compatibility remote.

# @oresoftware/next-loggers

Dependency-free, ESM-only loggers for Next.js, browsers, edge workers, Cloudflare Workers, Node.js, Bun, and Deno. Log events are chainable, safely serialized, and can be sent to HTTP endpoints or streamed over Supabase Realtime WebSockets.

## Install

```sh
npm install @oresoftware/next-loggers
```

The package intentionally does not ship a CommonJS build. It works from `.mjs` files and ESM TypeScript projects.

## Kubernetes OTLP sidecar

The `oresoftware/otel-k8s-sidecar` Zed target packages a hardened, opt-in
OpenTelemetry Collector sidecar for application-owned OTLP logs, metrics, and
traces. It listens on pod-local loopback, applies bounded memory, queue, retry,
batching, resource enrichment, and high-risk attribute deletion, then forwards
to one explicitly configured OTLP/gRPC gateway. It does not scrape Kubernetes
CRI/stdout logs; cluster-level log collection remains the node agent's job.

The target includes a machine-readable, exact-head adoption catalog for 12
GitHub repositories with existing Kubernetes workloads, plus a deterministic
strategic-merge patch renderer. See [`sidecar/README.md`](sidecar/README.md) for
the threat model, Zed install flow, rollout gates, and candidate matrix.

## Polyglot SDKs

The repository also contains native logger libraries for services that feed
the same logging pipeline:

| Language | Source package |
| --- | --- |
| Python | [`sdk/python`](sdk/python) |
| Go | [`sdk/go`](sdk/go) |
| Rust | [`sdk/rust`](sdk/rust) |
| Gleam | [`sdk/gleam`](sdk/gleam) |
| Java | [`sdk/java`](sdk/java) |
| Dart / Flutter | [`sdk/dart`](sdk/dart) |
| Ruby | [`sdk/ruby`](sdk/ruby) |
| Erlang | [`sdk/erlang`](sdk/erlang) |
| Elixir | [`sdk/elixir`](sdk/elixir) |
| Rust / WebAssembly | [`sdk/wasm`](sdk/wasm) |

All implementations emit the strict `next-loggers/v1` wire record in
[`contracts/log-record.schema.json`](contracts/log-record.schema.json). They
share levels, chainable event enrichment, idempotent `send`, transport
lifecycle hooks, minimum-level filtering, and recovery of unsent events during
`flush_on_exit`/`close`. Public logger, event, record, options, level, and
transport types are exported so applications can subclass, embed, wrap, or
compose them according to the language.

Every SDK also exposes dependency-free, application-owned OpenTelemetry and
Supabase transports. The application injects its OTEL emitter or authenticated
Supabase sender; the logger never registers a global telemetry provider or
patches a runtime. The common OTEL bridge shape is documented in
[`docs/otel.md`](docs/otel.md).

Node backends can report failures inside the observability path through an
independent, payload-free control plane backed by AWS CloudWatch Logs, Google
Cloud Logging, Azure Monitor, and direct structured stderr. Browser and edge
runtimes can use a one-shot, short-lived signed object upload as an outage
spool without receiving native logging credentials. See the security model,
provider bindings, and deployment requirements in
[`docs/internal-diagnostics.md`](docs/internal-diagnostics.md).

Run every native conformance suite with:

```sh
npm run test:polyglot
```

Each SDK also includes an `r2g` downstream-consumer skeleton so its packaged
artifact can be tested as a dependency, not only from its own source tree.

## Runtime entry points

The root import uses package export conditions. Next.js can select `browser`, `edge-light`, or `node`; Deno and Bun select their own conditions.

```ts
import { logger } from '@oresoftware/next-loggers';
```

The root covers every shipped runtime: `browser`, `edge-light`/`worker`, `workerd` (Cloudflare Workers), `deno`, `bun`, and `node`, followed by the universal base fallback.

Explicit entry points are also available and are recommended when the runtime is known:

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';
import { createCloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import { createBunLogger } from '@oresoftware/next-loggers/bun';
import { createDenoLogger } from '@oresoftware/next-loggers/deno';
import { createLogger } from '@oresoftware/next-loggers/base';
```

Every runtime entry also re-exports the shared surface as a `base` namespace, so
the base contracts are reachable without a second import. The namespace carries
types as well as values:

```ts
import { createEdgeLogger, base } from '@oresoftware/next-loggers/edge';

const transport: base.LogTransport = {
  write(record: base.LogRecord) {
    void base.serializeLogValue(record.values);
  },
};
```

## Basic use

```ts
import { createNodeLogger } from '@oresoftware/next-loggers/node';

const log = createNodeLogger({
  appName: 'checkout-api',
  maxLevel: 'info',
  fields: { service: 'checkout' },
});

await log
  .error('Payment failed', new Error('card declined'))
  .addTrace('trace-123', { makeFirst: true })
  .addRoutineId('charge-card')
  .addTags('payments', 'stripe')
  .addFields({ orderId: 'order-42' })
  .addContext({ attempt: 2 })
  .send();

await log.flush({ timeoutMillis: 2_000 });
// At a logout/release boundary, require evidence instead of fail-open draining:
await log.flush({ timeoutMillis: 2_000, throwOnError: true });
```

Circular references, errors, dates, bigints, maps, sets, functions, and symbols are normalized before transport.

## ESLint: require `.send()`

The ESM-only ESLint plugin supports ESLint 9 and 10 flat config. Its recommended rule warns when a standalone logger chain forgets `.send()`:

```js
// eslint.config.mjs
import nextLoggers from '@oresoftware/next-loggers/eslint';

export default [nextLoggers.configs.recommended];
```

```ts
log.info('foo'); // warning: Call .send() on this log event
log.info('foo').addFields({ orderId }).send(); // okay
```

The rule recognizes package singleton imports, default imports, namespace imports, logger factories, exported logger classes, and the common names `log`, `logger`, and `ddlog`. Configure additional application-specific names directly:

```js
import nextLoggers from '@oresoftware/next-loggers/eslint';

export default [
  {
    plugins: { 'next-loggers': nextLoggers },
    rules: {
      'next-loggers/require-send': ['warn', { loggerNames: ['audit', 'telemetry'] }],
    },
  },
];
```

The rule intentionally expects an explicit `.send()`. If a specific logger relies on `autoSend: true`, disable or scope the rule for that code.

## Supabase Realtime WebSocket streaming

Pass a Supabase project URL and publishable/anon key. The transport joins `realtime:next-loggers` by default and broadcasts `log` events.

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';

const log = createBrowserLogger({
  appName: 'storefront',
  maxLevel: 'info',
  supabase: {
    url: 'https://your-project.supabase.co',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    channel: 'application-logs',
    event: 'log',
  },
});

await log.info('cart updated', { itemCount: 3 }).send();
```

Use only a publishable/anon key in browser code—never a Supabase service-role key. Realtime Broadcast delivers events; it does not insert rows by itself. If logs must be stored, run a trusted subscriber that validates each event and inserts it into the desired table.

Node versions without a global `WebSocket` can supply a factory from their preferred WebSocket library:

```ts
const log = createNodeLogger({
  supabase: {
    url: process.env.SUPABASE_URL!,
    anonKey: process.env.SUPABASE_ANON_KEY!,
    webSocketFactory: (url) => new MyWebSocket(url),
  },
});
```

## HTTP transport

```ts
const log = createEdgeLogger({
  appName: 'edge-auth',
  http: {
    endpoint: 'https://logs.example.com/v1/events',
    headers: { authorization: `Bearer ${token}` },
  },
});
```

`fallbackEndpoint` gives every HTTP transport a priority/fallback pair (for
example your own Next/Vercel route first, a Google Apps Script collector
second), and `method` supports `POST`/`PUT`/`PATCH`:

```ts
http: {
  endpoint: 'https://app.example.com/api/err-trace',
  fallbackEndpoint: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
}
```

Custom transports implement one small interface:

```ts
import type { LogTransport } from '@oresoftware/next-loggers/base';

const transport: LogTransport = {
  name: 'my-transport',
  async write(record) {
    // Deliver the JSON-safe record.
  },
};
```

### Route OpenTelemetry per event

OpenTelemetry transports receive records by default. Set `otel: false` on a
logger to make them opt-in, then override one event without changing delivery
to HTTP, Supabase, memory, or any other transport:

```ts
const log = createLogger({
  otel: false,
  transports: [otelTransport, supabaseTransport],
});

await log.info('sampled in').useOtel().send();
await log.warn('OTEL excluded').notOtel().send();
await log.info('computed').withOtel(routeToOtel).send();
await log.info('back to default').useOtel().resetOtel().send();
```

`event.isOtelEnabled(fallback)` resolves the per-event value. Logger
`setOtelEnabled()`, `useOtel()`, and `notOtel()` update the default in the
options object, so `anew()` children inherit it. An OTEL transport is identified
by `otel: true` or the name `opentelemetry`; the built-in bridge sets both.

`withOpenTelemetry(options, bridge)` appends the built-in bridge while
preserving existing transports. If the bridge supplies `activeSpan`, it also
installs span correlation unless the options already contain an explicit
`contextProvider`.

## Error tracking

Send `ERROR`/`FATAL` records (configurable via `minLevel`) to a dedicated
collector, chainable at construction time:

```ts
export const logger = new BaseLogger()
  .setALS(requestContext)
  .setErrorTrackingUrl('https://app.example.com/api/err-trace', {
    fallbackUrl: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
  });
```

Identical records are deduped by a level/runtime/message/trace hash (capped at
5000 entries; a failed send releases the hash so the next occurrence retries).
Pass `dedupe: false` to disable.

## Ambient context (AsyncLocalStorage)

`@oresoftware/next-loggers/context` stores per-request context in
`AsyncLocalStorage` on Node, Bun, Deno, and edge runtimes; browsers get a
single-frame fallback through the package's `browser` export condition:

```ts
import { installLogContextProvider, runWithLogContext } from '@oresoftware/next-loggers/context';

installLogContextProvider(); // every logger now reads the ambient frame

await runWithLogContext(
  { loggedInUser: { id: userId }, traceId: requestId, fields: { route } },
  () => handleRequest(request),
);
```

Merge precedence, lowest to highest: logger state, ambient context,
event-level calls. To attach your own store (any object with `getStore()`,
including zone-based stores) to a single logger:

```ts
export const logger = new BaseLogger().setALS(myStorage, (store) => ({
  loggedInUser: { id: store.userId },
  traceId: store.requestId,
}));
```

## Config file: .next-logger.ts

`@oresoftware/next-loggers/config` loads `.next-logger.ts` (or `.mts`/`.mjs`/
`.js`) from the project root. TypeScript configs load natively on Bun, Deno,
and Node >= 22.18 (type stripping). The config is code, so it can read env
vars and construct transports:

```ts
// .next-logger.ts
import type { LoggerOptions } from '@oresoftware/next-loggers/base';

const config: LoggerOptions = {
  appName: 'my-app',
  maxLevel: process.env.DD_ENV === 'production' ? 'info' : 'trace',
  errorTracking: { url: process.env.ERR_TRACE_URL!, fallbackUrl: process.env.GAS_URL },
};
export default config;
```

```ts
import { createLoggerFromConfig } from '@oresoftware/next-loggers/config';
export const logger = await createLoggerFromConfig();
```

`NEXT_LOGGER_*` env vars override the file (`NEXT_LOGGER_APP_NAME`,
`NEXT_LOGGER_MAX_LEVEL`, `NEXT_LOGGER_ERROR_TRACKING_URL`,
`NEXT_LOGGER_ERROR_TRACKING_FALLBACK_URL`, `NEXT_LOGGER_HTTP_ENDPOINT`,
`NEXT_LOGGER_SUPABASE_URL`, ...). The names pair with CLI flags via
[flags-2-env](https://github.com/oresoftware/flags-2-env):
`--next-logger-app-name=x` becomes `NEXT_LOGGER_APP_NAME=x`.

## Redaction

Values, fields, context, meta, and error properties whose keys contain
`password`, `token`, `secret`, `email`, `phone`, `ssn`, `bankaccount`, or
`authtoken` are replaced with `[REDACTED]` by default. The
`loggedInUser`/`users` identity blocks are exempt so correlation keeps
working. Configure with `redactKeys: ['mypattern']` or disable with
`redactKeys: false`.

## Next.js

Client component:

```tsx
'use client';

import { createBrowserLogger } from '@oresoftware/next-loggers/browser';

const log = createBrowserLogger({ appName: 'web' });
```

Node route handler or server component:

```ts
import { createNodeLogger } from '@oresoftware/next-loggers/node';
```

Edge middleware/route code can pass an execution context so remote delivery is attached to the request lifetime:

```ts
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';

const log = createEdgeLogger({
  appName: 'middleware',
  executionContext: event,
  request,
});

void log.warn('request blocked').send();
```

## CLI

The package ships a `next-loggers` executable.

```sh
npx next-loggers doctor          # will logging behave correctly here?
npx next-loggers resolve --runtime workerd
npx next-loggers smoke --depth full
your-app | npx next-loggers pretty
```

| Command | What it does |
| --- | --- |
| `doctor` | Reports runtime, **whether async context is really tracked**, config discovery, effective level, and platform capabilities. `--strict` turns warnings into exit 1. |
| `resolve` | Walks the package's own `exports` map for a condition set and prints what each subpath resolves to — for *any* runtime, from any host. |
| `smoke` | Imports an installed build and verifies it. This is the `zed r2g` entry point and the only automatic guard against publishing a stale `dist/`. |
| `pretty` | Renders `next-loggers/v1` NDJSON from stdin. Non-JSON lines pass through untouched, so it is safe at the end of any pipeline. |
| `flags` | Prints the flag/env contract; `--check` fails on drift. |

`doctor` exists for one reason above the others: when the single-frame context
fallback is active, concurrent requests can observe each other's context, and
nothing surfaces that at runtime. `resolve` answers the question behind the
shipped bug recorded in [docs/AUDIT.md](docs/AUDIT.md) — a missing `workerd`
condition on `./context`:

```sh
$ next-loggers resolve --runtime workerd --subpath ./context
conditions: workerd, worker, import, default
  ./context  →  ./dist/context-workerd.js
```

### Flags are environment variables

Following the [flags-2-env](https://github.com/oresoftware/flags-2-env)
convention, every flag has an environment variable, declared in
[`.cli-flags.toml`](.cli-flags.toml). The library-contract flags write the same
`NEXT_LOGGER_*` variables [`src/config.ts`](src/config.ts) reads, so a flag and
its variable are genuinely interchangeable:

```sh
next-loggers doctor --max-level debug
NEXT_LOGGER_MAX_LEVEL=debug next-loggers doctor
```

The CLI does **not** parse that file at runtime — flags-2-env's Node client is
an N-API addon needing a C toolchain, and this package ships zero runtime
dependencies. `src/cli/spec.ts` declares the same contract in TypeScript and
`tests/cli-flags.test.mjs` asserts the two never drift in either direction
(`next-loggers flags --check` runs the same comparison). This mirrors zed-cli,
which keeps clap as its parser and `.cli-flags.toml` as the portable contract.

Two deviations from upstream semantics, both documented in the TOML header: a
declared default never outranks a real environment variable (upstream lets it,
which here would fabricate configuration the user never wrote), and `array`
flags are repeatable.

## Installing with zed-pkg

The package publishes to both npm and the [zed-pkg](https://zpkg.tech)
registry, declared in [`.zpkg.toml`](.zpkg.toml):

```sh
zed add oresoftware/next-loggers
```

The org/name pair composes to the npm name, and the `node` adapter links
`node_modules/@oresoftware/next-loggers`, so the import specifier is identical
whichever registry it came from. Note the zpkg name is `next-loggers`, not
`next-loggers.ts` — package names must match `[a-z0-9][a-z0-9-]*[a-z0-9]`.

Releasing requires a matching `v{version}` tag at HEAD. **Build first:**
`zed pack` walks the filesystem rather than the VCS index, and publishing a
missing `dist/` is only a warning — `zed r2g` is what catches it:

```sh
npm run build && zed r2g && zed publish
```

Zed lifecycle uses executable convention files under `.zed/<phase>` for pre/post
install, pre/post build, pre-pack, and pre-publish. The explicit
`[lifecycle.<phase>]` form stays deferred until the strict Zed manifest validator
accepts it. The hooks run the
same JSON Schema, package, runtime, and `just env-check` gates used by CI. They do
not contain secrets: public age recipients live in `.sops.yaml`, ciphertext in
`env/enc`, and decrypted mode-0600 files only in ignored `env/dec`.

## Streaming browser logs over a WebSocket

`BrowserStreamTransport` keeps a persistent socket open and ships records in
batches. It exists because a browser tab needs three things a per-record
transport does not give you: batching (a chatty page emits hundreds of records a
second), a bounded queue that survives disconnects (tab sleep and proxy resets
are normal), and a last-gasp flush on `pagehide`, where async sends are
unreliable.

```ts
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';

const log = createBrowserLogger({
  appName: 'web',
  includeDeviceContext: true,
  captureGlobalErrors: true,
  captureUnhandledRejections: true,
  captureCspViolations: true,
  stream: {
    url: 'wss://logs.example.com/ingest',
    batchSize: 120,
    flushIntervalMillis: 2_500,
    urgentFlushDelayMillis: 250,
    maxQueueSize: 2_000,
    beaconUrl: 'https://logs.example.com/ingest-beacon',
  },
});

await log.error('checkout failed', err).send();
```

ERROR and FATAL flush on the short delay; everything else rides the idle
cadence. When the queue is full the oldest records are dropped and counted —
read `log.streamTransport.dropped` rather than assuming nothing was lost.

The destination is pluggable. Point `url` at any WebSocket collector, or hand it
an existing transport to get only the batching and buffering policy:

```ts
import { SupabaseRealtimeTransport } from '@oresoftware/next-loggers/base';
import { createBrowserStreamTransport } from '@oresoftware/next-loggers/browser-stream';

const stream = createBrowserStreamTransport({
  transport: new SupabaseRealtimeTransport({ url, anonKey }),
  batchSize: 50,
});
```

## Serialization limits

Every record is serialized under caps, so one oversized payload cannot take down
the process it was meant to diagnose. Truncation is always marked, never silent.

```ts
const log = createNodeLogger({
  limits: {
    maxStringLength: 20_000, // strings → 'xxx…[truncated N chars]'
    maxDepth: 12,            // deeper → '[Max depth 12 exceeded]'
    maxArrayLength: 1_000,   // arrays/Sets/Maps → trailing '[+N more of M]'
    maxProperties: 200,      // objects → '__truncatedKeys: N'
  },
});
```

Defaults live in `DEFAULT_SERIALIZE_LIMITS`.

## Async context across runtimes

`@oresoftware/next-loggers/context` resolves per runtime. `AsyncLocalStorage`
works on Node, Bun, Deno and Vercel Edge; Cloudflare Workers only provide it
behind `compatibility_flags = ["nodejs_als"]`, and browsers never do. Rather
than crash at import on an unflagged Worker, those builds fall back to a
single-frame store that **cannot** isolate concurrent async flows — so check
before relying on per-request isolation:

```ts
import { isAsyncContextTracked, runWithLogContext } from '@oresoftware/next-loggers/context';

if (!isAsyncContextTracked()) {
  // Single-frame fallback: overlapping requests can observe each other's context.
}
```

## Cloudflare Workers

`@oresoftware/next-loggers/cloudflare` is what the `workerd` export condition
selects, so a plain root import already resolves to it inside a Worker. It adds
Workers-specific record fields on top of the edge behaviour: `rayId` from
`cf-ray`, the colo/geo/network properties off `request.cf`, and cron metadata on
scheduled invocations.

A module-scope logger outlives the request but has no `ctx`, so bind it per
invocation with `forRequest()` / `forScheduled()` — otherwise delivery races the
isolate going idle:

```ts
import { createCloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';

const log = createCloudflareWorkerLogger({
  appName: 'orders-worker',
  http: { endpoint: 'https://logs.example.com/collect' },
  envFields: ['ENVIRONMENT'],
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestLog = log.forRequest(request, ctx, env);
    await requestLog.info('order received').send();
    return new Response('ok');
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await log.forScheduled(controller, ctx, env).info('reconcile started').send();
  },
};
```

`envFields` copies only string/number/boolean vars — KV/R2/D1/Durable Object
bindings are skipped — and the values still pass through redaction, so a var
named `API_TOKEN` is masked. `request.cf` properties can be turned off with
`includeCfProperties: false`; the `cf-connecting-ip` client address is omitted
unless you opt in with `includeClientIp: true`.

The Workers types are matched structurally, so this package still has no
dependency on `@cloudflare/workers-types`.

For Next.js `after()`, pass it without making this package depend on Next:

```ts
import { after } from 'next/server';
import { createNodeLogger } from '@oresoftware/next-loggers/node';

const log = createNodeLogger({ appName: 'web', after });
```

Every transport promise is also tracked in the exported `pendingLogPromises` registry, analogous to a focused `dd-proms.ts`. `waitForPendingLogs()` drains writes across logger instances.

## Shutdown delivery

Runtime loggers install coordinated lifecycle drains by default:

- Browser loggers flush on `pagehide`, `beforeunload`, and `unload`. HTTP writes use `keepalive`, and active records are retried through `navigator.sendBeacon()` when available.
- Node and Next.js loggers flush all registered instances on one-shot `beforeExit`, `SIGINT`, and `SIGTERM`, then re-raise the signal so normal exit semantics are preserved.
- Bun uses the equivalent process lifecycle only when actually running under Bun.
- Deno performs a best-effort drain on its `unload` event.
- Edge loggers attach each send to the provided `executionContext.waitUntil()`.

Shutdown also sends any chain event that was created but never explicitly sent. The ESLint rule catches that mistake earlier, while the runtime behavior is the safety net.

```ts
await log.flushOnExit({ timeoutMillis: 4_000 });
await log.close({ timeoutMillis: 4_000 });
```

Set `flushOnShutdown: false` for Node/Bun or `flushOnUnload: false` for browser/Deno when the host owns lifecycle coordination. A direct `process.exit()` cannot wait for asynchronous JavaScript; call `await log.close()` before using it. Browser shutdown APIs are inherently best-effort, so use the HTTP transport in addition to WebSocket streaming when the final records must be persisted.

## Formal verification

Wire records and cross-language fixtures are constrained by JSON Schema. The
behavioral layer is checked separately with TLA+ and executable finite-state
models under [`formal/`](formal/README.md):

- the shared TypeScript, Dart, and Rust shutdown transition relation is total,
  monotonic, terminal, and flushes at most once;
- the bounded OTEL/Supabase delivery model accounts for every attempted record
  as queued, in flight, acknowledged, or explicitly dropped;
- queue capacity and retry limits remain invariant when producers refill a
  queue while a failed batch is in flight;
- the non-reentrant internal-diagnostic reporter conserves delivered, failed,
  suppressed, closed-rejected, and in-flight reports and never reopens after
  close;
- a completed close is drained, flushed, and terminal; TLC also checks eventual
  completion under the model's fairness assumptions.

`npm run test:formal` runs the executable state-space explorer and TypeScript
refinement. CI additionally runs the pinned TLA+ checker and the Rust and Dart
refinement suites. These checks complement concurrency, fault-injection, and
real-runtime tests; the finite bounds and proof boundary are documented with
the models.

## Extending the classes

All logger and event classes are public. Protected event state and logger hooks allow custom event builders, console formatting, dispatch, and runtime fields without forking the package:

```ts
import {
  BaseLogger,
  LogEvent,
  type LogArgument,
  type LogLevel,
} from '@oresoftware/next-loggers/base';

class AuditEvent extends LogEvent {
  withActor(actor: string): this {
    this.fields.actor = actor;
    return this;
  }
}

class AuditLogger extends BaseLogger<AuditEvent> {
  constructor() {
    super({ appName: 'audit' }, 'custom-audit-runtime');
  }

  protected override createLogEvent(level: LogLevel, values: LogArgument[]): AuditEvent {
    return new AuditEvent(this, level, values);
  }
}

await new AuditLogger().info('changed role').withActor('user-1').send();
```

## Behavior

- Levels are ordered as `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.
- Calls return a `LogEvent`; call `.send()` after adding context.
- Set `autoSend: true` to enqueue `.send()` in a microtask.
- Console output is enabled by default; set `console: false` to disable it.
- `.send(false)` writes to the console but skips remote transports.
- `.notOtel()` skips only OTEL transports; all other transports still receive the record.
- `.flush()` waits for pending transport writes; pass `sendUnsent: true` to recover unfinished chains and `throwOnError: true` when a bounded lifecycle boundary must observe delivery/timeout failure.
- `.flushOnExit()` sends unfinished chains and runs transport shutdown hooks.
- `.close()` performs the shutdown flush and then closes transports.
