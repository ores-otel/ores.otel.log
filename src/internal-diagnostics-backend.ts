/** Backend-only sinks for the independent internal-diagnostic control plane. */

import {
  type InternalDiagnosticRecord,
  type InternalDiagnosticSeverity,
  type InternalDiagnosticSink,
  canonicalizeInternalDiagnosticRecord,
} from './internal-diagnostics.js';

declare const process: {
  stderr: {
    write(value: string, callback: (error?: Error | null) => void): boolean;
  };
};

function boundedAsciiName(value: string, pattern: RegExp, maximumBytes = 512): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    new TextEncoder().encode(value).byteLength <= maximumBytes &&
    pattern.test(value)
  );
}

function requireInternalDiagnosticRecord(record: unknown): InternalDiagnosticRecord {
  return canonicalizeInternalDiagnosticRecord(record);
}

function googleSeverity(severity: InternalDiagnosticSeverity): 'WARNING' | 'ERROR' | 'CRITICAL' {
  if (severity === 'warn') return 'WARNING';
  if (severity === 'error') return 'ERROR';
  return 'CRITICAL';
}

export interface StderrInternalDiagnosticSinkOptions {
  readonly writeLine?: (line: string) => void | Promise<void>;
}

/**
 * Write one schema-valid JSON line directly to stderr.
 *
 * This never calls a next-loggers instance. Container/runtime log capture can
 * therefore deliver the line even when the primary ORES transport is broken.
 */
export function createStderrInternalDiagnosticSink(
  options: StderrInternalDiagnosticSinkOptions = {},
): InternalDiagnosticSink {
  const writeLine =
    options.writeLine ??
    ((line: string) =>
      new Promise<void>((resolve, reject) => {
        try {
          process.stderr.write(`${line}\n`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      }));
  return (record) => {
    const canonical = requireInternalDiagnosticRecord(record);
    return writeLine(JSON.stringify(canonical));
  };
}

export interface AwsCloudWatchLogEvent {
  readonly message: string;
  readonly timestamp: number;
}

export interface AwsCloudWatchPutLogEventsRequest {
  readonly logGroupName: string;
  readonly logStreamName: string;
  readonly logEvents: readonly AwsCloudWatchLogEvent[];
}

export interface AwsCloudWatchPutLogEventsResponse {
  readonly rejectedLogEventsInfo?: {
    readonly expiredLogEventEndIndex?: number;
    readonly tooNewLogEventStartIndex?: number;
    readonly tooOldLogEventEndIndex?: number;
  };
}

export interface AwsCloudWatchLogsSinkOptions {
  readonly logGroupName: string;
  readonly logStreamName: string;
  /** Bind this to an authenticated AWS SDK PutLogEvents operation. */
  readonly putLogEvents: (
    request: AwsCloudWatchPutLogEventsRequest,
  ) => Promise<AwsCloudWatchPutLogEventsResponse>;
}

/** Map closed diagnostics to CloudWatch Logs PutLogEvents without SDK coupling. */
export function createAwsCloudWatchLogsSink(
  options: AwsCloudWatchLogsSinkOptions,
): InternalDiagnosticSink {
  const { logGroupName, logStreamName, putLogEvents } = options;
  if (!boundedAsciiName(logGroupName, /^[A-Za-z0-9._/#-]+$/u)) {
    throw new TypeError('invalid CloudWatch log group');
  }
  if (!boundedAsciiName(logStreamName, /^[A-Za-z0-9._/#-]+$/u)) {
    throw new TypeError('invalid CloudWatch log stream');
  }
  if (typeof putLogEvents !== 'function') {
    throw new TypeError('CloudWatch putLogEvents must be a function');
  }
  return async (record) => {
    const canonical = requireInternalDiagnosticRecord(record);
    const response = await putLogEvents({
      logGroupName,
      logStreamName,
      logEvents: [
        {
          message: JSON.stringify(canonical),
          timestamp: Date.parse(canonical.timestamp),
        },
      ],
    });
    if (
      response.rejectedLogEventsInfo &&
      Object.values(response.rejectedLogEventsInfo).some((index) => Number.isInteger(index))
    ) {
      throw new Error('CloudWatch Logs rejected the internal diagnostic event');
    }
  };
}

export interface GoogleCloudLoggingEntry {
  readonly logName: string;
  readonly resource: {
    readonly type: 'global';
    readonly labels: { readonly project_id: string };
  };
  readonly severity: 'WARNING' | 'ERROR' | 'CRITICAL';
  readonly timestamp: string;
  readonly jsonPayload: Readonly<InternalDiagnosticRecord>;
}

export interface GoogleCloudWriteEntriesRequest {
  readonly entries: readonly GoogleCloudLoggingEntry[];
  readonly partialSuccess: false;
}

export interface GoogleCloudLoggingSinkOptions {
  readonly projectId: string;
  readonly logId: string;
  /** Bind this to an authenticated Cloud Logging entries.write operation. */
  readonly writeEntries: (request: GoogleCloudWriteEntriesRequest) => Promise<unknown>;
}

/** Map closed diagnostics to Cloud Logging entries.write without SDK coupling. */
export function createGoogleCloudLoggingSink(
  options: GoogleCloudLoggingSinkOptions,
): InternalDiagnosticSink {
  const { projectId, logId, writeEntries } = options;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)) {
    throw new TypeError('invalid Google Cloud project');
  }
  if (!boundedAsciiName(logId, /^[A-Za-z0-9._/-]+$/u)) {
    throw new TypeError('invalid Google Cloud log ID');
  }
  if (typeof writeEntries !== 'function') {
    throw new TypeError('Cloud Logging writeEntries must be a function');
  }
  const logName = `projects/${projectId}/logs/${encodeURIComponent(logId)}`;
  return async (record) => {
    const canonical = requireInternalDiagnosticRecord(record);
    await writeEntries({
      entries: [
        {
          logName,
          resource: { type: 'global', labels: { project_id: projectId } },
          severity: googleSeverity(canonical.severity),
          timestamp: canonical.timestamp,
          jsonPayload: canonical,
        },
      ],
      partialSuccess: false,
    });
  };
}

export interface AzureMonitorDiagnosticRecord extends InternalDiagnosticRecord {
  readonly TimeGenerated: string;
}

export interface AzureMonitorLogsSinkOptions {
  readonly ruleId: string;
  readonly streamName: string;
  /** Bind this to an authenticated Azure Monitor LogsIngestionClient.upload call. */
  readonly upload: (
    ruleId: string,
    streamName: string,
    records: readonly AzureMonitorDiagnosticRecord[],
  ) => Promise<unknown>;
}

/** Map closed diagnostics to the Azure Monitor Logs Ingestion client contract. */
export function createAzureMonitorLogsSink(
  options: AzureMonitorLogsSinkOptions,
): InternalDiagnosticSink {
  const { ruleId, streamName, upload } = options;
  if (!/^dcr-[a-fA-F0-9]{32}$/u.test(ruleId)) {
    throw new TypeError('invalid Azure data collection rule ID');
  }
  if (!boundedAsciiName(streamName, /^Custom-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 135)) {
    throw new TypeError('invalid Azure stream name');
  }
  if (typeof upload !== 'function') {
    throw new TypeError('Azure Monitor upload must be a function');
  }
  return async (record) => {
    const canonical = requireInternalDiagnosticRecord(record);
    await upload(ruleId, streamName, [
      Object.freeze({ ...canonical, TimeGenerated: canonical.timestamp }),
    ]);
  };
}
