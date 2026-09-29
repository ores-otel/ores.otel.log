# Local six-hour process journal

ORES desktop/server supervisors keep a short-lived, local diagnostic journal for process output that
must remain available after a child crashes. The canonical default root is:

```text
$HOME/tmp/logs/<app-name>/<supervisor-pid>-<start-unix-ms>/
  events-<segment-start>.ndjson
  stdio-<segment-start>.ndjson
```

The Rust SDK exposes `LocalJournal` and `LocalJournalOptions`. Application-owned log records are
written unchanged as the canonical `next-loggers/v1` JSON record. Arbitrary child stdout/stderr is
wrapped as `ores-process-stdio/v1`; it is intentionally a separate local-only envelope because
third-party stdout can contain credentials, request bodies, signed URLs, or other data that must not
silently enter OTLP, Supabase, or another remote transport.

## Defaults

- retention: **6 hours**
- segment size: **15 minutes**
- maximum captured child stdio line: **64 KiB**
- Unix directory permissions: **0700**
- Unix segment permissions: **0600**
- process directories include PID plus start time so PID reuse never aliases an older run

Rotation is time-window based rather than size-only. A segment is deleted only after the entire
segment falls outside the retention window. Opening or rotating a journal also prunes stale segment
files from older process directories for the same application.

## Supervisor pattern

Availability and repair are separate loops:

1. A lightweight supervisor owns the child, health/readiness checks, restart policy, backoff and
   crash-loop circuit breaker. It restarts a failed process immediately; it does not wait for an AI
   agent.
2. The supervisor pipes child stdout and stderr, tees them to the terminal/UI when appropriate, and
   also calls `LocalJournal::write_stdio_line`.
3. ORES-native processes emit structured `next-loggers/v1` records through `ores.otel.log`; the
   same `LocalJournal` can be attached as a normal local transport.
4. A deterministic incident scanner runs on a slower cadence (for example every 20 minutes) and
   advances a cursor. It selects only newly observed:
   - `WARN`, `ERROR`, and `FATAL` structured records;
   - stderr records;
   - supervisor crash, non-zero-exit, restart-loop, readiness-failure and resource-pressure events.
5. The scanner deduplicates/fingerprints incidents and emits a bounded incident bundle. An AI agent
   is invoked only when that bundle is non-empty. Healthy logs are never sent to the model.

A remediation agent should receive the incident bundle plus a small amount of source context, not
the full six-hour journal. Bound the prompt by both event count and bytes. Keep a per-incident
attempt budget and circuit breaker so a persistent crash cannot wake the agent forever.

## macOS

The ORES local journal is the application-level source of truth because it is portable and has an
explicit six-hour retention contract. macOS Unified Logging is useful as a secondary system
diagnostic source. Operators can inspect it with Console or the `log` CLI, and a failure bundle may
optionally attach a bounded `log show --last ... --style json` extract or a `log collect`
archive. Do not replace the ORES journal with Unified Logging: third-party child stdio is not
guaranteed to enter OSLog, and OS retention is not the ORES six-hour contract.

## Remediation guardrails

Automated source repair should happen on a dedicated git branch/worktree and should never push
directly to the protected default branch. Require deterministic build/test/health gates before
restarting onto a repaired binary. Store the incident fingerprint and attempted commit so the same
failure is not repeatedly "fixed" with the same revision. After a small bounded retry budget,
disable automatic edits for that incident and escalate it instead.
