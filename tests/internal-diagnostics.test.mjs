import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  INTERNAL_DIAGNOSTIC_BATCH_SCHEMA,
  INTERNAL_DIAGNOSTIC_CONTENT_TYPE,
  INTERNAL_DIAGNOSTIC_SCHEMA,
  INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA,
  InternalDiagnosticReporter,
  InternalDiagnosticUploadGrant,
  createInternalDiagnosticBatch,
  createOtelBridgeDiagnosticHook,
  uploadInternalDiagnosticBatch,
} from '../dist/internal-diagnostics.js';
import {
  createAwsCloudWatchLogsSink,
  createAzureMonitorLogsSink,
  createGoogleCloudLoggingSink,
  createStderrInternalDiagnosticSink,
} from '../dist/internal-diagnostics-backend.js';

const NOW_TEXT = '2026-08-29T18:00:00.000Z';
const NOW_MILLIS = Date.parse(NOW_TEXT);
const fixedNow = () => new Date(NOW_TEXT);

const DIAGNOSTIC_INPUT = Object.freeze({
  severity: 'error',
  operation: 'exporter_write',
  outcome: 'failed',
  retryable: true,
  attempt: 1,
  dropped: 2,
});

async function oneRecord() {
  const records = [];
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'otel_bridge',
    sinks: [(record) => records.push(record)],
    now: fixedNow,
  });
  assert.deepEqual(await reporter.report(DIAGNOSTIC_INPUT), {
    status: 'delivered',
    sinkIndex: 0,
  });
  assert.equal(records.length, 1);
  return records[0];
}

function grantInput(provider, uploadUrl, overrides = {}) {
  return {
    schema: INTERNAL_DIAGNOSTIC_UPLOAD_GRANT_SCHEMA,
    provider,
    method: 'PUT',
    uploadUrl,
    expiresAt: '2026-08-29T18:05:00.000Z',
    maxBytes: 65_536,
    contentType: INTERNAL_DIAGNOSTIC_CONTENT_TYPE,
    headers: {
      'content-type': INTERNAL_DIAGNOSTIC_CONTENT_TYPE,
      ...(provider === 'azure_blob' ? { 'x-ms-blob-type': 'BlockBlob' } : {}),
    },
    ...overrides,
  };
}

const AWS_URL =
  'https://diagnostics.s3.us-east-1.amazonaws.com/outage/object.json' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=temporary%2F20260829%2Fus-east-1%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20260829T180000Z&X-Amz-Expires=600' +
  '&X-Amz-SignedHeaders=content-type%3Bhost' +
  '&X-Amz-Signature=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GCP_URL =
  'https://storage.googleapis.com/diagnostics/outage/object.json' +
  '?X-Goog-Algorithm=GOOG4-RSA-SHA256' +
  '&X-Goog-Credential=temporary%2F20260829%2Fauto%2Fstorage%2Fgoog4_request' +
  '&X-Goog-Date=20260829T180000Z&X-Goog-Expires=600' +
  '&X-Goog-SignedHeaders=content-type%3Bhost' +
  '&X-Goog-Signature=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const AZURE_URL =
  'https://diagnostics.blob.core.windows.net/outage/object.json' +
  '?sv=2026-01-01&se=2026-08-29T18%3A10%3A00.000Z&sp=cw&sr=b&spr=https' +
  '&sig=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

test('reporter emits a closed payload-free record', async () => {
  const record = await oneRecord();
  assert.deepEqual(record, {
    schema: INTERNAL_DIAGNOSTIC_SCHEMA,
    timestamp: NOW_TEXT,
    service: 'orders-api',
    severity: 'error',
    component: 'otel_bridge',
    operation: 'exporter_write',
    outcome: 'failed',
    retryable: true,
    attempt: 1,
    dropped: 2,
    suppressed: 0,
    suppressionSaturated: false,
  });
  for (const forbidden of [
    'message',
    'error',
    'stack',
    'url',
    'traceId',
    'spanId',
    'userId',
    'token',
  ]) {
    assert.equal(Object.hasOwn(record, forbidden), false, forbidden);
  }
});

