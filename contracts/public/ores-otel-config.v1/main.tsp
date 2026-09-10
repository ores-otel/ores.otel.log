import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace OresOtel;

@id("OresOtelConfigV1")
model OresOtelConfigV1 {
  @minValue(1)
  @maxValue(1)
  version: integer;

  common?: {
    enabled?: boolean;
    @minLength(1) @maxLength(256) service_name?: string;
    @minLength(1) @maxLength(128) environment?: string;
    logging?: {
      enabled?: boolean;
      @minLength(1) @maxLength(16) level?: string;
      console?: boolean;
      auto_send?: boolean;
    };
    tracing?: {
      enabled?: boolean;
      @minValue(0) @maxValue(1) sample_ratio?: float64;
      propagators?: string[];
    };
    metrics?: {
      enabled?: boolean;
    };
    exporter?: {
      @minLength(1) @maxLength(32) protocol?: string;
      @minLength(1) @maxLength(128) endpoint_env?: string;
    };
  };

  client?: {
    enabled?: boolean;
    @minLength(1) @maxLength(256) service_name?: string;
    @minLength(1) @maxLength(128) environment?: string;
    logging?: {
      enabled?: boolean;
      @minLength(1) @maxLength(16) level?: string;
      console?: boolean;
      auto_send?: boolean;
    };
    tracing?: {
      enabled?: boolean;
      @minValue(0) @maxValue(1) sample_ratio?: float64;
      propagators?: string[];
    };
    metrics?: {
      enabled?: boolean;
    };
    exporter?: {
      @minLength(1) @maxLength(32) protocol?: string;
      @minLength(1) @maxLength(128) endpoint_env?: string;
    };
  };

  server?: {
    enabled?: boolean;
    @minLength(1) @maxLength(256) service_name?: string;
    @minLength(1) @maxLength(128) environment?: string;
    logging?: {
      enabled?: boolean;
      @minLength(1) @maxLength(16) level?: string;
      console?: boolean;
      auto_send?: boolean;
    };
    tracing?: {
      enabled?: boolean;
      @minValue(0) @maxValue(1) sample_ratio?: float64;
      propagators?: string[];
    };
    metrics?: {
      enabled?: boolean;
    };
    exporter?: {
      @minLength(1) @maxLength(32) protocol?: string;
      @minLength(1) @maxLength(128) endpoint_env?: string;
    };
  };
}
