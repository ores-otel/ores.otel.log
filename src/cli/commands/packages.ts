import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PACKAGE_RELEASES,
  RELEASE_TARGET_NAMES,
  ZED_TARGET_NAMES,
  releaseTag,
  type PackageRelease,
  type ReleaseTargetName,
} from '../package-catalog.js';
import { isStrictSemVer } from '../semver.js';
import { asTable, parseToml, type TomlValue } from '../toml.js';
import type { CommandContext, CommandResult } from '../context.js';

interface CatalogCheck {
  ok: boolean;
  errors: string[];
}

function expectString(
  errors: string[],
  actual: TomlValue | undefined,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    errors.push(`${label}: expected "${expected}", found ${JSON.stringify(actual)}`);
  }
}

function staticCatalogErrors(): string[] {
  const errors: string[] = [];
  const targets = new Set<string>();
  const tags = new Set<string>();

  for (const release of PACKAGE_RELEASES) {
    if (targets.has(release.target)) {
      errors.push(`duplicate release target: ${release.target}`);
    }
    targets.add(release.target);

    if (tags.has(release.tagFormat)) {
      errors.push(`duplicate tag format: ${release.tagFormat}`);
    }
    tags.add(release.tagFormat);

    const placeholders = release.tagFormat.match(/\{version\}/g)?.length ?? 0;
    if (placeholders !== 1) {
      errors.push(
        `${release.target} tag format must contain exactly one {version} placeholder`,
      );
    }
    if (release.target !== 'zed' && release.zedTarget === undefined) {
      errors.push(`${release.target} has no matching Zed target`);
    }
  }

  for (const target of RELEASE_TARGET_NAMES) {
    if (!targets.has(target)) {
      errors.push(`release catalog is missing ${target}`);
    }
  }
  return errors;
}

async function checkCatalog(
  packageRoot: string,
  releaseVersion: string,
  packageVersion: string,
): Promise<CatalogCheck> {
  const errors = staticCatalogErrors();
  if (releaseVersion !== packageVersion) {
    errors.push(
      `requested release version ${releaseVersion} does not match package.json ${packageVersion}`,
    );
  }

  let source: string;
  try {
    source = await readFile(join(packageRoot, '.zpkg.toml'), 'utf8');
  } catch (error) {
    errors.push(`cannot read .zpkg.toml from ${packageRoot}: ${String(error)}`);
    return { ok: false, errors };
  }

  try {
    const manifest = parseToml(source);
    const packageTable = asTable(manifest.package, 'package');
    const publishTable = asTable(manifest.publish, 'publish');
    const targetsTable = asTable(manifest.targets, 'targets');
    const zed = PACKAGE_RELEASES.find((release) => release.target === 'zed');
    if (!zed) {
      errors.push('release catalog has no zed entry');
      return { ok: false, errors };
    }

    const [expectedOrg, expectedName] = zed.packageName.split('/');
    expectString(errors, packageTable.org, expectedOrg ?? '', 'package.org');
    expectString(errors, packageTable.name, expectedName ?? '', 'package.name');
    expectString(errors, packageTable.version, releaseVersion, 'package.version');
    expectString(errors, publishTable.tag_format, zed.tagFormat, 'publish.tag_format');

    const expectedZedTargets = new Set<string>(ZED_TARGET_NAMES);
    const actualZedTargets = new Set(Object.keys(targetsTable));
    for (const target of expectedZedTargets) {
      if (!actualZedTargets.has(target)) {
        errors.push(`.zpkg.toml is missing [targets.${target}]`);
      }
    }
    for (const target of actualZedTargets) {
      if (!expectedZedTargets.has(target)) {
        errors.push(`.zpkg.toml declares undocumented target ${target}`);
      }
    }

    for (const release of PACKAGE_RELEASES) {
      if (release.target === 'zed' || release.zedTarget === undefined) {
        continue;
      }
      const targetLabel = `targets.${release.zedTarget}`;
      const target = asTable(targetsTable[release.zedTarget], targetLabel);
      expectString(errors, target.dir, release.directory, `${targetLabel}.dir`);

      if (release.manifestNative) {
        const native = asTable(target.native, `${targetLabel}.native`);
        expectString(errors, native.registry, release.registry, `${targetLabel}.native.registry`);
        expectString(errors, native.package, release.packageName, `${targetLabel}.native.package`);
        expectString(errors, native.tag_format, release.tagFormat, `${targetLabel}.native.tag_format`);
      } else if (target.native !== undefined) {
        errors.push(
          `${targetLabel}.native should remain absent; ${release.language} is published to ${release.registry} by the tag workflow`,
        );
      }
    }
  } catch (error) {
    errors.push(`invalid .zpkg.toml: ${String(error)}`);
  }

  return { ok: errors.length === 0, errors };
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  const source = await readFile(join(packageRoot, 'package.json'), 'utf8');
  const manifest = JSON.parse(source) as { version?: unknown };
  if (typeof manifest.version !== 'string') {
    throw new TypeError('package.json has no string version');
  }
  return manifest.version;
}

