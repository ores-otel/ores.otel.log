# Supabase Realtime batch transport

`SupabaseRealtimeBatchTransport` (TypeScript) and
`SupabaseRealtimeTransport` (Dart/Flutter) send `next-loggers/v1` records to an
**authenticated private** Supabase Realtime Broadcast channel. They are intended
for low-latency session-tail delivery; use `SupabaseIngestTransport` or an
application-owned `SupabaseTransport` sender as the durable fallback.

## Delivery contract

- Records are bounded by record, batch, and queue byte/count limits.
- Broadcast messages request and wait for Realtime acknowledgements.
- Lost acknowledgements may cause a batch to be retried. The persistence gateway
  must de-duplicate on both `batchId` and each record `id`.
- A current user JWT is required by default. Client bundles reject service-role,
  `sb_secret_*`, and obvious service-role credentials.
- Reconnect uses capped exponential backoff with jitter. After a configurable
  number of failures, the transport can drain through a durable HTTP fallback.
- Channel names should be scoped to the authenticated tenant/session. The server
  must authorize `realtime.messages` inserts for the topic; a private channel is
  not a substitute for row-level authorization.

## TypeScript

```ts
import { BaseLogger } from '@oresoftware/next-loggers';
import { SupabaseIngestTransport } from '@oresoftware/next-loggers/supabase-ingest';
import { SupabaseRealtimeBatchTransport } from '@oresoftware/next-loggers/supabase-realtime-batch';

const durable = new SupabaseIngestTransport({
  url: config.supabaseUrl,
  publishableKey: config.supabasePublishableKey,
  accessToken: () => session.accessToken,
});

const realtime = new SupabaseRealtimeBatchTransport({
  url: config.supabaseUrl,
  publishableKey: config.supabasePublishableKey,
  accessToken: () => session.accessToken,
  channel: `session-logs:${session.userId}`,
  fallback: durable,
});

const logger = new BaseLogger({
  appName: 'mobile-portal',
  transports: [realtime],
});
```

## Dart / Flutter

```dart
final durable = SupabaseTransport(
  sendBatch: authenticatedEdgeFunctionSender,
);

final realtime = SupabaseRealtimeTransport(
  url: Uri.parse(config.supabaseUrl),
  publishableKey: config.supabasePublishableKey,
  accessToken: () => auth.currentSession?.accessToken,
  channel: 'session-logs:${auth.currentUser!.id}',
  fallback: durable,
);

final logger = Logger(
  appName: 'mobile-portal',
  transports: <LogTransport>[realtime],
);
```

Do not put a service-role key, secret key, payment credential, or raw consent
artifact in a client log record. Redact sensitive fields before transport.