test('unknown fields are rejected instead of silently becoming diagnostics', async () => {
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'otel_bridge',
    sinks: [() => undefined],
    now: fixedNow,
  });
  await assert.rejects(
    reporter.report({ ...DIAGNOSTIC_INPUT, message: 'synthetic-secret-never-emit' }),
    /invalid internal diagnostic input/,
  );
  await assert.rejects(
    reporter.report({ ...DIAGNOSTIC_INPUT, retryable: 'synthetic-secret-never-emit' }),
    /invalid internal diagnostic input/,
  );
});

test('OpenTelemetry bridge hook discards errors and maps only closed operation classes', async () => {
  const records = [];
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'otel_bridge',
    sinks: [(record) => records.push(record)],
    now: fixedNow,
  });
  const reportBridgeError = createOtelBridgeDiagnosticHook(reporter);
  reportBridgeError(
    new Error('Authorization: Bearer synthetic-secret; https://signed.example/object?sig=secret'),
    'provider.forceFlush',
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(records.length, 1);
  assert.equal(records[0].operation, 'exporter_flush');
  assert.doesNotMatch(JSON.stringify(records[0]), /Authorization|synthetic-secret|signed\.example|sig=/);
});

test('recursive reports are suppressed and accounted for on the next record', async () => {
  const records = [];
  let nested;
  let reporter;
  const sink = (record) => {
    records.push(record);
    if (records.length === 1) nested = reporter.report(DIAGNOSTIC_INPUT);
  };
  reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'otel_bridge',
    sinks: [sink],
    now: fixedNow,
  });

  assert.equal((await reporter.report(DIAGNOSTIC_INPUT)).status, 'delivered');
  assert.deepEqual(await nested, { status: 'suppressed' });
  assert.equal((await reporter.report(DIAGNOSTIC_INPUT)).status, 'delivered');
  assert.equal(records[1].suppressed, 1);
  assert.equal(records[1].suppressionSaturated, false);
});

test('cloud failure falls through to independent stderr without throwing', async () => {
  const lines = [];
  const cloud = createAwsCloudWatchLogsSink({
    logGroupName: 'ores/internal',
    logStreamName: 'orders-api',
    putLogEvents: async () => {
      throw new Error('cloud unavailable');
    },
  });
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'cloudwatch_logs',
    sinks: [cloud, createStderrInternalDiagnosticSink({ writeLine: (line) => lines.push(line) })],
    now: fixedNow,
  });

  assert.deepEqual(await reporter.report(DIAGNOSTIC_INPUT), {
    status: 'delivered',
    sinkIndex: 1,
  });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).schema, INTERNAL_DIAGNOSTIC_SCHEMA);
  assert.doesNotMatch(lines[0], /cloud unavailable/);
});

test('CloudWatch event rejection falls through despite a successful API response', async () => {
  const lines = [];
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'cloudwatch_logs',
    sinks: [
      createAwsCloudWatchLogsSink({
        logGroupName: 'ores/internal',
        logStreamName: 'orders-api',
        putLogEvents: async () => ({
          rejectedLogEventsInfo: { tooNewLogEventStartIndex: 0 },
        }),
      }),
      createStderrInternalDiagnosticSink({ writeLine: (line) => lines.push(line) }),
    ],
    now: fixedNow,
  });

  assert.deepEqual(await reporter.report(DIAGNOSTIC_INPUT), {
    status: 'delivered',
    sinkIndex: 1,
  });
  assert.equal(lines.length, 1);
});

test('close waits for in-flight delivery and terminally rejects later reports', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'sidecar',
    sinks: [async () => gate],
    now: fixedNow,
  });
  const reporting = reporter.report(DIAGNOSTIC_INPUT);
  await Promise.resolve();
  const closing = reporter.close();
  assert.equal(reporter.snapshot().state, 'closing');
  release();
  await reporting;
  await closing;
  assert.equal(reporter.snapshot().state, 'closed');
  assert.deepEqual(await reporter.report(DIAGNOSTIC_INPUT), { status: 'closed' });
});

test('report and close wait for asynchronous stderr drain', async () => {
  let release;
  const drained = new Promise((resolve) => {
    release = resolve;
  });
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'sidecar',
    sinks: [createStderrInternalDiagnosticSink({ writeLine: async () => drained })],
    now: fixedNow,
  });
  const reporting = reporter.report(DIAGNOSTIC_INPUT);
  await Promise.resolve();
  const closing = reporter.close();
  assert.equal(reporter.snapshot().state, 'closing');
  release();
  assert.equal((await reporting).status, 'delivered');
  await closing;
  assert.equal(reporter.snapshot().state, 'closed');
});

