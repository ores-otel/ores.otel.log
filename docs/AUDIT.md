# Audit: `@oresoftware/next-loggers` vs. the `dd-next-1` reference loggers

Reference material read for this audit (~12k lines):

| File | Lines | Role |
| --- | ---: | --- |
| `src/lib/isomorph/logging/logger-5.ts` | 2054 | The live core (`ddlog`), protected from edits |
| `src/lib/isomorph/logging/logger-7.ts` | 2220 | Newer variant, used by one tool |
| `src/lib/client/logging/browser-log-collector.ts` | 1973 | Ring buffer + Supabase WS/RPC/REST ingestion |
| `src/lib/server/logging/dd-nodejs-log.ts` | 1320 | Node logger: ALS, Drizzle fallback, TTY |
| `src/lib/client/logging/dd-client-log.ts` | 1277 | Browser logger |
| `src/lib/isomorph/logging/deep-mixin-fixed.ts` | 965 | Deep merge |
| `src/lib/edge/logging/dd-edge-log.ts` | 863 | Edge logger |
| `src/lib/isomorph/logging/dd-runtime-logger-contracts.ts` | 254 | Shared abstract base classes |
| `src/lib/isomorph/logging/dd-log.ts` | 295 | Singleton + Node process handlers |

Also reviewed for wire-format inspiration: [bunion](https://github.com/oresoftware/bunion),
[json-stdio](https://github.com/oresoftware/json-stdio).

---

## 1. Async context: what actually works where

The direct answer to "async hooks may only work in nodejs not in bun or deno?" —
**`node:async_hooks` `AsyncLocalStorage` works in Bun and Deno.** They are not
the problem. The real failure cases are Cloudflare Workers and browsers.

| Runtime | `node:async_hooks` `AsyncLocalStorage` | What this package now resolves to |
| --- | --- | --- |
| Node.js | Native | `context.js` — real ALS |
| Bun | Implemented | `context.js` — real ALS |
| Deno | Implemented | `context.js` — real ALS |
| Vercel Edge (`edge-light`) | Available | `context.js` — real ALS |
| Cloudflare Workers (`workerd`) | **Only with `nodejs_als` / `nodejs_compat`** | `context-workerd.js` — global probe, else fallback |
| Browsers | Never | `context-browser.js` — single-frame fallback |

### The bug this exposed

`src/context.ts` imports `node:async_hooks` **statically**. On a Worker deployed
without `nodejs_als`, that import throws during module evaluation — killing the
isolate at startup, before any logging call runs. The `./context` export map had
no `workerd` condition, so workerd fell through to that file.

Fixed by adding a `workerd` condition pointing at `src/context-workerd.ts`, which
reads `globalThis.AsyncLocalStorage` (present when the flag is on) and otherwise
degrades to the single-frame store. Every variant now exports
`isAsyncContextTracked()` so callers can detect the degraded mode instead of
silently assuming per-request isolation — the single-frame fallback **cannot**
isolate concurrent async flows, and quietly pretending otherwise would leak one
request's user id onto another's logs.

The three variants previously duplicated `updateLogContext`; they now share
`src/context-shared.ts`, so merge semantics cannot drift between runtimes.

> Bun and Deno are not installed on this machine, so their behaviour above is not
> locally verified — it is asserted by the new CI matrix (§4), which runs the
> conformance suite on real Bun, Deno, workerd and Chromium.

---

## 2. Already at parity before this audit

The chainable event API is a near-exact match for `DDLoggerWithLevelBase`:
`addFields`, `addTrace`/`addTraceId` (with `makeFirst`), `addRoutineId`,
`addTags`/`addTagList`, `addContext`, `addMeta`, `addLoggedInUserInfo`,
`addUserInfo`, `setUserContext`, `captureStackTrace`, `getHashCode`, `getJSON`,
`toJSON`.

Also already present: the identical default redaction key list, unsent-event
tracking plus the `require-send` ESLint rule (a stronger version of the
reference's `MustSend<T>` phantom type, since it is enforced at lint time),
HTTP transport with a fallback endpoint, error-tracking with a dedupe hash set
and eviction, Supabase Realtime, `waitUntil`/`after` lifecycle hooks,
`flushOnExit` with `sendBeacon`, and Node process lifecycle draining.

---

## 3. Gaps found, and what was done

### Closed in this pass

| Gap | Reference behaviour | What was added |
| --- | --- | --- |
| **No size caps on serialization** | Truncates strings/objects at 20 000 chars | `SerializeLimits` (`maxStringLength` 20k, `maxDepth` 12, `maxArrayLength` 1000, `maxProperties` 200), applied in `serializeValue` and configurable per logger. Truncation is *marked*, never silent. |
| **No browser log streaming** | `browser-log-collector` streams over a Supabase Realtime WebSocket with batching and a replay buffer | `BrowserStreamTransport`: batching, bounded queue with a `dropped` counter, reconnect + replay, connect timeout, `pagehide`/`visibilitychange` beacon flush. Destination-agnostic — raw WS, Supabase, or wrap any transport. |
| **Thin browser context** | Collects screen, viewport, timezone, orientation, connection | `includeDeviceContext` option on `BrowserLogger` |
| **No CSP violation capture** | `securitypolicyviolation` listener | `captureCspViolations` option |
| **workerd could crash at import** | n/a | §1 above |
| **No Cloudflare Worker logger** | n/a (reference predates it) | `CloudflareWorkerLogger` with `cf`/ray/cron/env fields and `forRequest`/`forScheduled` |

### Two real defects found while doing the above

1. `LogEvent.getHashCode()` called `this.values.map(serializeLogValue)` point-free.
   Once `serializeLogValue` gained a second parameter, `Array.map` began passing
   the element **index** as the limits object. Caught by the compiler; now
   `.map((value) => serializeLogValue(value))`. The same shape would have broken
   silently had the second parameter been added as an options bag with defaults.
2. `BrowserStreamTransport` had no connect timeout, so a socket wedged in
   `CONNECTING` (captive portal, dropped SYN) stalled the flush loop forever and
   the queue never drained. Found because the test suite hung. Fixed with
   `connectTimeoutMillis` (default 8s) and covered by a regression test.

### Still open, in priority order

1. **Ring buffer + incident snapshot** — the largest remaining behavioural gap.
   The reference keeps the last ~5 000 entries (capped at 500 KB) *below* the
   console threshold and ships the whole buffer when an error fires, so you get
   the lead-up to a failure and not just the failure. `BrowserStreamTransport`'s
   queue is a delivery buffer, not a diagnostic one. Recommended next piece.
2. **Browser session id** — persistent id in `sessionStorage` + cookie with a
   fingerprint suffix, correlating browser logs with server logs. Cheap, high value.
3. **Error codes** — `setCode(DDLErrCode)` plus the `errorType` / `priorityLevel`
   mappings used by the error-tracking table.
4. **Deployment identity** — commit SHA and normalized environment label on every
   record. The reference reads `NEXT_PUBLIC_COMMIT_SHA` and friends; without it,
   correlating an incident to a deploy is manual.
5. **Node host identity** — `hostname` and `pid` fields.
6. **TTY output** — colorized human-readable output when `stdout.isTTY`, plus a
   bunion-compatible `["@bunion:1", appName, level, pid, host, date, fields, msg]`
   stdout transport so `| bunion` and json-stdio parsers work against this logger.
7. **`logOnce`** — one-time notice when a level is suppressed by config.
8. **Build-phase skip** — no-op during `NEXT_PHASE=phase-production-build`.
9. **EPIPE/ECONNRESET suppression** — the reference ignores EPIPE explicitly
   because logging it during shutdown recurses. Our Node handlers do not log
   uncaught exceptions at all yet, so we are not currently exposed.
10. **Broader stack filtering** — we drop only our own frames; the reference also
    drops `node_modules`, `app-page.runtime.prod.js`, `/var/task/.next`.
11. **ReportingObserver** and resource-load-error capture.

### Deliberately *not* ported

- **Client-side IP lookup** (`api.ipify.org`, `ipapi.co`, `cloudflare.com/cdn-cgi/trace`).
  A logging library should not make third-party network calls from a user's
  browser: it is a privacy exposure, an availability dependency, and a
  fingerprinting vector. The server already sees the client IP — on Cloudflare
  it is `cf-connecting-ip`, which the new Worker logger surfaces behind an
  explicit opt-in.
- **Clerk-specific user capture** (`window.Clerk.user`, `publicMetadata.ddUserId`).
  App-specific. The generic `contextProvider` / `setALS` hooks cover it without
  binding the package to an auth vendor.
- **The hard-coded Google Apps Script endpoint.** Configuration, not library code.
  The `mode:'no-cors'` hazard documented in `logger-5.ts` is worth preserving as
  institutional knowledge though: on Node, `no-cors` makes undici silently strip
  non-CORS-safelisted headers including `Content-Type`, so the collector receives
  an unparseable body and the request hangs to timeout. `HttpTransport` never
  sets `no-cors`, so this package is not exposed — but anyone adding a browser
  no-cors path must gate it on `typeof window !== 'undefined'`.

---

## 4. Coding patterns that differ, and why ours should stay

The prompt asked whether our patterns are valid where they diverge. Four places
where the reference's approach is actively worth *not* copying:

1. **Per-call trace logging.** Reference `warn()`/`error()`/`fatal()` each emit a
   `ddlog.trace('Entered warn')` record before doing anything. That is a second
   full log record per call, and it routes through the same singleton that is
   mid-call — a recursion hazard and a large constant-factor cost on a hot path.
2. **`send()` inside the constructor.** `DDLoggerWithLevel`'s constructor loops
   over `missingLogs` and calls `v.send()` on every pending event — so
   constructing one log event performs unbounded work and can re-enter the
   logger. We track unsent events and flush explicitly.
3. **`send()` returning a trace-id string.** Fire-and-forget with no handle means
   callers cannot await delivery or apply backpressure. Ours returns a promise and
   registers it in `pendingLogPromises`, which is what makes `flushOnExit`,
   `waitUntil` and the SIGTERM drain actually correct.
4. **Circular dependencies as a documented hazard.** `dd-log.ts` opens with a
   circular-dependency warning and depends on import-time ordering; `logger-5`
   reaches for `eval('require')` to dodge webpack static analysis. This package
   has no cycles and no `eval`, which is why the same source runs unmodified on
   five runtimes.

One reference pattern worth adopting that we have not: the **`CursorQueue`**
O(1)-amortized FIFO. `BrowserStreamTransport` now uses that shape; the same
change would help `SupabaseRealtimeTransport`, which still uses `Array.shift()`.

---

## 5. CI: every runtime, every push

`.github/workflows/ci.yml` runs `tests/conformance/runtime-conformance.mjs` — a
framework-free suite using only bare specifiers, so each runtime resolves through
the package's own export conditions, which is itself what is being tested.

| Job | Runtime | Notes |
| --- | --- | --- |
| `build` | Node 22 | typecheck, full suite, uploads `dist/` so every other job tests the same artifact |
| `node` | Node 18, 20, 22, 24 | conformance + full test suite |
| `bun` | Bun latest | asserts the `bun` condition resolves and ALS works |
| `deno` | Deno 2.x | asserts the `deno` condition resolves and ALS works |
| `workerd` | `wrangler dev --local` | real workerd, **no** `nodejs_als` — proves a bare Worker still loads and logs |
| `browser` | Headless Chromium (Playwright) | bundles with the `browser` condition, asserts `node:async_hooks` never reaches the client bundle, streams records over a real WebSocket |
| `package` | Node 22 | installs the packed tarball into a scratch consumer and typechecks the TS fixture |

The workerd job is deliberately unflagged: the hostile configuration is the one
worth gating merges on.
