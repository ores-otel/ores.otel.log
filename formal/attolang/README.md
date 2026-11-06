# AttoLang log-delivery conservation projection

This additive source-level reference maps the existing **authoritative**
[`LogDelivery.tla`](../LogDelivery.tla) accounting obligation to a small,
pure AttoLang `.atto` entry point. The existing TypeScript/Rust/Dart/Go/Gleam
implementations and their contract/refinement tests remain the production owners.

| Abstract action | Property / planned guest refinement |
| --- | --- |
| enqueue/overflow | bound accepted work, account for refused capacity |
| dispatch | move exactly one queued item into flight |
| ack/transportDrop | remove in-flight work exactly once |
| beginShutdown/shutdownDrop/close | no new admission after shutdown, terminal queues drained |
| conserved() | accepted = acknowledged + queued + in-flight + dropped |

Run `node formal/attolang/model-check.mjs` to exhaustively enumerate the
finite model and confirm two deliberate unsafe mutations fail. This is an
**independent bounded model** over accepted<=3, queue<=2, inflight<=1,
not execution of the production queue or `.atto` program.

`delivery_policy.atto` is source for future guest refinement.
`expected.stdout` is the **candidate** exact output for it, not a
verified runtime receipt. Gate promotion on exact-source, exact-head compilation
and guest execution on Java/Graal, LLVM, .NET NativeAOT, Wasm and Forge/Cranelift,
with nonzero executed steps, output comparison, failure/mutation tests,
and reproduction of the existing LogDelivery invariants. Until then,
guest and backend parity = **NOT_EXECUTED**. No secrets or payloads in the model.
