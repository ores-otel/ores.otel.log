# Context ownership and carrier boundaries

Ambient context is request-scoped security state, not a general mutable object cache. The library owns every context after admission. Callers retain ownership of their input values and may mutate them immediately without changing an admitted request, task, Fiber, process, or message context.

## Required ownership boundaries

1. **Admission:** `runWithLogContext`, language-equivalent scope constructors, and explicit carrier installation recursively snapshot caller-owned values before invoking user work.
2. **Merge/update:** a patch is recursively snapshotted before it becomes visible. A later caller mutation cannot change the active context.
3. **Read:** a read cannot expose mutable aliases into the stored context. Languages with enforceable recursive immutability may return an immutable view; languages with mutable maps/slices return an isolated snapshot.
4. **Record emission:** a record receives its own stable context projection. Later request updates do not retroactively mutate a queued or exported record.
5. **Carrier crossing:** process, thread, isolate, worker, network, and message boundaries never rely on accidental ambient inheritance. A bounded, validated carrier is decoded and explicitly installed by the receiver.
6. **Exit:** normal return, exception, panic/unwind, cancellation, client abort, and handler reuse restore the exact parent state.

## Supported value domain

The portable context domain is recursively structured data: null, booleans, finite numbers, strings, arrays/lists, string-keyed objects/maps, and language equivalents. Runtime adapters may additionally preserve native structured values such as dates, byte arrays, sets, maps, and errors when they can detach them safely and deterministically.

Functions, open file/socket handles, mutexes, runtime executors, database connections, framework request objects, and arbitrary mutable class instances are not portable carriers. An adapter must either reject such values at an explicit carrier boundary or treat them as runtime-local opaque values without claiming cross-runtime snapshot isolation. Opaque values must never be serialized implicitly.

Cycles and shared references are runtime-local structured values. A recursive snapshot must terminate and preserve internal graph identity where the runtime supports it. A wire carrier remains acyclic JSON unless a separately versioned graph encoding is selected.

## Runtime strategies

| Runtime family | Native strategy | Child-boundary rule |
| --- | --- | --- |
| Node.js, Bun, Deno | `AsyncLocalStorage` | promises/timers inherit; worker threads and processes require a carrier |
| Browser, workerd | explicit request/frame context | no implicit ALS claim without runtime support |
| Python | `contextvars` plus recursive snapshots | asyncio tasks follow native rules; executors/processes require explicit copied carriers |
| Go | explicit `context.Context` values | every goroutine receives its derived context explicitly |
| Rust/Tokio | task-local scope around future polling | spawned tasks use an explicit capture/spawn helper |
| Java | guarded scoped thread context plus executor wrappers | pooled/platform/virtual thread handoff is explicit and scope close is owner-checked |
| Dart/Flutter | `Zone` | isolates require serialized carriers |
| Erlang, Elixir, Gleam | scoped BEAM process context | spawned processes receive and install an explicit carrier |
| Ruby | Fiber-local scoped context | threads, Ractors, and detached Fibers require explicit capture/install |
| WebAssembly | host-supplied explicit context | no hidden process-global or thread-local state |

## Carrier security profile

A receiver validates before installation:

- schema/version and maximum encoded length;
- trace and span identifier shape;
- bounded baggage, tags, depth, key count, collection lengths, and string lengths;
- tenant, organization, user, and request identities against authenticated transport state;
- forbidden prototype/meta keys and duplicate/conflicting identity fields;
- deadline/cancellation data without accepting authority-expanding claims;
- redaction rules before diagnostics or rejection logging.

Transport headers are correlation hints, not authentication. A tenant header cannot override the tenant established by the authenticated connection, token, RLS policy, or server-side assignment.

## Conformance invariants

Every supported adapter is tested for nested mutation after admission, mutation after update, read isolation, nested restoration, sibling concurrency, failure/cancellation cleanup, pooled-worker reuse, explicit child propagation, and record snapshot stability. Message and HTTP tests reuse long-lived workers/connections because isolated one-shot tests cannot detect the most damaging leakage class.

Performance tests measure admission/update/read/emission separately. Recursive ownership may be optimized with immutable persistent structures or copy-on-write, but an optimization is invalid if it reintroduces a mutable alias or changes the child-boundary contract.
