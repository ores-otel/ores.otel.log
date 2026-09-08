# Shell-free Rust launcher

`ores-launcher <executable> [arguments...]` is an opt-in binary in the canonical
`oresoftware-next-loggers` Rust package. It uses **ores-otel's existing Logger,
LogRecord, and Transport contract**, not a separate printf/echo logger. Build with:

```sh
cargo build --locked --release -p oresoftware-next-loggers --features launcher --bin ores-launcher
cargo test --locked -p oresoftware-next-loggers --features launcher --all-targets
```

Consumers can install the same source with `cargo install --locked --git
https://github.com/ores-otel/ores.otel.log.git --rev <reviewed-full-commit-sha>
--features launcher --bin ores-launcher oresoftware-next-loggers`. Use a published
immutable revision, not a branch tip. Build for each target architecture against
libraries compatible with the final image; the test image uses a Bookworm builder
and `cc-debian12:nonroot`, not a shell-less image lacking required dynamic libraries.

## Docker interface

```dockerfile
COPY --from=build /usr/local/bin/ores-launcher /ores-launcher
COPY --from=build /usr/local/bin/my-app /my-app
USER 65532:65532
ENTRYPOINT ["/ores-launcher", "/my-app"]
CMD []
```

Now `docker run IMAGE --help` forwards `--help` to the application. To make the
entire command replaceable instead, use `ENTRYPOINT ["/ores-launcher"]` with
`CMD ["/my-app"]`; runtime overrides must then include the executable. A direct
`ENTRYPOINT ["/my-app"]` (or `docker run --entrypoint /my-app IMAGE`) remains valid
when no startup log is needed. Neither form requires `/bin/sh` or Bash.

The launcher has **no flags of its own**. The first argument is the executable;
all subsequent bytes belong to it, including `--`, empty strings and non-UTF8
values. This opaque transport is not a second CLI schema. The application's
`.cli-flags.toml` and flags-2-env integration continue to own option parsing,
validation and environment precedence. Prefer absolute executable paths in images.
A name containing `/` is executed literally. A basename searches inherited PATH;
an unset PATH uses `/bin:/usr/bin`, while explicit empty PATH components mean cwd.
Lookup continues after missing/not-directory/permission-denied candidates; a
permission denial wins over missing candidates if the search is exhausted.

## Logging and process contract

The launcher emits one synchronous `next-loggers/v1` JSON record to **stderr**
with message `command is`, `event.name=process.exec.attempt`, process PID, original
argument count and a display-only `process.command_args` array. `OTEL_SERVICE_NAME`
becomes the bounded appName; the logger name identifies `ores-launcher`. stdout is
reserved for the application. A collector can ingest this canonical record through
the existing ores-otel pipeline. This does not itself configure collection or
promise remote delivery. No OTLP/Supabase client, global provider, worker thread,
network retry, or asynchronous flush is initialized in this short-lived process.

The logger flushes explicitly, then direct `execve` replaces the process. No
launcher parent remains. The application inherits the PID (including PID 1), cwd,
environment, credentials and stdio; its original native argument vector is never
joined, shell-expanded, truncated or redacted. The application owns shutdown,
signals, child reaping and its eventual exit status. There is no fake post-exec
success log: a successful exec does not return.

Unlike `CommandExt::exec`/`execvp`, unrecognized executable text **never gets an
implicit `/bin/sh` fallback**. It fails with 126, on both shell-equipped hosts and
distroless images. An explicit shebang still requires the named interpreter to be
installed; this does not ban an operator from deliberately invoking a shell.

Call the launcher at single-threaded startup before application signal handlers
are installed. As with Rust Command, SIGPIPE is defaulted for the new executable;
a failed exec restores the launcher's original disposition before error logging.
If restoring that disposition itself fails, error logging is skipped rather than
risking a signal replacing the primary execution error's exit code.

Missing/empty executable returns 64; NotFound returns 127 (which can also mean a
missing interpreter/dynamic loader); other exec errors return 126 and normally emit
a second structured error record without raw exception text. Unsupported non-Unix
builds return 69 instead of quietly falling back to spawn/wait. Logging I/O errors
are best-effort and do not prevent application execution. Ordinary synchronous
stderr backpressure can still delay startup; this is not a hard real-time guarantee.

## Secret and size boundaries

Only the **logging copy** is redacted. Under `launcher.log_policy=redacted-bounded-v2`,
named password/token/API-key/credential/DSN options are masked in their entirety:
the apparent key can itself contain a secret. Common short aliases, headers, URLs
(including signed paths/query strings) and bearer/basic/JWT-shaped values are masked.
Attached short values are checked before sensitive-key matching. Non-UTF8 values
are represented as `[NON_UTF8]`; malformed option names and masked option chains
also hide their possible following value. This deliberately favors over-redaction.

At most 32 arguments and 128 Unicode characters per displayed value are emitted,
with explicit omission/truncation markers. JSON escaping keeps embedded quotes and
newlines from creating forged log records. The executed arguments are not bounded
by these display limits; only the operating system's ordinary limits apply.

This is conservative defense in depth, **not a universal secret detector**.
Unknown positional or custom-option secrets cannot be recognized generically.
Credentials must remain in environment/secret-store channels, never argv. No raw
logging opt-out switch is offered, and the environment is never dumped. The `-p`
alias is deliberately hidden even when a particular app uses it for a public port.

## Tests and rollout

`rust-launcher.yml` tests the exact PR head on native Linux amd64 and arm64, using
real executable replacement rather than a mocked process API. Tests cover native
argv, empty values, metacharacters, non-UTF8 executable/environment values,
PID/cwd/environment, secret redaction, actual broken pipes, 64/126/127 failures,
application status 42 and SIGTERM ownership. The adversarial suite also exercises
large argv without pipe-buffer deadlock, binary stdin/stdout, log injection,
missing interpreters, executable text, directories and symlink loops. Its process
waits have explicit deadlines and concurrently drain stdout/stderr.

The dedicated Docker fixture additionally requires PID 1, UID/GID 65532, no shell,
read-only filesystem, no network, and dropped capabilities. Test fixtures are not
copied into consumer production images.

Do not replace SOPS decryption or another existing initialization step with this
logging-only launcher. The Sonus sidecar intentionally has no SOPS step; secrets
remain in its application container. Kubelet probes may continue calling the
application binary directly without a startup log on every probe.

Related work: [GitHub issue #58](https://github.com/ores-otel/ores.otel.log/issues/58),
[adversarial follow-up #61](https://github.com/ores-otel/ores.otel.log/issues/61),
[DEN-3175](https://linear.app/denman/issue/DEN-3175) and
[DEN-3432](https://linear.app/denman/issue/DEN-3432). Dedicated Linear issue creation
was blocked by the workspace issue limit; this is a bounded launcher slice, not
completion of the entire server shutdown rollout.

References: [POSIX exec](https://pubs.opengroup.org/onlinepubs/9799919799/functions/exec.html),
[Rust exec](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#tymethod.exec)
and [distroless entrypoints](https://github.com/GoogleContainerTools/distroless#entrypoints).
