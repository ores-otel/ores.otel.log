import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace OresOtel;

@id("OresContextPropagationV1")
model OresContextPropagationV1 {
  @minValue(1)
  @maxValue(1)
  version: integer;

  @pattern("^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")
  traceparent?: string;

  @maxLength(512)
  tracestate?: string;

  @maxLength(8192)
  baggage?: string;

  @minLength(1)
  @maxLength(256)
  request_id?: string;

  @minLength(1)
  @maxLength(256)
  service?: string;
}