test('a synchronous sink-triggered close cannot reopen the terminal state', async () => {
  let close;
  let reporter;
  reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'sidecar',
    sinks: [() => {
      close = reporter.close();
    }],
    now: fixedNow,
  });

  assert.equal((await reporter.report(DIAGNOSTIC_INPUT)).status, 'delivered');
  await close;
  assert.equal(reporter.snapshot().state, 'closed');
  assert.deepEqual(await reporter.report(DIAGNOSTIC_INPUT), { status: 'closed' });
});

test('a hostile clock cannot admit a second in-flight report', async () => {
  const records = [];
  let nested;
  let clockCalls = 0;
  let reporter;
  reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'otel_bridge',
    sinks: [(record) => records.push(record)],
    now: () => {
      clockCalls += 1;
      if (clockCalls === 1) nested = reporter.report(DIAGNOSTIC_INPUT);
      return fixedNow();
    },
  });

  assert.equal((await reporter.report(DIAGNOSTIC_INPUT)).status, 'delivered');
  assert.deepEqual(await nested, { status: 'suppressed' });
  assert.equal(records.length, 1);
  await reporter.report(DIAGNOSTIC_INPUT);
  assert.equal(records[1].suppressed, 1);
});

test('report input is an accessor-free canonical snapshot', async () => {
  const records = [];
  const reporter = new InternalDiagnosticReporter({
    service: 'orders-api',
    component: 'otel_bridge',
    sinks: [(record) => records.push(record)],
    now: fixedNow,
  });
  const accessorInput = { ...DIAGNOSTIC_INPUT };
  Object.defineProperty(accessorInput, 'severity', {
    enumerable: true,
    get: () => 'error',
  });
  await assert.rejects(reporter.report(accessorInput), /invalid internal diagnostic input/);

  const mutableInput = { ...DIAGNOSTIC_INPUT };
  const reporting = reporter.report(mutableInput);
  mutableInput.operation = 'upload_put';
  await reporting;
  assert.equal(records[0].operation, 'exporter_write');
});

test('batches are fixed-size, schema-valid, and reject extended records', async () => {
  const record = await oneRecord();
  const batch = createInternalDiagnosticBatch([record], fixedNow);
  assert.equal(batch.schema, INTERNAL_DIAGNOSTIC_BATCH_SCHEMA);
  assert.equal(batch.createdAt, NOW_TEXT);
  assert.deepEqual(batch.records, [record]);
  assert.throws(
    () => createInternalDiagnosticBatch([{ ...record, message: 'not allowed' }], fixedNow),
    /invalid internal diagnostic batch/,
  );
  assert.throws(
    () => createInternalDiagnosticBatch(Array.from({ length: 65 }, () => record), fixedNow),
    /invalid internal diagnostic batch/,
  );
});

test('AWS, GCP, and Azure grants validate provider hosts and redact credentials', () => {
  for (const [provider, url] of [
    ['aws_s3', AWS_URL],
    ['gcp_cloud_storage', GCP_URL],
    ['azure_blob', AZURE_URL],
  ]) {
    const grant = InternalDiagnosticUploadGrant.parse(grantInput(provider, url), NOW_MILLIS);
    const serialized = JSON.stringify(grant);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /X-Amz-|X-Goog-|sig=|aaaaaaaa|bbbbbbbb|cccccccc/);
    assert.doesNotMatch(serialized, /Credential|sig=/);
  }
});

