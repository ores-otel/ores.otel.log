# Releasing next-loggers

`next-loggers.ts` is one source repository with independent package identities for Zed and each native ecosystem. A language release is selected only by its immutable tag prefix; pushing one language tag does not publish any other registry package.

## Package and tag matrix

| Target | Registry identity | Release tag | GitHub environment |
| --- | --- | --- | --- |
| Zed package family | `oresoftware/next-loggers` plus the target packages declared in `.zpkg.toml` | `vX.Y.Z` | `zed-pkg` |
| JavaScript / TypeScript | npm `@oresoftware/next-loggers` | `sdk/nodejs/vX.Y.Z` | `npm` |
| Python | PyPI `oresoftware-next-loggers` | `sdk/python/vX.Y.Z` | `pypi` |
| Go | `github.com/ores-otel/ores.otel.log/sdk/go` | `sdk/go/vX.Y.Z` | `go-modules` |
| Rust | crates.io `oresoftware-next-loggers` | `sdk/rust/vX.Y.Z` | `crates-io` |
| Rust / WASM | crates.io `oresoftware-next-loggers-wasm` | `sdk/wasm/vX.Y.Z` | `crates-io` |
| Java | Maven Central `io.github.oresoftware:next-loggers` | `sdk/java/vX.Y.Z` | `maven-central` |
| Dart / Flutter | pub.dev `oresoftware_next_loggers` | `sdk/dart/vX.Y.Z` | `pub.dev` |
| Ruby | RubyGems `oresoftware-next-loggers` | `sdk/ruby/vX.Y.Z` | `rubygems` |
| Gleam | Hex `oresoftware_next_loggers` | `sdk/gleam/vX.Y.Z` | `hex` |
| Erlang | Hex `oresoftware_next_loggers_erlang` | `sdk/erlang/vX.Y.Z` | `hex` |
| Elixir | Hex `oresoftware_next_loggers_elixir` | `sdk/elixir/vX.Y.Z` | `hex` |

The root `vX.Y.Z` Zed release also publishes target-only packages that do not have an independent native-registry route. This includes `oresoftware/otel-k8s-sidecar`; its version remains locked to the root package family.

The Go tag prefix is part of the Go module protocol for a module rooted in `sdk/go`; do not shorten it to `vX.Y.Z`.

## Inspecting the release catalog

The dependency-free CLI embeds the reviewed package matrix and exposes it through the flags-2-env contract:

```sh
# Human-readable current-version matrix.
next-loggers packages

# JSON suitable for release scripts.
next-loggers packages --json

# Select releases without changing any package or creating any tag.
next-loggers packages --target nodejs --target golang --release-version 0.2.0

# In a repository checkout, compare the catalog to package.json and .zpkg.toml.
next-loggers packages --check
```

The equivalent environment variables are `NEXT_LOGGER_CLI_PACKAGE_TARGETS`, `NEXT_LOGGER_CLI_PACKAGE_REGISTRIES`, `NEXT_LOGGER_CLI_RELEASE_VERSION`, and `NEXT_LOGGER_CLI_PACKAGES_CHECK`. Repeatable target and registry values use JSON-array strings when supplied through the environment. See [`docs/CLI.md`](CLI.md) for examples and the full portable contract.

`packages --check` is read-only and fail-closed. It detects changes to the root Zed identity, root tag format, exact target set, target directories, native registry names, native package identities, and native tag formats. Gleam, Erlang, and Elixir are also checked to ensure they remain first-class Zed targets without pretending Zed currently supplies a native Hex mirror adapter.

## Version policy

All package metadata currently advances in lockstep even though publication is independent. Versions must satisfy strict Semantic Versioning 2.0.0 without a leading `v`. Numeric core and numeric prerelease identifiers cannot contain leading zeroes. The planner and release-tag verifier use byte-equivalent regular-expression sources, and CI tests both with the same positive and adversarial corpus.

Before tagging, update the same semantic version in:

- `package.json`, `sdk/nodejs/package.json`, and `.zpkg.toml`
- `sdk/python/pyproject.toml`
- `sdk/rust/Cargo.toml` and `sdk/wasm/Cargo.toml`
- `sdk/java/pom.xml`, including its SCM tag
- `sdk/dart/pubspec.yaml`
- `sdk/ruby/lib/oresoftware/next_loggers/version.rb` and the gemspec
- `sdk/gleam/gleam.toml`
- `sdk/erlang/src/oresoftware_next_loggers_erlang.app.src`
- `sdk/elixir/mix.exs`
- the version exposed by `src/eslint-plugin.ts`

