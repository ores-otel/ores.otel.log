# Workflow provenance ratchet

This private Rust validation tool implements DEN-1321's incremental action-pin
gate. It parses YAML structurally, including quoted keys, flow mappings,
aliases, and merge keys, then inspects job-level reusable workflows and step
actions. Remote references require a full commit SHA, container references
require a SHA-256 digest, and repository-local actions remain supported.

The workflow provides a NUL-delimited list from a successful `git diff` on
stdin. Input sizes and path counts are bounded; workflow symlinks, duplicate
YAML keys, malformed YAML, and non-string action references fail closed.
Diagnostics avoid printing arbitrary workflow values. Deleted workflows are
excluded by Git before validation, so a deletion-only change is permitted.

Run the regression suite with `cargo test --locked --manifest-path
tools/workflow-provenance/Cargo.toml`. The crate has an independent workspace
and is not a published SDK or a new application contract authority. Existing
TJSV gates remain responsible for language/runtime contracts. This validator
checks immutable reference syntax; it does not claim that an action has been
security-reviewed, that a digest exists upstream, or that the entire legacy
workflow inventory has already been pinned.
