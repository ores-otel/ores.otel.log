import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace OresOtel;

@id("RuntimeBoundary")
model RuntimeBoundary {
  language: string;
  runtime: string;
  contractVersion: string;
  contextPropagation: string;
  supportsShutdown: boolean;
  supportsOpenTelemetry: boolean;
}
