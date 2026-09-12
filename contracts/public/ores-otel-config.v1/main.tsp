import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace OresOtel;

model OresOtelProcessMetricsV1 {
  enabled?: boolean;
  @minValue(100) @maxValue(3600000)
  sample_interval_ms?: integer;
  rss_bytes?: boolean;
  virtual_memory_bytes?: boolean;
  heap_bytes?: boolean;
  cpu_seconds?: boolean;
  thread_count?: boolean;
  open_file_descriptors?: boolean;
}

model OresOtelFilesystemMetricsV1 {
  enabled?: boolean;
  @minItems(1) @maxItems(32)
  paths?: string[];
  capacity_bytes?: boolean;
  free_bytes?: boolean;
  free_ratio?: boolean;
  inode_free_ratio?: boolean;
  @minValue(0)
  min_free_bytes?: integer;
  @minValue(0) @maxValue(1)
  min_free_ratio?: float64;
  @minValue(0) @maxValue(1)
  min_inode_free_ratio?: float64;
}

model OresOtelLatencyMetricsV1 {
  enabled?: boolean;
  request_duration_ms?: boolean;
  operation_duration_ms?: boolean;
  queue_wait_ms?: boolean;
  event_loop_lag_ms?: boolean;
  @minItems(1) @maxItems(32)
  histogram_boundaries_ms?: float64[];
}

model OresOtelRuntimeMetricsV1 {
  enabled?: boolean;
  gc_pause_ms?: boolean;
  gc_heap_bytes?: boolean;
  event_loop_utilization?: boolean;
  scheduler_queue_depth?: boolean;
}

model OresOtelSaturationMetricsV1 {
  enabled?: boolean;
  @minValue(0) @maxValue(1)
  cpu_ratio_warning?: float64;
  @minValue(0) @maxValue(1)
  memory_ratio_warning?: float64;
  @minValue(0) @maxValue(1)
  disk_free_ratio_warning?: float64;
  @minValue(0)
  queue_depth_warning?: integer;
}

model OresOtelMetricsV1 {
  enabled?: boolean;
  process?: OresOtelProcessMetricsV1;
  filesystem?: OresOtelFilesystemMetricsV1;
  latency?: OresOtelLatencyMetricsV1;
  runtime?: OresOtelRuntimeMetricsV1;
  saturation?: OresOtelSaturationMetricsV1;
  exemplars?: boolean;
  span_metrics?: boolean;
  service_graphs?: boolean;
}

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
    metrics?: OresOtelMetricsV1;
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
    metrics?: OresOtelMetricsV1;
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
    metrics?: OresOtelMetricsV1;
    exporter?: {
      @minLength(1) @maxLength(32) protocol?: string;
      @minLength(1) @maxLength(128) endpoint_env?: string;
    };
  };
}
