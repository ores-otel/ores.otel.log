#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'contracts', 'logger-api.json');
const contractSchemaPath = path.join(root, 'contracts', 'logger-api.schema.json');
const matrixPath = path.join(root, 'contracts', 'test-org-matrix.json');
const matrixSchemaPath = path.join(root, 'contracts', 'test-org-matrix.schema.json');
const recordSchemaPath = path.join(root, 'contracts', 'log-record.schema.json');

const expectedOperations = {
  logger: ['create', 'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'flush', 'flush_on_exit', 'close'],
  event: ['field', 'fields', 'user', 'users', 'trace', 'traces', 'routine', 'tag', 'tags', 'context', 'meta', 'error', 'send'],
  transport: ['write', 'flush', 'flush_on_exit', 'close'],
  context: ['current', 'run', 'bind', 'set', 'get', 'clear'],
  otel: ['extract', 'inject', 'correlate', 'create_transport', 'preserve_provider_ownership', 'no_global_patching'],
};

const requiredCapabilities = [
  'structured-records',
  'otel-explicit',
  'no-global-patching',
  'transport-lifecycle',
  'deterministic-conformance',
];

const credentialPattern = new RegExp([
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'lin_' + 'api_[A-Za-z0-9]+',
  'cfa' + 't_[A-Za-z0-9]+',
  'BEGIN [A-Z ]*PRIVATE KEY',
  'CHAT_' + 'BRIDGE_TOKEN',
].join('|'), 'u');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolveRef(rootSchema, ref) {
  assert(ref.startsWith('#/'), `only local JSON Schema refs are supported: ${ref}`);
  let current = rootSchema;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(current && Object.hasOwn(current, part), `unresolved JSON Schema ref: ${ref}`);
    current = current[part];
  }
  return current;
}

function schemaErrors(value, schema, rootSchema, location = '$') {
  if (schema.$ref) {
    return schemaErrors(value, resolveRef(rootSchema, schema.$ref), rootSchema, location);
  }

  const errors = [];

  if (schema.oneOf) {
    const matches = schema.oneOf.filter(candidate =>
      schemaErrors(value, candidate, rootSchema, location).length === 0
    ).length;
    if (matches !== 1) errors.push(`${location}: expected exactly one oneOf branch, matched ${matches}`);
    return errors;
  }

  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push(`${location}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.some(candidate => deepEqual(value, candidate))) {
    errors.push(`${location}: expected one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type) {
    const actual = valueType(value);
    const valid = schema.type === 'number'
      ? actual === 'integer' || actual === 'number'
      : actual === schema.type;
    if (!valid) {
      errors.push(`${location}: expected ${schema.type}, received ${actual}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${location}: expected minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${location}: did not match ${schema.pattern}`);
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location}: expected minimum ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location}: expected at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location}: expected at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map(item => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${location}: expected uniqueItems`);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...schemaErrors(item, schema.items, rootSchema, `${location}[${index}]`));
      });
    }
    if (schema.contains) {
      const contains = value.some(item => schemaErrors(item, schema.contains, rootSchema, location).length === 0);
      if (!contains) errors.push(`${location}: no item matched contains`);
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}: missing required property ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        errors.push(...schemaErrors(child, schema.properties[key], rootSchema, `${location}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}: unexpected property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...schemaErrors(child, schema.additionalProperties, rootSchema, `${location}.${key}`));
      }
    }
  }

  return errors;
}

async function loadJson(file) {
  const raw = await readFile(file, 'utf8');
  assert(!credentialPattern.test(raw), `${path.relative(root, file)} contains credential-shaped content`);
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    fail(`${path.relative(root, file)} is not valid JSON: ${error.message}`);
  }
}

function validateWithSchema(name, value, schema) {
  const errors = schemaErrors(value, schema, schema);
  if (errors.length > 0) {
    fail(`${name} failed JSON Schema validation:\n${errors.slice(0, 50).map(error => `- ${error}`).join('\n')}`);
  }
}

function assertExactOperationSet(contract) {
  for (const [category, expected] of Object.entries(expectedOperations)) {
    const actual = contract.operations[category].map(operation => operation.id);
    assert(
      deepEqual(actual, expected),
      `${category} operation drift: expected ${expected.join(', ')}, received ${actual.join(', ')}`
    );
    assert(new Set(actual).size === actual.length, `${category} contains duplicate operation IDs`);
  }
}

async function validateSdkBindings(contract) {
  assert(contract.sdkBindings.length >= 11, 'at least 11 SDK bindings are required');
  const ids = contract.sdkBindings.map(binding => binding.id);
  assert(new Set(ids).size === ids.length, 'SDK binding IDs must be unique');

  for (const binding of contract.sdkBindings) {
    await access(path.join(root, binding.path));
    assert(binding.operationSet === contract.operationSet, `${binding.id} uses the wrong operation set`);
    for (const capability of requiredCapabilities) {
      assert(binding.capabilities.includes(capability), `${binding.id} is missing ${capability}`);
    }
    assert(
      binding.capabilities.includes('context-local-storage') ||
        binding.capabilities.includes('explicit-context-passing'),
      `${binding.id} must declare context-local-storage or explicit-context-passing`
    );
  }
}

