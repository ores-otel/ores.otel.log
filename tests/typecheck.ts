import { logger as runtimeLogger, type LogRecord } from '@oresoftware/next-loggers';
import {
  BaseLogger,
  createLogger,
  LogEvent,
  type LogArgument,
  type LogLevel,
  type LogTransport,
} from '@oresoftware/next-loggers/base';
import { createBrowserLogger, base as browserBase } from '@oresoftware/next-loggers/browser';
import { createBunLogger, base as bunBase } from '@oresoftware/next-loggers/bun';
import { createDenoLogger, base as denoBase } from '@oresoftware/next-loggers/deno';
import { createEdgeLogger, base as edgeBase } from '@oresoftware/next-loggers/edge';
import {
  createCloudflareWorkerLogger,
  base as cloudflareBase,
  type CloudflareWorkerLoggerOptions,
} from '@oresoftware/next-loggers/cloudflare';
import { createNodeLogger, base as nodeBase } from '@oresoftware/next-loggers/node';
import eslintPlugin, { requireSendRule } from '@oresoftware/next-loggers/eslint';

// `export * as base` must carry types, not only values: every alias below
// resolves a base type through a runtime entry point's namespace re-export.
type BrowserSharedOptions = browserBase.LoggerOptions;
type BrowserSharedRecord = browserBase.LogRecord;
type BunSharedFlushOptions = bunBase.FlushOptions;
type BunSharedRecord = bunBase.LogRecord;
type DenoSharedTransport = denoBase.LogTransport;
type DenoSharedRecord = denoBase.LogRecord;
type EdgeSharedSupabaseOptions = edgeBase.SupabaseRealtimeOptions;
type EdgeSharedRecord = edgeBase.LogRecord;
type CloudflareSharedHttpOptions = cloudflareBase.HttpTransportOptions;
type CloudflareSharedRecord = cloudflareBase.LogRecord;
type NodeSharedHttpOptions = nodeBase.HttpTransportOptions;
type NodeSharedRecord = nodeBase.LogRecord;

const transport: LogTransport = {
  write(record: LogRecord): void {
    void record.message;
  },
};

const browserOptions: BrowserSharedOptions = { appName: 'browser' };
const bunFlushOptions: BunSharedFlushOptions = { timeoutMillis: 100 };
const denoTransport: DenoSharedTransport = {
  write(record: DenoSharedRecord): void {
    void record.level;
  },
};
const edgeSupabase: EdgeSharedSupabaseOptions = { url: 'https://x.supabase.co', anonKey: 'anon' };
const cloudflareHttp: CloudflareSharedHttpOptions = { endpoint: 'https://logs.example.com' };
const nodeHttp: NodeSharedHttpOptions = { endpoint: 'https://logs.example.com' };
const cloudflareOptions: CloudflareWorkerLoggerOptions = {
  appName: 'worker',
  http: cloudflareHttp,
  envFields: ['ENVIRONMENT'],
};

void ((record: BrowserSharedRecord | BunSharedRecord | EdgeSharedRecord | CloudflareSharedRecord | NodeSharedRecord) =>
  record.runtime);

void runtimeLogger.info('root logger').send();
void createLogger({ transports: transport }).info('base').send();
void createBrowserLogger(browserOptions).info('browser').send();
void createEdgeLogger({ supabase: edgeSupabase }).info('edge').send();
void createCloudflareWorkerLogger(cloudflareOptions).info('cloudflare').send();
void createNodeLogger({ http: nodeHttp }).info('node').send();
void createBunLogger().flush(bunFlushOptions);
void createDenoLogger({ transports: denoTransport }).info('deno').send();
void eslintPlugin.rules['require-send'];
void requireSendRule.create;

class AuditEvent extends LogEvent {
  withActor(actor: string): this {
    this.fields.actor = actor;
    return this;
  }
}

class AuditLogger extends BaseLogger<AuditEvent> {
  constructor() {
    super({ appName: 'audit' }, 'custom-audit-runtime');
  }

  protected override createLogEvent(level: LogLevel, values: LogArgument[]): AuditEvent {
    return new AuditEvent(this, level, values);
  }
}

void new AuditLogger().info('extended').withActor('user-1').send();
