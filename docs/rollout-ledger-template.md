# OTLP sidecar rollout ledger

This is a copyable evidence template for issue #40. A blank or partially
filled row is not a release approval. Do not put credentials, raw telemetry,
recipient data, or provider headers in this file or in linked evidence.

## Gate A — immutable package

| field | value |
| --- | --- |
| package coordinate | `oresoftware/otel-k8s-sidecar@<version>` |
| source commit | `<40+ character immutable revision>` |
| package manifest SHA-256 | `<digest>` |
| archive SHA-256 / size | `<digest> / <bytes>` |
| registry receipt | `<immutable receipt id>` |
| tag / release identity | `<immutable tag and release id>` |
| frozen blank-consumer result | `pass / fail` |
| installed-tree config/schema/catalog verification | `pass / fail` |
| lifecycle/network fallback check | `pass / fail` |
| Gate A decision | `continue / pause` |

Gate A is `continue` only when the package, receipt, and installed-tree checks
all bind to the same immutable source and artifact identity. A source checkout
is not a substitute for the installed tree.

## Gate B — one adopter at a time

Create one ledger row before opening an adopter PR and complete every field
before starting the next rollout wave:

| field | value |
| --- | --- |
| wave / order | `<integer>` |
| adopter repository | `<org/repo>` |
| observed catalog head | `<revision>` |
| refreshed catalog head | `<revision>` |
| package coordinate + digest | `<coordinate> / <digest>` |
| adopter PR | `<URL>` |
| exact-head CI run | `<URL or run id>` |
| test organization/environment | `<non-secret identifier>` |
| deployment image digest | `<sha256>` |
| synthetic canary ID | `<opaque id>` |
| log receipt | `<receipt id / digest>` |
| metric receipt | `<receipt id / digest>` |
| trace receipt | `<receipt id / digest>` |
| redaction and outage-bound checks | `pass / fail` |
| rollback receipt | `<receipt id / digest>` |
| reviewer | `<handle or review id>` |
| terminal status | `accepted / paused / rolled_back` |

The canary identifier must be synthetic and joinable across the three signals;
it must not contain a user ID, document value, secret, or provider credential.
Receipts should bind digests and timestamps, not raw payloads.

## Adopter acceptance

- [ ] Application-owned provider initialization remains unchanged.
- [ ] OTLP is redirected to pod loopback and the collector sidecar image is
      digest-pinned.
- [ ] Collector runs non-root, read-only, without added capabilities, and with
      bounded memory, queue, retry, and shutdown behavior.
- [ ] Receivers remain loopback-only; no host/CRI log scraping is introduced.
- [ ] Sensitive attributes are deleted before export.
- [ ] NetworkPolicy changes authorize only the explicit sidecar-to-gateway path.
- [ ] Clean rendering and exact package provenance are recorded from the
      installed tree.
- [ ] No duplicate collector or lifecycle/network fallback is present.
- [ ] The test environment proves one synthetic log, metric, and trace.
- [ ] Arrival, enrichment, redaction, bounded outage, and application
      availability are verified.
- [ ] Rollback is exercised and its receipt is attached.

Any missing or drifting field pauses the wave. Do not publish the package,
mutate a consumer, deploy a cluster, or use provider credentials solely because
the ledger was created.
