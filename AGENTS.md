# Agent instructions

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.

# Agent guidelines for ores.otel.log

This repository is polyglot (TypeScript core in `src/`, native SDKs under `sdk/`). Read the
relevant `docs/` page before changing a contract; keep every SDK's public API source-compatible
because downstream repositories (for example ores-middleware) pin this repository by git rev.

Repository rules:

- Build values, don't mutate them: functions return new values instead of filling `&mut`/pointer
  parameters or caller-owned collections; every language. Deliberate exceptions on hot paths carry a
  `HOT-PATH (imperative by design)` comment with the reason. See [`docs/FUNCTIONAL-STYLE.md`](./docs/FUNCTIONAL-STYLE.md).