test('contract grant fixtures agree with the runtime provider branches', async () => {
  for (const provider of ['aws', 'gcp', 'azure']) {
    const valid = JSON.parse(
      await readFile(
        new URL(
          `../contracts/fixtures/valid/internal-diagnostic-upload-grant-${provider}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const invalid = JSON.parse(
      await readFile(
        new URL(
          `../contracts/fixtures/invalid/internal-diagnostic-upload-grant-${provider}-header.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.doesNotThrow(() => InternalDiagnosticUploadGrant.parse(valid, NOW_MILLIS));
    assert.throws(
      () => InternalDiagnosticUploadGrant.parse(invalid, NOW_MILLIS),
      /headers are invalid/,
    );
  }
});

test('upload grants fail closed for arbitrary hosts, stale grants, and excess authority', () => {
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput('aws_s3', AWS_URL.replace('diagnostics.s3.us-east-1.amazonaws.com', 'evil.test')),
        NOW_MILLIS,
      ),
    /URL is invalid/,
  );
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput('aws_s3', AWS_URL, { expiresAt: '2026-08-29T17:59:59.000Z' }),
        NOW_MILLIS,
      ),
    /expiry is invalid/,
  );
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput('azure_blob', AZURE_URL, {
          headers: {
            'content-type': INTERNAL_DIAGNOSTIC_CONTENT_TYPE,
            'x-ms-blob-type': 'BlockBlob',
            authorization: 'not-allowed',
          },
        }),
        NOW_MILLIS,
      ),
    /headers are invalid/,
  );
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput('azure_blob', AZURE_URL.replace('sr=b', 'sr=c')),
        NOW_MILLIS,
      ),
    /signature expiry is invalid/,
  );
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput('azure_blob', AZURE_URL.replace('sp=cw', 'sp=rw')),
        NOW_MILLIS,
      ),
    /signature expiry is invalid/,
  );
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput('aws_s3', `${AWS_URL}&X-Amz-Expires=30`),
        NOW_MILLIS,
      ),
    /signature expiry is invalid/,
  );
  assert.throws(
    () =>
      InternalDiagnosticUploadGrant.parse(
        grantInput(
          'azure_blob',
          AZURE_URL.replace('18%3A10%3A00.000Z', '18%3A30%3A00.000Z'),
        ),
        NOW_MILLIS,
      ),
    /signature expiry is invalid/,
  );
});

test('outage upload is one bounded credential-free PUT with strict browser controls', async () => {
  const record = await oneRecord();
  const batch = createInternalDiagnosticBatch([record], fixedNow);
  const grant = InternalDiagnosticUploadGrant.parse(
    grantInput('aws_s3', AWS_URL),
    NOW_MILLIS,
  );
  const calls = [];
  const result = await uploadInternalDiagnosticBatch(grant, batch, {
    nowMillis: () => NOW_MILLIS,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    },
  });
  assert.deepEqual(result, { status: 'uploaded' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.headers['content-type'], INTERNAL_DIAGNOSTIC_CONTENT_TYPE);
  assert.equal(JSON.parse(calls[0].init.body).schema, INTERNAL_DIAGNOSTIC_BATCH_SCHEMA);
  assert.deepEqual(
    await uploadInternalDiagnosticBatch(grant, batch, {
      nowMillis: () => NOW_MILLIS,
      fetch: async () => {
        throw new Error('a consumed grant must never be retried');
      },
    }),
    { status: 'rejected', reason: 'invalid_batch' },
  );
});

test('outage upload rebuilds a closed body and rejects batch serialization tricks', async () => {
  const record = await oneRecord();
  const batch = createInternalDiagnosticBatch([record], fixedNow);
  const calls = [];
  const upload = (candidate) =>
    uploadInternalDiagnosticBatch(
      InternalDiagnosticUploadGrant.parse(grantInput('gcp_cloud_storage', GCP_URL), NOW_MILLIS),
      candidate,
      {
        nowMillis: () => NOW_MILLIS,
        fetch: async (...arguments_) => {
          calls.push(arguments_);
          return new Response(null, { status: 200 });
        },
      },
    );

  assert.deepEqual(await upload({ ...batch, message: 'synthetic-secret' }), {
    status: 'rejected',
    reason: 'invalid_batch',
  });
  const inheritedSerializer = Object.create({
    toJSON: () => ({ message: 'synthetic-secret' }),
  });
  Object.assign(inheritedSerializer, batch);
  assert.deepEqual(await upload(inheritedSerializer), { status: 'uploaded' });
  assert.doesNotMatch(calls[0][1].body, /synthetic-secret/);
  assert.equal(JSON.parse(calls[0][1].body).schema, INTERNAL_DIAGNOSTIC_BATCH_SCHEMA);
});

test('outage upload exposes only closed failure reasons', async () => {
  const record = await oneRecord();
  const batch = createInternalDiagnosticBatch([record], fixedNow);
  const grant = InternalDiagnosticUploadGrant.parse(
    grantInput('gcp_cloud_storage', GCP_URL),
    NOW_MILLIS,
  );
  const failure = await uploadInternalDiagnosticBatch(grant, batch, {
    nowMillis: () => NOW_MILLIS,
    fetch: async () => {
      throw new Error('signed URL and provider body must not escape');
    },
  });
  assert.deepEqual(failure, { status: 'failed', reason: 'network' });
  assert.doesNotMatch(JSON.stringify(failure), /signed URL|provider body|synthetic-signature/);
});

