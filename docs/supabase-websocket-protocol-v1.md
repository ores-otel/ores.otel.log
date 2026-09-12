# Supabase durable WebSocket log protocol v1

Supabase Realtime Broadcast is appropriate for low-latency fan-out, but a Realtime `phx_reply` or broadcast acknowledgement proves only broker acceptance. It does not prove that a log row was committed to Postgres.

Audit-relevant session telemetry uses an authenticated collector WebSocket and the `next_log_batch_v1` / `next_log_ack_v1` protocol implemented by `sdk/dart/lib/supabase_log_commit_transport.dart`.

## Client batch

```json
{
  "type": "next_log_batch_v1",
  "batchId": "nlb_stable-across-retries",
  "events": [
    {
      "id": "stable-event-id",
      "tenantId": "tenant-id",
      "sessionId": "session-id",
      "occurredAt": "2026-08-23T20:00:00Z",
      "level": "info",
      "message": "assignment-opened",
      "attributes": {}
    }
  ]
}
```

The client obtains a short-lived, tenant-scoped collector ticket from the application backend, connects with `Authorization: Bearer <ticket>`, bounds batches, and replays the same `batchId` and event `id` values after timeouts.

## Collector acknowledgement

The collector validates the ticket, derives the tenant from trusted claims, commits or idempotently upserts all accepted events in a transaction, and only then replies:

```json
{
  "type": "next_log_ack_v1",
  "batchId": "nlb_stable-across-retries",
  "committed": true,
  "eventIds": ["stable-event-id"]
}
```

Clients treat a batch as complete only when `committed` is `true` and every submitted event ID is present. A connection close, Realtime broker reply, partial ID list, or uncommitted acknowledgement triggers bounded replay.

## Collector requirements

- Never trust a client-supplied tenant without matching it to authenticated ticket claims.
- Use the stable event `id` as the deduplication key; replay must be idempotent.
- Enforce message, attribute, batch-size, and rate limits before database work.
- Redact secrets and sensitive user content before insertion.
- Keep a batch receipt keyed by `(tenant_id, batch_id)` for operational evidence.
- Rotate signing keys and keep collector tickets short lived.
- Do not expose Supabase service-role credentials to mobile, browser, or desktop clients.

## Realtime compatibility

Realtime Broadcast can still be used for live dashboards and best-effort signals. Durable ingestion must use the collector acknowledgement above or another protocol whose acknowledgement is emitted only after a database commit.
