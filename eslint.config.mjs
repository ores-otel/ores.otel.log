// ores-lint house config, tailored for @oresoftware/next-loggers.
//
// This repo is where `ores/require-send` originates, so it gets the strictest
// treatment of that rule anywhere in the fleet - with one deliberate carve-out.
import oresConfig from './.ores-lint/eslint/base.mjs';
// Flat config resolves plugin namespaces per config object, so any block that
// names an `ores/*` rule must declare the plugin itself.
import oresPlugin from './.ores-lint/eslint/plugin.mjs';

const base = await oresConfig({
  requireSend: {
    // Every logger surface this package exports, so the rule tracks locals
    // assigned from any of them - not just the default `log`/`logger` names.
    loggerNames: ['log', 'logger', 'ddlog', 'memoryLogger', 'testLogger'],
    moduleNames: ['@oresoftware/next-loggers'],
    terminalMethods: ['send', 'flush', 'flushOnExit'],
  },
  ignores: ['sdk/**', 'dist/**', 'scripts/stage-*.mjs'],
});

export default [
  ...base,

  // Shipped source: an unsent log event is a real defect, not a style nit.
  // This is the one place in the fleet where require-send is an error.
  {
    files: ['src/**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { ores: oresPlugin },
    rules: {
      'ores/require-send': ['error', {
        loggerNames: ['log', 'logger', 'ddlog'],
        moduleNames: ['@oresoftware/next-loggers'],
        terminalMethods: ['send', 'flush', 'flushOnExit'],
      }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Tests deliberately build events that are never sent, to prove they are
  // recovered at shutdown (see 'forgotten until shutdown' in logger.test.mjs).
  // Firing require-send here would be flagging the scenario under test.
  {
    files: ['tests/**', 'scripts/**', '**/*.test.mjs'],
    plugins: { ores: oresPlugin },
    rules: {
      'ores/require-send': 'off',
      'no-console': 'off',
      'no-promise-executor-return': 'off',
    },
  },
];
