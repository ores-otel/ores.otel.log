// Corpus checks for contracts/ores-ids. The authoritative parity gate is `npx tjsv check`
// (see .github/workflows/tjsv-ores-ids.yml); this test keeps the corpus honest without
// network access: every valid instance matches, every invalid instance is rejected, and the
// two independently authored patterns stay textually identical.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../contracts/ores-ids/', import.meta.url).pathname;
const schema = JSON.parse(readFileSync(join(root, 'authored.schema.json'), 'utf8'));
const typespec = readFileSync(join(root, 'main.tsp'), 'utf8');

const EXPECTED = {
  OresTraceId: '^ores-trace-[A-Za-z0-9_-]{21}$',
  OresRoutineId: '^ores-routine-[A-Za-z0-9_-]{21}$',
};

const accepts = (definition, value) =>
  typeof value === 'string' && new RegExp(definition.pattern, 'u').test(value);

const corpus = (name, verdict) => {
  const dir = join(root, 'instances', name, verdict);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, value: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
};

test('authored schema is Draft 2020-12 and declares exactly the two identifiers', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(Object.keys(schema.$defs).sort(), Object.keys(EXPECTED).sort());
});

for (const [name, pattern] of Object.entries(EXPECTED)) {
  test(`${name}: authored schema and TypeSpec carry the documented pattern`, () => {
    const definition = schema.$defs[name];
    assert.equal(definition.type, 'string');
    assert.equal(definition.pattern, pattern);
    const declaration = new RegExp(`@id\\("${name}"\\)\\s*@pattern\\("([^"]+)"\\)\\s*scalar ${name} extends string;`);
    const match = typespec.match(declaration);
    assert.ok(match, `main.tsp must declare scalar ${name}`);
    assert.equal(match[1], pattern);
  });

  test(`${name}: valid corpus is accepted`, () => {
    const cases = corpus(name, 'valid');
    assert.ok(cases.length > 0);
    for (const { file, value } of cases) assert.ok(accepts(schema.$defs[name], value), file);
  });

  test(`${name}: invalid corpus is rejected`, () => {
    const cases = corpus(name, 'invalid');
    assert.ok(cases.length > 0);
    for (const { file, value } of cases) assert.equal(accepts(schema.$defs[name], value), false, file);
  });
}
