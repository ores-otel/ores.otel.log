/** Strict Semantic Versioning 2.0.0 validation for immutable release tags. */

// Numeric core and numeric prerelease identifiers may not contain leading
// zeroes. Build identifiers may contain leading zeroes because SemVer permits
// them and does not use build metadata for precedence.
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isStrictSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}
