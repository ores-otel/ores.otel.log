// `base` is the namespace re-export every runtime entry point carries; it holds
// the shared surface as both values (base.r2gSmokeTest) and types (base.LogRecord).
// Node's package root additionally promotes r2gSmokeTest for r2g phase-S.
import { NodeLogger, base, r2gSmokeTest } from '@oresoftware/next-loggers';
import {
  BaseLogger,
  LogEvent,
  createLogger,
  type LogArgument,
  type LogLevel,
} from '@oresoftware/next-loggers/base';
import { BrowserLogger } from '@oresoftware/next-loggers/browser';
import { BunLogger } from '@oresoftware/next-loggers/bun';
import { DenoLogger } from '@oresoftware/next-loggers/deno';
import { EdgeLogger } from '@oresoftware/next-loggers/edge';
import { CloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';

type LogRecord = base.LogRecord;
import {
  installLogContextProvider,
  runWithLogContext,
} from '@oresoftware/next-loggers/context';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const records: LogRecord[] = [];
const logger = createLogger({
  console: false,
  transports: {
    write(record) {
      records.push(record);
    },
  },
});

await logger.info('dummy TypeScript consumer').addFields({ source: 'r2g' }).send();
assert(records.length === 1, 'the dummy consumer should deliver one record');
assert(records[0]?.message === 'dummy TypeScript consumer', 'the record should retain its message');

class ConsumerEvent extends LogEvent {
  withConsumer(name: string): this {
    this.fields.consumer = name;
    return this;
  }
}

class ConsumerLogger extends BaseLogger<ConsumerEvent> {
  protected override createLogEvent(level: LogLevel, values: LogArgument[]): ConsumerEvent {
    return new ConsumerEvent(this, level, values);
  }
}

await new ConsumerLogger({ console: false })
  .info('extensible logger')
  .withConsumer('r2g-typescript')
  .send();

const nodeLogger = new NodeLogger({ console: false, flushOnShutdown: false });
await nodeLogger.info('node entry point').send();
await nodeLogger.close();

{
  const uninstall = installLogContextProvider();
  try {
    await runWithLogContext(
      { loggedInUser: { id: 'r2g-user' }, traceId: 'r2g-trace' },
      async () => {
        await logger.info('ambient context record').send();
      },
    );
  } finally {
    uninstall();
  }
  const contextRecord = records.find((record) => record.message === 'ambient context record');
  assert(contextRecord?.loggedInUser?.id === 'r2g-user', 'ALS context should supply the user');
  assert(contextRecord?.traceId === 'r2g-trace', 'ALS context should supply the trace id');
}

{
  const posts: string[] = [];
  const tracked = createLogger({ console: false }).setErrorTrackingUrl(
    'https://errors.example.test/collect',
    {
      fallbackUrl: 'https://apps-script.example.test/exec',
      fetch: (async (url: string) => {
        posts.push(url);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
  );
  await tracked.info('below error threshold').send();
  await tracked.error('tracked error').send();
  assert(posts.length === 1, 'only the error should reach the tracking endpoint');
  await tracked.close();
}

await logger.close();

assert(
  r2gSmokeTest === base.r2gSmokeTest,
  'the package-root phase-S export should be the shared smoke function',
);
assert(
  await r2gSmokeTest(),
  'the phase-S smoke export should also pass in the TypeScript consumer',
);
assert(
  [BrowserLogger, EdgeLogger, CloudflareWorkerLogger, BunLogger, DenoLogger].every(
    (value) => typeof value === 'function',
  ),
  'all runtime logger classes should be exported',
);

console.log('next-loggers dummy TypeScript consumer passed');
