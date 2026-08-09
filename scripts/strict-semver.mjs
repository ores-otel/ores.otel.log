/** Strict Semantic Versioning 2.0.0 validation for release workflows. */

// Keep this source byte-for-byte equivalent to src/cli/semver.ts. The
// adversarial release-planner tests compare the two RegExp sources so the
// dependency-free CLI and pre-publication tag verifier cannot drift.
export const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isStrictSemVer(value) {
  return STRICT_SEMVER_PATTERN.test(value);
}
