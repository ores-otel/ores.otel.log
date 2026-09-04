# ores-otel/ws-ingest/v1 — server half + client bootstraps

`docs/supabase-websocket-ingest-v1.md` specified the protocol and the SDKs shipped the client
transports (Dart, TypeScript, WASM host); this adds the pieces every org needs to actually stream:

| piece | path | goes into |
|---|---|---|
| Edge Function (Deno WebSocket): hello/ticket → one-time consume → `telemetry_batch` → RPC commit → `commit_ack` | `examples/supabase/functions/telemetry-ws-ingest/` | `*-infra/supabase/<ref>/supabase/functions/` |
| Migration: `ws_tickets_consumed`, `ws_batches` (idempotent by content hash), RPCs `consume_telemetry_ws_ticket`, `ingest_telemetry_ws_batch` | `examples/supabase/migrations/0003_ws_ingest.sql` | `*-infra/supabase/<ref>/supabase/migrations/` |
| Rust crate `oresoftware-telemetry-ticket`: HMAC one-time tickets + axum `POST /api/telemetry/ticket` (feature `axum`) | `sdk/rust-ticket/` | `*-api-server.rs` (`Router::merge(route::telemetry_ticket_router(minter))`) |
| Flutter bootstrap `OresTelemetry.start(...)` + `TelemetryScope` | `examples/clients/flutter/lib/telemetry/ores_otel.dart` | `*-flutter/lib/telemetry/` |
| TypeScript/browser bootstrap `startOresTelemetry(...)` | `examples/clients/typescript/ores-otel.ts` | web clients, `*-clients/clients/typescript` |

Secrets: `TELEMETRY_TICKET_SECRET` (≥32 bytes) is shared by the Edge Function and the API server —
env/secret store only (ores-sops). Tickets bind user + app + project ref + nonce + 120 s expiry;
the nonce is consumed once in Postgres, so a captured ticket cannot be replayed.
