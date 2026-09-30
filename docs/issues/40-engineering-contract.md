# Engineering contract for issue #40

Source: https://github.com/ores-otel/ores.otel.log/issues/40

## Intent

Define the smallest independently reviewable slice for **DEN-4253: publish immutable OTLP sidecar and advance one adopter at a time** without changing public telemetry semantics accidentally.

## Invariants

- Preserve source compatibility across the TypeScript and native SDK surfaces.
- Build new values rather than mutating caller-owned state; hot-path exceptions require the repository's explicit rationale.
- Telemetry must remain bounded and must not retain credentials or high-cardinality sensitive values.
- OTLP/provider details stay behind adapters; application semantics remain provider-neutral.
- Durable delivery work must distinguish enqueue/transport acknowledgement from durable acceptance.
- Release/adoption evidence is bound to immutable source and artifact identities.
- Skipped and zero-step workflows are not passing evidence.

## Verification

- Add deterministic positive and negative fixtures for the issue's behavior.
- Exercise bounded failure/recovery paths, including unavailable collectors/transports where relevant.
- Run formatting, lint, unit, and conformance checks on the exact PR head.
- For multi-runtime work, prove equivalent semantics in every runtime claimed by the issue.
- For rollout work, advance only the bounded adopter slice allowed by the source issue.

This contract advances #40; it does not close the issue until executable implementation and exact-head evidence land.
