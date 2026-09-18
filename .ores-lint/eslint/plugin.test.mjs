/**
 * ores-lint :: fixtures for the vendored ESLint plugin
 *
 * selftest.sh runs this file. It must stay dependency-free: the toolkit is
 * vendored into repos that never install anything into node_modules, and
 * ESLint itself is expected to be a GLOBAL tool, so `import 'eslint'` would
 * not resolve here. These are contract tests over the plugin's own exports
 * plus a behavioural test of the `semi` rule driven by a synthetic context.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import plugin, { requireSendRule, semiRule, rules } from './plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitVersion = readFileSync(path.join(here, '..', 'VERSION'), 'utf8').trim();

test('the default export is a flat-config plugin object', () => {
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.meta.name, 'ores-lint');
  assert.equal(
    plugin.meta.version,
    toolkitVersion,
    'plugin.mjs meta.version must track .ores-lint/VERSION',
  );
  assert.equal(plugin.rules, rules);
});

test('both house rules are exported under their documented names', () => {
  assert.deepEqual(Object.keys(rules).sort(), ['require-send', 'semi']);
  assert.equal(rules['require-send'], requireSendRule);
  assert.equal(rules.semi, semiRule);
});

test('every rule declares the metadata ESLint needs to load it', () => {
  for (const [name, rule] of Object.entries(rules)) {
    assert.equal(typeof rule.create, 'function', `${name}.create`);
    assert.ok(rule.meta, `${name}.meta`);
    assert.ok(['problem', 'suggestion', 'layout'].includes(rule.meta.type), `${name}.meta.type`);
    assert.ok(Array.isArray(rule.meta.schema), `${name}.meta.schema must be an array`);
    assert.ok(
      rule.meta.messages && Object.keys(rule.meta.messages).length > 0,
      `${name}.meta.messages`,
    );
    for (const text of Object.values(rule.meta.messages)) {
      assert.equal(typeof text, 'string');
      assert.notEqual(text.trim(), '');
    }
  }
});

test('require-send accepts exactly the documented options', () => {
  const [schema] = requireSendRule.meta.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ['levelMethods', 'loggerNames', 'moduleNames', 'terminalMethods'],
  );
});

test('require-send installs the traversal handlers it relies on', () => {
  const handlers = requireSendRule.create({ options: [], report() {} });
  for (const key of [
    'Program',
    'Program:exit',
    'ImportDeclaration',
    'FunctionDeclaration',
    'FunctionDeclaration:exit',
    'ArrowFunctionExpression',
  ]) {
    assert.equal(typeof handlers[key], 'function', `missing handler ${key}`);
  }
});

test('require-send tolerates a rule configuration without options', () => {
  assert.doesNotThrow(() => requireSendRule.create({ options: [{}], report() {} }));
  assert.doesNotThrow(() => requireSendRule.create({
    options: [{ loggerNames: ['myLogger'], terminalMethods: ['send', 'flush'] }],
    report() {},
  }));
});

test('semi is auto-fixable and takes no options', () => {
  assert.equal(semiRule.meta.fixable, 'code');
  assert.deepEqual(semiRule.meta.schema, []);
});

/** Minimal stand-in for the pieces of ESLint's context that semiRule touches. */
function semiContext(lastToken) {
  const reports = [];
  const context = {
    options: [],
    report: (descriptor) => reports.push(descriptor),
    sourceCode: { getLastToken: () => lastToken },
  };
  return { context, reports };
}

const SEMI_TOKEN = { type: 'Punctuator', value: ';', loc: { end: { line: 1, column: 10 } } };
const NAME_TOKEN = { type: 'Identifier', value: 'x', loc: { end: { line: 1, column: 9 } } };

test('semi reports a statement whose last token is not a semicolon', () => {
  const { context, reports } = semiContext(NAME_TOKEN);
  const handlers = semiRule.create(context);
  handlers.ExpressionStatement({ type: 'ExpressionStatement' });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].messageId, 'missingSemi');
  assert.deepEqual(reports[0].loc, NAME_TOKEN.loc.end);
});

test('semi stays quiet when the semicolon is already there', () => {
  const { context, reports } = semiContext(SEMI_TOKEN);
  const handlers = semiRule.create(context);
  handlers.ExpressionStatement({ type: 'ExpressionStatement' });
  assert.deepEqual(reports, []);
});

test('semi never reports a for-loop head or a for-of binding', () => {
  const { context, reports } = semiContext(NAME_TOKEN);
  const handlers = semiRule.create(context);

  const forInit = { type: 'VariableDeclaration' };
  forInit.parent = { type: 'ForStatement', init: forInit };
  handlers.VariableDeclaration(forInit);

  const forOfLeft = { type: 'VariableDeclaration' };
  forOfLeft.parent = { type: 'ForOfStatement', left: forOfLeft };
  handlers.VariableDeclaration(forOfLeft);

  assert.deepEqual(reports, []);

  const statement = { type: 'VariableDeclaration', parent: { type: 'Program' } };
  handlers.VariableDeclaration(statement);
  assert.equal(reports.length, 1, 'an ordinary declaration still needs a semicolon');
});

test('semi does not ask for a semicolon after exported function or class bodies', () => {
  const { context, reports } = semiContext(NAME_TOKEN);
  const handlers = semiRule.create(context);

  handlers.ExportNamedDeclaration({
    type: 'ExportNamedDeclaration',
    declaration: { type: 'FunctionDeclaration' },
  });
  handlers.ExportDefaultDeclaration({
    type: 'ExportDefaultDeclaration',
    declaration: { type: 'ClassDeclaration' },
  });
  assert.deepEqual(reports, []);

  handlers.ExportNamedDeclaration({ type: 'ExportNamedDeclaration', declaration: null });
  assert.equal(reports.length, 1, 'a re-export is an ordinary statement');
});

test('semi provides a fixer that inserts the missing semicolon', () => {
  const { context, reports } = semiContext(NAME_TOKEN);
  const handlers = semiRule.create(context);
  handlers.ExpressionStatement({ type: 'ExpressionStatement' });

  const inserted = [];
  reports[0].fix({ insertTextAfter: (token, text) => inserted.push([token, text]) });
  assert.deepEqual(inserted, [[NAME_TOKEN, ';']]);
});
