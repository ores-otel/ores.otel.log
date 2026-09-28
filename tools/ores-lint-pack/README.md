# ores-lint-pack

Certifies a `.ores-lint/` payload before it is copied anywhere.

## Why this exists

`.ores-lint/` is a vendored, dependency-free toolkit distributed by copying the
directory into a consumer repository. That is its virtue - nothing to install,
nothing to keep in registry sync - and also its failure mode: the copy is never
checked against itself at the destination, and no consumer's CI runs
`selftest.sh`, so a payload that calls a file it does not carry installs
silently and stays silent.

That is not hypothetical. 808 repositories ship a `selftest.sh` that runs
`require-send.test.mjs`, `eslint/plugin.test.mjs` and `tests/integration.mjs`,
and carry none of the three. Nothing went red, because nothing ran it. The
guard was disarmed, not broken.

The generator the toolkit's own README documents - `.ores-lint-toolkit/rollout.mjs`,
`audit.mjs`, `verify.mjs` - does not exist. It is not in this repository, not in
any of the 955 repositories that carry a payload, not in any of their histories,
and `ORESoftware/ores-lint` is a 404. The payloads were written into working
trees out of band and committed by a reconciliation pass. So there is nothing
that could have caught this, and nothing that would stop the next version
diverging the same way.

`ores-lint-pack` is the missing half: the part that says what a payload IS and
whether it holds together, independently of who copies it where.

## Use

```sh
cargo run --manifest-path tools/ores-lint-pack/Cargo.toml -- \
  validate .ores-lint --known-gaps tools/ores-lint-pack/known-gaps.tsv

cargo run --manifest-path tools/ores-lint-pack/Cargo.toml -- \
  manifest .ores-lint --out ores-lint-manifest.json

cargo run --manifest-path tools/ores-lint-pack/Cargo.toml -- \
  verify .ores-lint --manifest ores-lint-manifest.json
```

### validate

Every path the payload names at runtime must be a path the payload carries:

* shell scripts addressing a sibling as `"$DIR/<path>"`, where `DIR` is any
  variable the script assigns from `dirname "$0"` (so `$ORES_LINT_CFG_DIR`
  counts, and `ROOT=$(dirname "$DIR")` - the repository root - correctly does
  not);
* ES modules importing a sibling with a relative specifier.

A target the referring file existence-tests anywhere - `[ -f "$DIR/x" ]`,
`[ -d … ]`, or through a variable it later tests, as `NESTED_FILE` is - is
**optional**: the guard is the author saying the payload degrades when that file
is absent. Uses inside the guarded branch are covered by it. `local.sh` and
`test-tools/` are optional by that rule, which is why they are not managed
files. Everything else is required, and a required target that is missing fails.

`--known-gaps` takes a two-column file of references that are known-missing and
already being fixed; those are reported but do not fail. An entry that starts
resolving is reported as `stale`, so the file shrinks instead of rotting.

### manifest

Emits the exact managed file set - payload-relative path, byte length,
executable bit and SHA-256 per file - plus the payload `VERSION` and one
`payload_digest` over the whole set. A consumer, or an auditor walking the
fleet, can then say which payload a repository received rather than guessing
from a `VERSION` string that several different file sets share.

`manifest` refuses to describe a payload that does not validate. A broken
payload should not become a thing with a name and a digest.

### verify

Compares a received payload against a manifest: missing files, changed content,
unexpected managed files, wrong version. This is what makes a distribution
auditable after the fact, which is the part that was missing.

## Distribution

Deliberately not implemented here. What this tool does is make a payload
*describable* and *checkable*; who pushes it to which repositories, on what
branch, with what review, is an operator decision and this tool takes no
position on it. Whatever performs the rollout should:

1. run `validate` on the source payload and refuse to proceed if it fails;
2. run `manifest` and carry the manifest with the copy;
3. have each consumer able to run `verify` against that manifest.

## No dependencies

The payload it certifies is dependency-free; so is this. SHA-256 is implemented
in `src/sha256.rs` and checked against the FIPS 180-4 vector for `"abc"` in the
test suite, so the digests are ordinary SHA-256 that `shasum -a 256` reproduces.

## Tests

```sh
cargo test --manifest-path tools/ores-lint-pack/Cargo.toml
```

Every test builds a payload in a temporary directory and runs the real binary
over it. Nothing reads `../../.ores-lint`, so the suite keeps its meaning while
the live payload is mid-repair.
