import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace OresOtel;

@id("OresErrorTraceTelemetryV1")
model OresErrorTraceTelemetryV1 {
  @minValue(1)
  @maxValue(1)
  version: integer;

  kind: "error";

  @minLength(1)
  @maxLength(256)
  service: string;

  @minLength(1)
  @maxLength(128)
  environment?: string;

  @minLength(1)
  @maxLength(256)
  repository?: string;

  @pattern("^[0-9a-f]{7,64}$")
  release_sha?: string;

  @pattern("^ores-trace-[A-Za-z0-9_-]{12,64}$")
  trace_id?: string;

  @pattern("^ores-trace-[A-Za-z0-9_-]{12,64}$")
  parent_trace_id?: string;

  @pattern("^[0-9a-f]{32}$")
  otel_trace_id?: string;

  @pattern("^[0-9a-f]{16}$")
  otel_span_id?: string;

  @minLength(1)
  @maxLength(256)
  exception_type?: string;

  @minLength(1)
  @maxLength(128)
  error_type?: string;

  @minLength(1)
  @maxLength(128)
  error_code?: string;

  @maxLength(8192)
  message?: string;

  @maxItems(32)
  error_list?: string[];

  @maxLength(1024)
  top_frame?: string;

  @maxLength(512)
  operation?: string;

  @maxLength(32)
  severity?: string;

  @maxLength(64)
  runtime?: string;

  @maxLength(128)
  source?: string;

  @pattern("^ores-routine-[A-Za-z0-9_-]{12,64}$")
  routine_id?: string;

  @maxLength(1024)
  file_name?: string;
}
