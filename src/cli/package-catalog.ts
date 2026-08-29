/**
 * The reviewed package/release catalog shared by the CLI, tests, and docs.
 *
 * `.zpkg.toml` remains the Zed manifest source of truth. This catalog gives
 * the dependency-free Node CLI a stable, installed-package-safe description
 * of every independently publishable registry package and its immutable tag.
 * `next-loggers packages --check` compares the two in a source checkout.
 */

export const RELEASE_TARGET_NAMES = [
  'zed',
  'nodejs',
  'python',
  'golang',
  'rust',
  'wasm',
  'java',
  'dart',
  'ruby',
  'gleam',
  'erlang',
  'elixir',
] as const;

export type ReleaseTargetName = (typeof RELEASE_TARGET_NAMES)[number];

export const ZED_TARGET_NAMES = [
  'repository',
  'contracts',
  'k8s-sidecar',
  'nodejs',
  'python',
  'golang',
  'rust',
  'rust-wasm',
  'java',
  'dart',
  'ruby',
  'gleam',
  'erlang',
  'elixir',
] as const;

export type ZedTargetName = (typeof ZED_TARGET_NAMES)[number];

export interface PackageRelease {
  /** Stable CLI/workflow identifier. */
  readonly target: ReleaseTargetName;
  readonly language: string;
  readonly registry: string;
  readonly packageName: string;
  readonly directory: string;
  readonly tagFormat: string;
  readonly environment: string;
  /** Matching `[targets.<name>]` table in `.zpkg.toml`, when applicable. */
  readonly zedTarget?: ZedTargetName;
  /** Whether `.zpkg.toml` has a `[targets.<name>.native]` mirror declaration. */
  readonly manifestNative: boolean;
}

export const PACKAGE_RELEASES: readonly PackageRelease[] = [
  {
    target: 'zed',
    language: 'Zed package family',
    registry: 'zed-pkg',
    packageName: 'oresoftware/next-loggers',
    directory: '.',
    tagFormat: 'v{version}',
    environment: 'zed-pkg',
    manifestNative: false,
  },
  {
    target: 'nodejs',
    language: 'JavaScript / TypeScript',
    registry: 'npm',
    packageName: '@oresoftware/next-loggers',
    directory: 'sdk/nodejs',
    tagFormat: 'sdk/nodejs/v{version}',
    environment: 'npm',
    zedTarget: 'nodejs',
    manifestNative: true,
  },
  {
    target: 'python',
    language: 'Python',
    registry: 'pypi',
    packageName: 'oresoftware-next-loggers',
    directory: 'sdk/python',
    tagFormat: 'sdk/python/v{version}',
    environment: 'pypi',
    zedTarget: 'python',
    manifestNative: true,
  },
  {
    target: 'golang',
    language: 'Go',
    registry: 'go-modules',
    packageName: 'github.com/ores-otel/ores.otel.log/sdk/go',
    directory: 'sdk/go',
    tagFormat: 'sdk/go/v{version}',
    environment: 'go-modules',
    zedTarget: 'golang',
    manifestNative: true,
  },
  {
    target: 'rust',
    language: 'Rust',
    registry: 'crates-io',
    packageName: 'oresoftware-next-loggers',
    directory: 'sdk/rust',
    tagFormat: 'sdk/rust/v{version}',
    environment: 'crates-io',
    zedTarget: 'rust',
    manifestNative: true,
  },
  {
    target: 'wasm',
    language: 'Rust / WebAssembly',
    registry: 'crates-io',
    packageName: 'oresoftware-next-loggers-wasm',
    directory: 'sdk/wasm',
    tagFormat: 'sdk/wasm/v{version}',
    environment: 'crates-io',
    zedTarget: 'rust-wasm',
    manifestNative: true,
  },
  {
    target: 'java',
    language: 'Java',
    registry: 'maven-central',
    packageName: 'io.github.oresoftware:next-loggers',
    directory: 'sdk/java',
    tagFormat: 'sdk/java/v{version}',
    environment: 'maven-central',
    zedTarget: 'java',
    manifestNative: true,
  },
  {
    target: 'dart',
    language: 'Dart / Flutter',
    registry: 'pub.dev',
    packageName: 'oresoftware_next_loggers',
    directory: 'sdk/dart',
    tagFormat: 'sdk/dart/v{version}',
    environment: 'pub.dev',
    zedTarget: 'dart',
    manifestNative: true,
  },
  {
    target: 'ruby',
    language: 'Ruby',
    registry: 'rubygems',
    packageName: 'oresoftware-next-loggers',
    directory: 'sdk/ruby',
    tagFormat: 'sdk/ruby/v{version}',
    environment: 'rubygems',
    zedTarget: 'ruby',
    manifestNative: true,
  },
  {
    target: 'gleam',
    language: 'Gleam',
    registry: 'hex',
    packageName: 'oresoftware_next_loggers',
    directory: 'sdk/gleam',
    tagFormat: 'sdk/gleam/v{version}',
    environment: 'hex',
    zedTarget: 'gleam',
    manifestNative: false,
  },
  {
    target: 'erlang',
    language: 'Erlang',
    registry: 'hex',
    packageName: 'oresoftware_next_loggers_erlang',
    directory: 'sdk/erlang',
    tagFormat: 'sdk/erlang/v{version}',
    environment: 'hex',
    zedTarget: 'erlang',
    manifestNative: false,
  },
  {
    target: 'elixir',
    language: 'Elixir',
    registry: 'hex',
    packageName: 'oresoftware_next_loggers_elixir',
    directory: 'sdk/elixir',
    tagFormat: 'sdk/elixir/v{version}',
    environment: 'hex',
    zedTarget: 'elixir',
    manifestNative: false,
  },
];

export function releaseTag(release: PackageRelease, version: string): string {
  return release.tagFormat.replace('{version}', version);
}