Then run:

```sh
npm ci
npm run release:check
npm run test:polyglot
node dist/cli/main.js flags --check
node dist/cli/main.js packages --check
```

The packaging workflow adds native dry runs for npm, PyPI, Cargo, Maven, pub.dev, RubyGems, and all three Hex packages. It also runs canonical flags-2-env audit plus wide/narrow help, Bash completion, Zsh `compinit`/autoload, and idempotent completion installation; verifies exact and deliberately moved tags for all 12 release routes; runs `zed release preflight`; and completes `zed pack` plus a full `zed r2g` consumer roundtrip.

## First-time registry setup

Repository automation cannot claim registry namespaces or create publisher credentials. Configure these once before pushing the first release tag:

### Trusted publishers (OIDC; no long-lived upload token)

Create matching GitHub trusted-publisher records for:

- npm package `@oresoftware/next-loggers`, workflow `release-native.yml`, environment `npm`
- PyPI project `oresoftware-next-loggers`, workflow `release-native.yml`, environment `pypi`
- pub.dev package `oresoftware_next_loggers`, workflow `release-native.yml`, environment `pub.dev`
- RubyGems package `oresoftware-next-loggers`, workflow `release-native.yml`, environment `rubygems`

The initial publication rules differ by registry. In particular, a new pub.dev package must be created and automated publishing must be configured before its OIDC workflow can publish subsequent versions.

### GitHub environments and secrets

Create the environments referenced by the workflows and add only the listed secrets:

| Environment | Secrets |
| --- | --- |
| `zed-pkg` | `ZED_PKG_TOKEN` |
| `crates-io` | `CARGO_REGISTRY_TOKEN` |
| `maven-central` | `CENTRAL_TOKEN_USERNAME`, `CENTRAL_TOKEN_PASSWORD`, `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE` |
| `hex` | `HEX_PUBLISH_KEY` |
| `npm`, `pypi`, `pub.dev`, `rubygems` | no upload secret when trusted publishing is enabled |
| `go-modules` | no secret; publication is the pushed Git tag |

Use environment protection rules for all publishing environments. Limit the Maven and Hex credentials to release scope, and rotate them independently of repository access.

### Maven Central

Verify ownership of the `io.github.oresoftware` namespace in the Central Portal. The POM uses the Central Portal publishing plugin, source and Javadoc attachments, and GPG signing. The workflow imports the private signing key through `actions/setup-java` and uses a Central user token through Maven settings.

### Hex

Zed currently has no native Hex mirror adapter, so Gleam, Erlang, and Elixir remain first-class Zed targets while their Hex uploads are handled explicitly by the tag workflow. The three packages have different Hex names and can be released independently. `HEX_PUBLISH_KEY` must have write access to all three names.

## Creating a release

1. Merge a version bump whose normal CI and `Polyglot packaging` workflow are green.
2. Run `next-loggers packages --check --release-version X.Y.Z` in the reviewed checkout.
3. Create only the tags for the registries intended for this release.
4. Push tags without moving or reusing an existing published tag.
5. Inspect the corresponding `Release native package` or `Release Zed packages` run.

Examples:

```sh
# npm only
git tag sdk/nodejs/v0.2.0
git push origin sdk/nodejs/v0.2.0

# Go module only
git tag sdk/go/v0.2.0
git push origin sdk/go/v0.2.0

# Zed package family only
git tag v0.2.0
git push origin v0.2.0
```

Every publishing job runs `scripts/verify-release-tag.mjs` before a build or upload. It reads the target's native manifest version, requires strict SemVer 2.0.0, constructs the one permitted tag from the target prefix, and rejects any mismatch. The test suite invokes this path for every release target with both the exact current tag and a deliberately moved `9.9.9` tag.

To release every registry at the same version, create all applicable tags on the exact same reviewed commit. The workflows serialize native uploads so two registry releases do not mutate shared release state concurrently.

## Failure handling

Never force-move a tag that has triggered a registry upload. Correct the problem, bump the version, rerun all preflight checks, and publish a new tag. A failed job before upload can be rerun after fixing environment configuration; a job that may have uploaded must be checked against the registry before rerunning.
