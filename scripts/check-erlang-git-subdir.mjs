import { readFile } from "node:fs/promises";
import process from "node:process";

const canonicalPath = new URL("../sdk/erlang/src/next_loggers.erl", import.meta.url);
const exportedPath = new URL(
  "../sdk/erlang/oresoftware_next_loggers_erlang/src/next_loggers.erl",
  import.meta.url
);

const [canonical, exported] = await Promise.all([
  readFile(canonicalPath),
  readFile(exportedPath)
]);

if (!canonical.equals(exported)) {
  console.error(
    "Erlang git_subdir package drifted from sdk/erlang/src/next_loggers.erl. " +
      "Update both paths from the same Git blob."
  );
  process.exitCode = 1;
} else {
  console.log("Erlang git_subdir package matches the canonical source byte-for-byte.");
}
