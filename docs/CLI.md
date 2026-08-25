# next-loggers CLI and flags-2-env contract

The `next-loggers` executable exposes runtime diagnostics, package-resolution checks, log formatting, and a release-package catalog. Every option has an equivalent `NEXT_LOGGER_*` environment variable declared in the repository-root [`.cli-flags.toml`](../.cli-flags.toml).

The TypeScript CLI remains dependency-free at runtime: [`src/cli/spec.ts`](../src/cli/spec.ts) is the executable parser specification, while `.cli-flags.toml` is the portable flags-2-env contract used for generated help, shell completion, documentation, and cross-language tooling. CI checks the two in both directions, including command descriptions and flag descriptions, and also audits the TOML with a pinned canonical `flags-2-env` CLI build.

## Commands

| Command | Purpose |
| --- | --- |
| `smoke` | Verify an installed package, its selected runtime, and its downstream-consumer smoke contract. |
| `doctor` | Diagnose effective logger configuration and runtime capabilities. |
| `resolve` | Resolve the package export map for Node, Bun, Deno, browsers, edge-light, and workerd conditions. |
| `pretty` | Render or filter `next-loggers/v1` NDJSON from standard input. |
| `packages` | List every independently publishable Zed/native package, render its immutable tag, and optionally detect release-metadata drift. |
| `flags` | Print the command/flag/environment contract or compare `.cli-flags.toml` with the compiled specification. |

Run `next-loggers --help` or `next-loggers <command> --help` for the complete generated option table.

## Release-package catalog

`next-loggers packages` is a read-only release planner. It does not create tags and never uploads a package. The package identities below are the reviewed contract shared by the CLI, `.zpkg.toml`, tests, release workflows, and [`RELEASING.md`](RELEASING.md).

| CLI target | Language / package family | Registry identity | Immutable release tag | GitHub environment |
| --- | --- | --- | --- | --- |
| `zed` | Zed package family | `oresoftware/next-loggers` | `vX.Y.Z` | `zed-pkg` |
| `nodejs` | JavaScript / TypeScript | npm `@oresoftware/next-loggers` | `sdk/nodejs/vX.Y.Z` | `npm` |
| `python` | Python | PyPI `oresoftware-next-loggers` | `sdk/python/vX.Y.Z` | `pypi` |
| `golang` | Go | `github.com/ores-otel/ores.otel.log/sdk/go` | `sdk/go/vX.Y.Z` | `go-modules` |
| `rust` | Rust | crates.io `oresoftware-next-loggers` | `sdk/rust/vX.Y.Z` | `crates-io` |
| `wasm` | Rust / WebAssembly | crates.io `oresoftware-next-loggers-wasm` | `sdk/wasm/vX.Y.Z` | `crates-io` |
| `java` | Java | Maven Central `io.github.oresoftware:next-loggers` | `sdk/java/vX.Y.Z` | `maven-central` |
| `dart` | Dart / Flutter | pub.dev `oresoftware_next_loggers` | `sdk/dart/vX.Y.Z` | `pub.dev` |
| `ruby` | Ruby | RubyGems `oresoftware-next-loggers` | `sdk/ruby/vX.Y.Z` | `rubygems` |
| `gleam` | Gleam | Hex `oresoftware_next_loggers` | `sdk/gleam/vX.Y.Z` | `hex` |
| `erlang` | Erlang | Hex `oresoftware_next_loggers_erlang` | `sdk/erlang/vX.Y.Z` | `hex` |
| `elixir` | Elixir | Hex `oresoftware_next_loggers_elixir` | `sdk/elixir/vX.Y.Z` | `hex` |

The root `vX.Y.Z` Zed release publishes every target declared in `.zpkg.toml`, including the target-only `oresoftware/otel-k8s-sidecar` package. It deliberately does not have a second, independently advancing release tag.

The nested `sdk/go/vX.Y.Z` prefix is required for the Go module rooted at `sdk/go`; a root `vX.Y.Z` tag would describe a different module.

### Human-readable plans

