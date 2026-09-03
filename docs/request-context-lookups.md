# Runtime-safe request identity lookups

`ores-otel` consumes request identity established by framework middleware. It must not own HTTP authentication or depend on a particular middleware package. The intended dependency direction is:

```text
application -> ores-middleware -> ores-otel
```

The logging context remains structural, so applications can install their own provider when they do not use `ores-middleware`.

## Canonical fields

For middleware-backed HTTP work, use these keys:

| Meaning | Logging context location |
| --- | --- |
| Request ID | `fields["request.id"]` |
| Trace ID | `traceId`, with `fields["trace.id"]` as a compatibility fallback |
| Logged-in user ID | `loggedInUser.id`, with `fields["user.id"]` as a fallback |
| Tenant ID | `fields["tenant.id"]` |

The context module exposes direct helpers:

```ts
import {
  currentLogLoggedInUserId,
  currentLogRequestId,
  currentLogTenantId,
  currentLogTraceId,
} from '@oresoftware/next-loggers/context';

const requestId = currentLogRequestId();
const userId = currentLogLoggedInUserId();
const tenantId = currentLogTenantId();
const traceId = currentLogTraceId();
```

These helpers perform one native context-store lookup followed by ordinary object-field access. They return `undefined` outside an active scope.

## Runtime behavior

### Node.js, Next.js server, Express, NestJS, Bun, and Deno

The default context entry point uses `AsyncLocalStorage`. The callback's complete promise remains in the request scope, so identifiers remain available through nested promises, timers, filesystem calls, database calls, and other async resources that preserve the native async chain.

Framework middleware must invoke downstream work inside `runWithLogContext` and must keep that promise alive until the real request or response lifecycle completes. Express and NestJS adapters cannot assume that `next()` returns the downstream promise; they need a response `finish`/`close` bridge.

### Workerd / Cloudflare Workers

With the `nodejs_als` or `nodejs_compat` compatibility flag, the workerd build uses the runtime's native `AsyncLocalStorage` and provides concurrent isolation.

Without native ALS, the fallback is intentionally synchronous-only. It restores the frame immediately when the callback returns, even when the callback returns a Promise. Code before the first async boundary can read the ambient context; code after `await` sees `undefined`. This is fail-closed behavior: an absent ID is safer than another request's ID.

Use one of these approaches for unflagged Workers:

1. enable native `nodejs_als`/`nodejs_compat`;
2. keep a request child logger in an explicit closure or request object;
3. install an application-owned provider with genuine async isolation;
4. pass an immutable context snapshot explicitly.

### Browser

Browsers do not provide a request-scoped async-local primitive. The browser context build therefore has the same synchronous-only, fail-closed behavior. A browser application should normally attach user/session identifiers explicitly to a logger child or use framework-owned scoping rather than treating ambient context as authoritative.

## Security rules

Ambient context is for low-cardinality correlation identifiers and small allow-listed metadata. Do not place authorization headers, cookies, raw tokens, credentials, private keys, request bodies, or arbitrary identity claims in it. Prefer stable internal subject and tenant IDs over email addresses or names.

A process-wide `Map<requestId, context>` is not a replacement for runtime-native propagation. It requires cleanup, can leak identity, adds synchronization, and is vulnerable to request-ID collision. Bounded registries are acceptable only for explicit callback/interop boundaries where no native context can be passed.

## Required tests

Every supported server runtime should prove that:

- overlapping requests never observe each other's request, trace, user, or tenant ID;
- nested scopes restore the exact parent;
- context disappears after success, error, cancellation, timeout, and disconnect;
- detached tasks receive an explicit captured snapshot or intentionally start a new operation;
- logger/exporter failure cannot alter the request response;
- degraded runtimes return no ambient identity after an async boundary rather than leaking another operation's identity.
