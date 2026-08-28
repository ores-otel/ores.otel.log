# Repo-local ores-lint overrides for @oresoftware/next-loggers.
# Managed by hand; the rollout script never overwrites this file.

# This repo is the reference implementation of the house logging contract, so
# it lints its own test/bench targets too rather than shipped code alone.
ORES_LINT_RUST_ALL_TARGETS=1

# Show more context than the fleet default when triaging this package.
ORES_LINT_MAX_EXAMPLES=8
