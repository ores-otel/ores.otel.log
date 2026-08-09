/**
 * Runtime conformance suite — one file, every runtime.
 *
 * Runs unmodified under Node, Bun, Deno, a browser (via bundling into a page)
 * and workerd. It uses no test framework and no Node built-ins so the same
 * assertions can execute anywhere; the CI matrix in .github/workflows/ci.yml
 * points each runtime at this file.
 *
 * Import specifiers are bare (`@oresoftware/next-loggers/...`) so each runtime
 * resolves through the package's own export conditions — which is precisely
 * what we want to verify.
 */
import { createLogger, serializeLogValue, waitForPendingLogs } from '@oresoftware/next-loggers/base';
import rootLogger from '@oresoftware/next-loggers';
import {
  getLogContext,
  installLogContextProvider,
  isAsyncContextTracked,
  runWithLogContext,
} from '@oresoftware/next-loggers/context';

const failures = [];
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (!condition) {
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

export async function runConformance({ runtime, expectAsyncContext }) {
  // ── Records reach a transport, fully formed ────────────────────────────
  const records = [];
  const logger = createLogger({
    appName: 'conformance',
    console: false,
    transports: { name: 'memory', write: (record) => void records.push(record) },
  });

  await logger.error('conformance probe', { attempt: 1 }).addTrace('trace-1').addTags('ci').send();

  eq('one record delivered', records.length, 1);
  const [record] = records;
  eq('schema', record?.schema, 'next-loggers/v1');
  eq('level', record?.level, 'ERROR');
  eq('traceId', record?.traceId, 'trace-1');
  check('timestamp is ISO', typeof record?.timestamp === 'string' && record.timestamp.includes('T'));
  check('record is JSON-serializable', typeof JSON.stringify(record) === 'string');

  // ── Redaction ──────────────────────────────────────────────────────────
  const secrets = [];
  const secretLogger = createLogger({
    console: false,
    transports: { write: (r) => void secrets.push(r) },
  });
  await secretLogger.warn('login', { password: 'hunter2', attempt: 3 }).send();
  eq('password redacted', secrets[0]?.values[1]?.password, '[REDACTED]');
  eq('non-secret preserved', secrets[0]?.values[1]?.attempt, 3);

  // ── Serializer edge cases (engine-specific behaviour lives here) ───────
  eq('NaN', serializeLogValue(Number.NaN), 'NaN');
  eq('undefined', serializeLogValue(undefined), '[undefined]');
  eq('bigint', serializeLogValue(10n), '10n');
  const circular = { name: 'root' };
  circular.self = circular;
  eq('circular', serializeLogValue(circular).self, '[Circular]');
  check('date', serializeLogValue(new Date(0)) === '1970-01-01T00:00:00.000Z');

  // ── Size limits ────────────────────────────────────────────────────────
  const truncated = serializeLogValue('z'.repeat(200), { maxStringLength: 10 });
  check('string truncation', truncated.startsWith('zzzzzzzzzz…[truncated 190'));
  const capped = serializeLogValue([1, 2, 3, 4], { maxArrayLength: 2 });
  eq('array cap marker', capped[2], '[+2 more of 4]');

  // ── Ambient context ────────────────────────────────────────────────────
  const uninstall = installLogContextProvider();
  const contextRecords = [];
  const contextLogger = createLogger({
    console: false,
    transports: { write: (r) => void contextRecords.push(r) },
  });
  try {
    await runWithLogContext({ loggedInUser: { id: 'u-1' }, traceId: 'ctx-trace' }, async () => {
      eq('context readable inside frame', getLogContext()?.traceId, 'ctx-trace');
      await contextLogger.info('inside context').send();
    });
  } finally {
    uninstall();
  }
  eq('context user on record', contextRecords[0]?.loggedInUser?.id, 'u-1');
  eq('context trace on record', contextRecords[0]?.traceId, 'ctx-trace');
  eq('frame restored', getLogContext(), undefined);

  // Async isolation only holds where the runtime provides real async context.
  eq('async context advertised', isAsyncContextTracked(), expectAsyncContext);
  if (isAsyncContextTracked()) {
    const observed = [];
    await Promise.all(
      ['a', 'b'].map((id, index) =>
        runWithLogContext({ traceId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, index === 0 ? 25 : 1));
          observed.push([id, getLogContext()?.traceId]);
        }),
      ),
    );
    for (const [id, seen] of observed) {
      eq(`concurrent flow ${id} isolated`, seen, id);
    }
  }

  // ── Root export resolves to this runtime's implementation ──────────────
  check(
    `root export runtime (${rootLogger.runtime})`,
    typeof rootLogger.runtime === 'string' && rootLogger.runtime.length > 0,
  );

  // ── Drain ──────────────────────────────────────────────────────────────
  await waitForPendingLogs({ timeoutMillis: 2_000 });
  await logger.close();
  await secretLogger.close();
  await contextLogger.close();

  return {
    runtime,
    detectedRuntime: rootLogger.runtime,
    asyncContext: isAsyncContextTracked(),
    checks,
    failures,
  };
}

export function formatResult(result) {
  const lines = [
    `[conformance:${result.runtime}] root export → "${result.detectedRuntime}", ` +
      `async context ${result.asyncContext ? 'tracked' : 'single-frame'}, ` +
      `${result.checks - result.failures.length}/${result.checks} checks passed`,
  ];
  for (const failure of result.failures) {
    lines.push(`  ✗ ${failure}`);
  }
  return lines.join('\n');
}