function validateTracks(matrix) {
  const tracks = new Map(matrix.tracks.map(track => [track.id, track]));
  assert(tracks.size === 2, 'matrix must define exactly legacy and canonical tracks');
  const legacy = tracks.get('legacy');
  const canonical = tracks.get('canonical');
  assert(legacy?.repository === 'ORESoftware/next-loggers.ts', 'legacy repository drifted');
  assert(/^[0-9a-f]{40}$/u.test(legacy?.ref ?? ''), 'legacy track requires an exact 40-character ref');
  assert(legacy.status === 'ready', 'legacy track must be ready');
  assert(canonical?.repository === 'ores-otel/ores.otel.log', 'canonical repository drifted');
  if (canonical.status === 'ready') {
    assert(/^[0-9a-f]{40}$/u.test(canonical.ref ?? ''), 'ready canonical track requires an exact ref');
  } else {
    assert(canonical.status === 'blocked', 'canonical status must be ready or blocked');
    assert(canonical.ref === null, 'blocked canonical track must not claim a ref');
    assert(Boolean(canonical.blockedBy), 'blocked canonical track requires blockedBy');
  }
}

function validateMatrix(contract, matrix) {
  assert(matrix.targetOrganization === 'ores-otel-test', 'test-org writes are allowlisted to ores-otel-test');
  assert(matrix.policy.productionWritesAllowed === false, 'test matrix must prohibit production writes');
  assert(matrix.repositories.length >= Math.max(10, matrix.policy.minimumRepositories), 'too few test repositories');

  const languages = new Set(matrix.repositories.map(repository => repository.language));
  assert(languages.size >= Math.max(7, matrix.policy.minimumLanguages), 'too few test languages');
  assert(
    languages.size === contract.sdkBindings.length,
    `matrix must cover every SDK binding (${contract.sdkBindings.length}), found ${languages.size}`
  );

  const names = matrix.repositories.map(repository => repository.name);
  assert(new Set(names).size === names.length, 'test repository names must be unique');

  const bindings = new Map(contract.sdkBindings.map(binding => [binding.id, binding]));
  for (const binding of contract.sdkBindings) {
    const entries = matrix.repositories.filter(repository => repository.language === binding.id);
    assert(entries.length === 2, `${binding.id} requires exactly legacy and canonical consumers`);
    assert(
      deepEqual(entries.map(entry => entry.track).sort(), ['canonical', 'legacy']),
      `${binding.id} consumer pair is incomplete`
    );
    for (const entry of entries) {
      assert(entry.visibility === 'private', `${entry.name} must remain private`);
      assert(entry.sourcePath === binding.path, `${entry.name} sourcePath drifted`);
      assert(entry.package === binding.package, `${entry.name} package drifted`);
      assert(entry.testCommand === binding.testCommand, `${entry.name} testCommand drifted`);
      assert(entry.requiredChecks.includes('contract'), `${entry.name} must require contract`);
      assert(entry.requiredChecks.includes('consumer'), `${entry.name} must require consumer`);
    }
  }

  for (const entry of matrix.repositories) {
    assert(bindings.has(entry.language), `${entry.name} refers to unknown SDK ${entry.language}`);
  }

  validateTracks(matrix);
}

async function main() {
  const [
    { value: contract },
    { value: contractSchema },
    { value: matrix },
    { value: matrixSchema },
    { value: recordSchema },
  ] = await Promise.all([
    loadJson(contractPath),
    loadJson(contractSchemaPath),
    loadJson(matrixPath),
    loadJson(matrixSchemaPath),
    loadJson(recordSchemaPath),
  ]);

  assert(contractSchema.$schema === 'https://json-schema.org/draft/2020-12/schema', 'API schema draft drifted');
  assert(matrixSchema.$schema === 'https://json-schema.org/draft/2020-12/schema', 'matrix schema draft drifted');
  validateWithSchema('logger-api.json', contract, contractSchema);
  validateWithSchema('test-org-matrix.json', matrix, matrixSchema);

  assert(recordSchema.properties?.schema?.const === contract.wireSchema, 'wire schema and API contract disagree');
  assertExactOperationSet(contract);
  await validateSdkBindings(contract);
  validateMatrix(contract, matrix);

  process.stdout.write(
    `Validated ${contract.sdkBindings.length} SDK bindings, ` +
      `${Object.values(contract.operations).flat().length} canonical operations, ` +
      `${matrix.repositories.length} test repositories, and ` +
      `${new Set(matrix.repositories.map(repository => repository.language)).size} languages.\n`
  );
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