test('backend sinks reject direct payload injection before provider or stderr delivery', async () => {
  const invalid = {
    timestamp: NOW_TEXT,
    severity: 'error',
    message: 'Authorization: Bearer synthetic-secret-never-forward',
  };
  const calls = [];
  const stderr = createStderrInternalDiagnosticSink({ writeLine: (line) => calls.push(line) });
  const aws = createAwsCloudWatchLogsSink({
    logGroupName: 'ores/internal',
    logStreamName: 'orders-api',
    putLogEvents: async (request) => calls.push(request),
  });
  const google = createGoogleCloudLoggingSink({
    projectId: 'example-project',
    logId: 'ores-internal',
    writeEntries: async (request) => calls.push(request),
  });
  const azure = createAzureMonitorLogsSink({
    ruleId: 'dcr-00000000000000000000000000000000',
    streamName: 'Custom-OresInternal_CL',
    upload: async (...arguments_) => calls.push(arguments_),
  });

  assert.throws(() => stderr(invalid), /invalid internal diagnostic record/);
  await assert.rejects(aws(invalid), /invalid internal diagnostic record/);
  await assert.rejects(google(invalid), /invalid internal diagnostic record/);
  await assert.rejects(azure(invalid), /invalid internal diagnostic record/);
  assert.deepEqual(calls, []);
});

test('backend sinks snapshot validated provider configuration', async () => {
  const record = await oneRecord();
  const originalCalls = [];
  const mutatedCalls = [];
  const options = {
    logGroupName: 'ores/internal',
    logStreamName: 'orders-api',
    putLogEvents: async (request) => originalCalls.push(request),
  };
  const sink = createAwsCloudWatchLogsSink(options);
  options.logGroupName = 'invalid value containing spaces';
  options.logStreamName = 'changed';
  options.putLogEvents = async (request) => mutatedCalls.push(request);

  await sink(record);
  assert.equal(originalCalls.length, 1);
  assert.equal(mutatedCalls.length, 0);
  assert.equal(originalCalls[0].logGroupName, 'ores/internal');
  assert.equal(originalCalls[0].logStreamName, 'orders-api');
});

test('backend adapters map the same closed record to all three native APIs', async () => {
  const record = await oneRecord();
  const aws = [];
  const google = [];
  const azure = [];

  await createAwsCloudWatchLogsSink({
    logGroupName: 'ores/internal',
    logStreamName: 'orders-api',
    putLogEvents: async (request) => aws.push(request),
  })(record);
  await createGoogleCloudLoggingSink({
    projectId: 'example-project',
    logId: 'ores-internal',
    writeEntries: async (request) => google.push(request),
  })(record);
  await createAzureMonitorLogsSink({
    ruleId: 'dcr-00000000000000000000000000000000',
    streamName: 'Custom-OresInternal_CL',
    upload: async (...arguments_) => azure.push(arguments_),
  })(record);

  assert.deepEqual(aws[0], {
    logGroupName: 'ores/internal',
    logStreamName: 'orders-api',
    logEvents: [{ message: JSON.stringify(record), timestamp: NOW_MILLIS }],
  });
  assert.equal(google[0].entries[0].logName, 'projects/example-project/logs/ores-internal');
  assert.deepEqual(google[0].entries[0].resource, {
    type: 'global',
    labels: { project_id: 'example-project' },
  });
  assert.equal(google[0].entries[0].severity, 'ERROR');
  assert.deepEqual(google[0].entries[0].jsonPayload, record);
  assert.notStrictEqual(google[0].entries[0].jsonPayload, record);
  assert.equal(google[0].partialSuccess, false);
  assert.deepEqual(azure[0].slice(0, 2), [
    'dcr-00000000000000000000000000000000',
    'Custom-OresInternal_CL',
  ]);
  assert.equal(azure[0][2][0].TimeGenerated, NOW_TEXT);
  assert.equal(azure[0][2][0].schema, INTERNAL_DIAGNOSTIC_SCHEMA);
});
