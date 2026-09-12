# ores-trace and ores-routine identifiers

Every `ores.otel.log` SDK can attach two correlation identifiers to an event. Together they let an
operator jump from one emitted record straight to the source line that produced it, and group all
records produced by one function or method.

| Identifier | Format | Scope |
| --- | --- | --- |
| Trace ID | `ores-trace-` + 21-character nanoid (`[A-Za-z0-9_-]`) | one call site |
| Routine ID | `ores-routine-` + 21-character nanoid (`[A-Za-z0-9_-]`) | one function or method |

The machine-checkable contract lives in [`contracts/ores-ids`](../contracts/ores-ids/README.md) as
independently authored TypeSpec and JSON Schema Draft 2020-12 peers, verified with
`npx tjsv check` (TypeSpec JSON Schema Validator).

## Rules

1. **Trace IDs are inline string literals, unique per call site.** Never store one in a variable,
   compute it, or reuse it at a second call site. Grepping the literal must land on exactly one line.
2. **Routine IDs are declared once, at the very top of the function or method**, and then passed to
   every `addRoutineId` call in that function.
3. **Generate IDs with the fleet generator** so they are unique across repositories. Do not hand-type
   or copy an existing ID.
4. **The legacy `dd-trace-` prefix is retired.** Converting an existing `dd-trace-` literal to a
   freshly generated `ores-trace-` ID is valid; keeping or adding `dd-trace-` is not.
5. Identifiers are correlation metadata only. They never carry secrets, user data, paths, or request
   input.

## Examples

TypeScript / JavaScript:

```ts
export async function refreshSession(log: Logger) {
  const routineId = 'ores-routine-otwvNHO1LPvVOg9JhIG71';
  try {
    // ...
    log.info('session refreshed').addTraceId('ores-trace-J6EeoFC9M5kPPHgbJZRiu').addRoutineId(routineId).send();
  } catch (err) {
    log.error('session refresh failed', err).addTrace('ores-trace-2CPo3-Iv_sWgcFp8dnGGB').addRoutineId(routineId).send();
  }
}
```

Rust (`oresoftware-next-loggers`):

```rust
fn start(logger: &Logger) {
    const ROUTINE_ID: &str = "ores-routine-nIh-YVVWNw_-HJE2LQI5-";
    let _ = logger
        .info(vec!["listener started".into()])
        .add_trace("ores-trace-i8xsNfhecEdM-HoQL75Z6", false)
        .add_routine_id(ROUTINE_ID)
        .send();
}
```

The IDs above are documentation examples reserved by the contract corpus; do not paste them into
source code.

## Native method names

| SDK | Trace | Routine |
| --- | --- | --- |
| TypeScript / JavaScript | `addTraceId`, `addTrace` | `addRoutineId` |
| Rust | `add_trace_id`, `add_trace` | `add_routine_id` |
| Go | `AddTraceID`, `AddTrace` | `AddRoutineID` |
| Python | `add_trace_id`, `add_trace` | `add_routine_id` |
| Java / Dart | `addTrace` | `addRoutineId` |
| Elixir | `add_trace` | `add_routine_id` |
