# Independent internal diagnostics

An observability library cannot safely rely on its own primary telemetry path
to explain why that path is failing. ORES therefore provides a separate,
payload-free control plane for failures inside exporters, transports,
collectors, and sidecars.

The control plane has three deliberate properties:

1. It accepts only closed enums and bounded counters. It never accepts a log
   message, an `Error`, a stack, a URL, trace or user identifiers, headers, or
   credentials.
2. It is non-reentrant and bounded. A diagnostic raised while another one is
   being delivered is counted as suppressed rather than recursively logged.
3. It has independent delivery. Backend processes can call a cloud-native log
   API and fall through to direct structured `stderr`; browser and edge clients
   can use a short-lived object-specific upload grant as an outage spool.

The canonical record and batch contracts are
`contracts/schemas/internal-diagnostic.schema.json` and
`contracts/schemas/internal-diagnostic-batch.schema.json`. Both disallow
unknown properties.

## Backend setup

Import the cloud adapters only from the explicit backend entry point. Each
adapter accepts an injected authenticated SDK operation, so ORES does not own,
cache, or redistribute cloud credentials.

```ts
import {
  InternalDiagnosticReporter,
  createOtelBridgeDiagnosticHook,
} from '@oresoftware/next-loggers/internal-diagnostics';
import {
  createAwsCloudWatchLogsSink,
  createStderrInternalDiagnosticSink,
} from '@oresoftware/next-loggers/internal-diagnostics/backend';
import { createOpenTelemetryTransport } from '@oresoftware/next-loggers/otel';
import { CloudWatchLogsClient, PutLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const cloudWatch = new CloudWatchLogsClient({});
const reporter = new InternalDiagnosticReporter({
  service: 'orders-api',
  component: 'otel_bridge',
  sinks: [
    createAwsCloudWatchLogsSink({
      logGroupName: 'ores/internal',
      logStreamName: 'orders-api',
      putLogEvents: (request) => cloudWatch.send(new PutLogEventsCommand(request)),
    }),
    createStderrInternalDiagnosticSink(),
  ],
});

const otelTransport = createOpenTelemetryTransport({
  logger: applicationOwnedOtelLogger,
  onBridgeError: createOtelBridgeDiagnosticHook(reporter),
});
```

The hook intentionally discards the original error and maps the bridge
operation into the closed `exporter_write` or `exporter_flush` class. This
prevents provider response bodies, signed URLs, authorization headers, and
application payloads from entering the fallback path.

The GCP and Azure bindings use the same reporter:

```ts
const gcpSink = createGoogleCloudLoggingSink({
  projectId: 'example-project',
  logId: 'ores-internal',
  writeEntries: (request) => loggingClient.writeLogEntries(request),
});

const azureSink = createAzureMonitorLogsSink({
  ruleId: 'dcr-00000000000000000000000000000000',
  streamName: 'Custom-OresInternal_CL',
  upload: (ruleId, streamName, records) =>
    logsIngestionClient.upload(ruleId, streamName, records),
});
```

Use workload identity, instance roles, managed identity, or another ambient
backend credential mechanism to configure those clients. Do not embed cloud
credentials in ORES configuration.

Keep direct `stderr` as the last sink. EKS/EC2 log agents can route it to
CloudWatch Logs, GKE logging agents can route it to Cloud Logging, and Azure
Container Insights can route it to Log Analytics. Because the sink writes
directly to `process.stderr`, it does not invoke the ORES logger or OTLP path.

## Client outage spool

Browsers must not receive CloudWatch, Cloud Logging, or Azure Monitor API
credentials. Direct calls to those APIs also create fragile CORS and
authorization dependencies. If client-originated diagnostics must survive an
ORES backend outage, issue a provider-native signed object-upload grant instead:

- AWS: a presigned S3 `PutObject` URL;
- GCP: a Cloud Storage V4 signed `PUT` URL;
- Azure: a user-delegation SAS scoped to one blob and create/write only.

The grant issuer must bind a unique object key, `PUT`, the internal-diagnostic
content type, and an expiry of at most 15 minutes. It must run in a failure
domain independent of the ordinary application and ORES ingestion backends. A
client cannot obtain a new grant from a backend that is already down; either
use a separately authenticated, authorized, rate-limited provider-edge broker
or proactively refresh one single-object grant. A prefetched grant remains a
temporary credential and must not be placed in ordinary application storage.

The client validator requires a recognized provider hostname on the default
HTTPS port, unique security query parameters, and provider-valid V4/SAS
authority. AWS and GCP grants must sign `host` and `content-type`; Azure grants
must be blob-scoped, HTTPS-only, and limited to write or create/write. Only the
content-type and required Azure blob-type headers are allowed. The URL stays in
opaque storage, and serializing the parsed grant returns
`"uploadUrl":"[REDACTED]"`.

```ts
import {
  InternalDiagnosticUploadGrant,
  createInternalDiagnosticBatch,
  uploadInternalDiagnosticBatch,
} from '@oresoftware/next-loggers/internal-diagnostics';

// Keep at most 64 closed records in memory. Retain them until upload succeeds.
const records = Object.freeze([...outageRecords].slice(0, 64));
const grantResponse = await fetch(INDEPENDENT_GRANT_BROKER_URL, {
  credentials: 'include',
  headers: { accept: 'application/json' },
});
const grant = InternalDiagnosticUploadGrant.parse(await grantResponse.json());
const batch = createInternalDiagnosticBatch(records);
const result = await uploadInternalDiagnosticBatch(grant, batch);
if (result.status === 'uploaded') outageRecords.splice(0, records.length);
```

An upload performs exactly one bounded `PUT` with redirects rejected,
credentials omitted, no referrer, no cache, a bounded timeout, and no automatic
retry. A parsed grant is consumed before the fetch and cannot be reused through
this API, even after a network failure. The result exposes only closed failure
reasons.

Configure object-store CORS for the exact application origins, `PUT`,
`content-type`, and `x-ms-blob-type` only where Azure requires it. The
application CSP must allow the exact object-store hosts in `connect-src`. Do
not use wildcard origins with credentialed grant issuance, and exercise the
real browser preflight in deployment tests.

A cloud-owned worker must treat every uploaded object as untrusted. Before
forwarding, it must enforce the 64 KiB object limit, parse JSON with resource
limits, validate the closed batch schema, and deduplicate by the object key plus
immutable version, generation, or ETag. It can then write records through the
native provider sink. Object-event notifications are at least once, so a crash
between provider delivery and acknowledgement must be safe. Apply bucket
quotas, short retention, and lifecycle deletion to the spool. The `maxBytes`
field is a client and consumer bound; a presigned `PUT` does not generally make
it a cryptographic storage-side limit. The object store is a break-glass
buffer, not a general logging endpoint.

## Failure and trust boundaries

- Native cloud API calls are backend-only and use least-privilege identities.
- Signed upload URLs are temporary credentials: never log, persist, trace, or
  expose them to error reporting, analytics, referrers, or service workers.
- No diagnostic sink reports its own failure through the same reporter.
- Up to three sinks are tried in order. A sink failure falls through without
  exposing the caught error.
- The finite-state model proves bounded accounting and terminal close for the
  configured model bounds. It does not prove cloud availability or SDK/network
  behavior; provider-contract and fault-injection tests remain necessary.
