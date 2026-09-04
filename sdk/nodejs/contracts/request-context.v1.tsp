// Human-authored TypeSpec authority for ores.request-context.v1.
// This file is a peer of request-context.v1.schema.json, not generated from it.

namespace Ores.Telemetry;

@doc("A non-empty, bounded correlation identifier. It is never a credential.")
@minLength(1)
@maxLength(256)
scalar ContextId extends string;

@doc("Allowlisted W3C trace identifier.")
@pattern("^[0-9a-f]{32}$")
scalar TraceId extends string;

@doc("Allowlisted W3C span identifier.")
@pattern("^[0-9a-f]{16}$")
scalar SpanId extends string;

model RequestBaggage {
  [key: string]: string;
}

@doc("Request-scoped correlation data shared by middleware and telemetry. Raw tokens, cookies, authorization headers, email addresses, and credentials are forbidden.")
model RequestContextV1 {
  schema?: "ores.request-context.v1";
  requestId: ContextId;
  loggedInUserId?: ContextId;
  tenantId?: ContextId;
  sessionId?: ContextId;
  correlationId?: ContextId;
  parentRequestId?: ContextId;
  traceId?: TraceId;
  spanId?: SpanId;
  operation?: string;
  serviceName?: string;
  locale?: string;
  startedAtUnixMs?: uint64;
  deadlineUnixMs?: uint64;
  baggage?: RequestBaggage;
}
