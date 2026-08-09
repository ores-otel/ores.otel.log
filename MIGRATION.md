# Canonical repository migration

The canonical upstream is now `https://github.com/ores-otel/ores.otel.log.git`.

The preserved legacy remote is `https://github.com/ORESoftware/next-loggers.ts.git`.

For an existing clone:

```sh
git remote rename origin legacy
git remote add origin https://github.com/ores-otel/ores.otel.log.git
git fetch --all --prune --tags
git branch --set-upstream-to=origin/main main
```

The new repository was initialized from the complete legacy Git history and every branch present at cutover. Direct verification found no tags or releases in either repository, so none were omitted from the migration.