```sh
# Show the current-version plan for every package.
next-loggers packages

# Show only two native releases and render their prospective 0.2.0 tags.
next-loggers packages \
  --target ruby \
  --target java \
  --release-version 0.2.0

# Select every crates.io package.
next-loggers packages --registry crates-io
```

`--target` and `--registry` are repeatable. Multiple filters within one category are ORed; target and registry categories are combined with AND.

`--release-version` accepts strict Semantic Versioning 2.0.0 without a leading `v`. Numeric core and numeric prerelease identifiers may not contain leading zeroes; prerelease and build identifiers may contain only ASCII alphanumerics and hyphens. Examples such as `1.2.3`, `1.2.3-rc.1`, and `1.2.3-rc.1+build.5` are valid. Values such as `v1.2.3`, `01.2.3`, `1.2.3-01`, and `1.2.3-alpha..1` fail before a release plan is rendered.

The CLI and `scripts/verify-release-tag.mjs` intentionally carry the same strict expression. Tests compare their regular-expression sources exactly and exercise the accepted/rejected corpus in both paths, so planning and publication cannot silently disagree.

### Machine-readable and drift-checking plans

```sh
# Produce a JSON object suitable for scripts and release tooling.
next-loggers packages --json

# In a source checkout, prove the compiled catalog still matches package.json
# and every relevant target/native table in .zpkg.toml.
next-loggers packages --check --json
```

`--check` intentionally requires a source checkout containing `.zpkg.toml`. An installed npm artifact can always print its embedded reviewed catalog, but it cannot verify repository files that were deliberately excluded from that native package.

A check fails when the requested version differs from `package.json`, a Zed target is added or removed without documentation, a directory changes, a registry identity drifts, or a native tag format changes.

## Environment-variable equivalents

flags-2-env represents repeatable values as JSON arrays. These commands are equivalent to their flag-based forms:

```sh
NEXT_LOGGER_CLI_PACKAGE_TARGETS='["ruby","java"]' \
NEXT_LOGGER_CLI_RELEASE_VERSION=0.2.0 \
next-loggers packages

NEXT_LOGGER_CLI_PACKAGE_REGISTRIES='["npm","go-modules"]' \
NEXT_LOGGER_CLI_JSON=true \
next-loggers packages

NEXT_LOGGER_CLI_PACKAGES_CHECK=true \
NEXT_LOGGER_CLI_JSON=true \
next-loggers packages
```

The complete release-planning variables are:

| Option | Environment variable | Type |
| --- | --- | --- |
| `--target` | `NEXT_LOGGER_CLI_PACKAGE_TARGETS` | repeatable array |
| `--registry` | `NEXT_LOGGER_CLI_PACKAGE_REGISTRIES` | repeatable array |
| `--release-version` | `NEXT_LOGGER_CLI_RELEASE_VERSION` | strict SemVer 2.0.0 string |
| `--check` | `NEXT_LOGGER_CLI_PACKAGES_CHECK` | boolean |
| `--json` | `NEXT_LOGGER_CLI_JSON` | boolean |
| `--quiet` | `NEXT_LOGGER_CLI_QUIET` | boolean |

## Contract verification

Run both repository-owned checks before a release-metadata change is merged:

```sh
npm run build
node dist/cli/main.js flags --check
node dist/cli/main.js packages --check
```

The packaging workflow additionally builds `flags-2-env` from an immutable commit and runs its canonical audit against `.cli-flags.toml`. It renders root and subcommand help in wide and narrow pseudo-terminals, executes generated Bash completion, registers generated Zsh completion through `compinit`, and installs both shell integrations twice to prove idempotency. This catches TOML/schema and shell-generation behavior that the package's strict dependency-free reader does not attempt to implement, while the local bidirectional comparison catches drift between the portable document and the actual executable.

The release-planner hardening suite also invokes `scripts/verify-release-tag.mjs` for all 12 release routes with the exact current tag and a deliberately moved tag. Exact tags must pass; every moved tag must fail before any registry upload step.

Registry credentials, OIDC publishers, version-bump locations, tag creation, and failure handling are documented in [`docs/RELEASING.md`](RELEASING.md).
