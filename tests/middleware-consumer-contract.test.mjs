import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("git consumers build the canonical Node package from pinned source", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", root), "utf8"),
  );
  assert.equal(
    packageJson.scripts.prepare,
    "tsc -p tsconfig.build.json && npm run postbuild",
  );
  assert.equal(packageJson.name, "@oresoftware/next-loggers");
  assert.equal(packageJson.exports["./context"].default, "./dist/context.js");
});

test("middleware ownership and all six backend coordinates stay explicit", async () => {
  const contract = await readFile(
    new URL("docs/middleware-consumer-contract.md", root),
    "utf8",
  );
  for (const value of [
    "ORESoftware/ores-middleware",
    "sdk/rust",
    "sdk/go",
    "sdk/gleam",
    "sdk/elixir",
    "sdk/erlang",
    'fields["request.id"]',
  ]) {
    assert.match(contract, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