function normalizeFilters(values: readonly string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter((value) => value !== '');
}

function filterReleases(
  targetFilters: readonly string[],
  registryFilters: readonly string[],
): { releases: PackageRelease[]; errors: string[] } {
  const errors: string[] = [];
  const knownTargets = new Set<string>(RELEASE_TARGET_NAMES);
  const knownRegistries = new Set(PACKAGE_RELEASES.map((release) => release.registry));

  for (const target of targetFilters) {
    if (!knownTargets.has(target)) {
      errors.push(
        `unknown package target "${target}"; expected one of ${RELEASE_TARGET_NAMES.join(', ')}`,
      );
    }
  }
  for (const registry of registryFilters) {
    if (!knownRegistries.has(registry)) {
      errors.push(
        `unknown registry "${registry}"; expected one of ${[...knownRegistries].sort().join(', ')}`,
      );
    }
  }

  const targetSet = new Set(targetFilters as readonly ReleaseTargetName[]);
  const registrySet = new Set(registryFilters);
  const releases = PACKAGE_RELEASES.filter(
    (release) =>
      (targetSet.size === 0 || targetSet.has(release.target)) &&
      (registrySet.size === 0 || registrySet.has(release.registry)),
  );
  if (errors.length === 0 && releases.length === 0) {
    errors.push('no packages matched the requested target and registry filters');
  }
  return { releases: [...releases], errors };
}

function renderRows(releases: readonly PackageRelease[], version: string): string[] {
  const rows = releases.map((release) => ({
    target: release.target,
    registry: release.registry,
    packageName: release.packageName,
    tag: releaseTag(release, version),
    environment: release.environment,
  }));
  const widths = {
    target: Math.max('TARGET'.length, ...rows.map((row) => row.target.length)),
    registry: Math.max('REGISTRY'.length, ...rows.map((row) => row.registry.length)),
    packageName: Math.max('PACKAGE'.length, ...rows.map((row) => row.packageName.length)),
    tag: Math.max('TAG'.length, ...rows.map((row) => row.tag.length)),
  };
  return [
    `${'TARGET'.padEnd(widths.target)}  ${'REGISTRY'.padEnd(widths.registry)}  ` +
      `${'PACKAGE'.padEnd(widths.packageName)}  ${'TAG'.padEnd(widths.tag)}  ENVIRONMENT`,
    ...rows.map(
      (row) =>
        `${row.target.padEnd(widths.target)}  ${row.registry.padEnd(widths.registry)}  ` +
        `${row.packageName.padEnd(widths.packageName)}  ${row.tag.padEnd(widths.tag)}  ${row.environment}`,
    ),
  ];
}

export async function runPackages(ctx: CommandContext): Promise<CommandResult> {
  let packageVersion: string;
  try {
    packageVersion = await readPackageVersion(ctx.packageRoot);
  } catch (error) {
    ctx.printErr(`next-loggers packages: cannot read package version — ${String(error)}`);
    return { exitCode: 1 };
  }

  const releaseVersion = ctx.flag('release_version') ?? packageVersion;
  if (!isStrictSemVer(releaseVersion)) {
    ctx.printErr(
      `next-loggers packages: --release-version must be full semantic versioning, got "${releaseVersion}"`,
    );
    return { exitCode: 2 };
  }

  const selection = filterReleases(
    normalizeFilters(ctx.list('target')),
    normalizeFilters(ctx.list('registry')),
  );
  if (selection.errors.length > 0) {
    for (const error of selection.errors) {
      ctx.printErr(`next-loggers packages: ${error}`);
    }
    return { exitCode: 2 };
  }

  const check = ctx.bool('check')
    ? await checkCatalog(ctx.packageRoot, releaseVersion, packageVersion)
    : undefined;

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        command: 'packages',
        version: releaseVersion,
        checked: check !== undefined,
        ok: check?.ok ?? true,
        errors: check?.errors ?? [],
        packages: selection.releases.map((release) => ({
          target: release.target,
          language: release.language,
          registry: release.registry,
          package: release.packageName,
          directory: release.directory,
          environment: release.environment,
          tagFormat: release.tagFormat,
          tag: releaseTag(release, releaseVersion),
          zedTarget: release.zedTarget ?? null,
          zedNativeMirror: release.manifestNative,
        })),
        docs: 'docs/RELEASING.md',
      }),
    );
    return { exitCode: check?.ok === false ? 1 : 0 };
  }

  if (check?.ok === false) {
    ctx.printErr('next-loggers packages: release catalog has drifted');
    for (const error of check.errors) {
      ctx.printErr(`  ${error}`);
    }
    return { exitCode: 1 };
  }
  if (check?.ok === true && !ctx.bool('quiet')) {
    ctx.print('next-loggers packages: .zpkg.toml matches the compiled release catalog');
  }
  if (!ctx.bool('quiet')) {
    for (const line of renderRows(selection.releases, releaseVersion)) {
      ctx.print(line);
    }
  }
  return { exitCode: 0 };
}
