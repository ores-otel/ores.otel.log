//! Polyglot structured logging and explicit OpenTelemetry context adapters.

#[path = "core.rs"]
mod logger_core;

pub use logger_core::*;

pub mod apm;
pub mod config;
pub mod context;
#[cfg(all(unix, feature = "launcher"))]
pub mod launcher;
pub mod shutdown;
pub mod span;

pub use apm::{
    emit_latency_histogram, emit_resource_metrics, evaluate_resource_snapshot, measure,
    resource_metric_points, sample_filesystem, sample_process, sample_resources, ApmError,
    FilesystemSnapshot, HistogramPoint, LatencyHistogram, LatencyHistogramConfig,
    LatencyHistogramSnapshot, LatencyKind, MetricKind, MetricPoint, MetricSink, ProcessSnapshot,
    ResourceHealth, ResourcePressure, ResourcePressureKind, ResourceSnapshot, ResourceThresholds,
    Timed,
};
pub use config::{
    load_ores_otel_config, parse_ores_otel_toml, resolve_exporter_endpoint,
    resolve_ores_otel_config, LoadOptions, LoadedOresOtelConfig, OresOtelConfigError,
    OresOtelFileConfig, OresOtelFileLayer, OresOtelRole, ResolveOptions, ResolvedMetrics,
    ResolvedOresOtelConfig, RuntimeRole, ORES_OTEL_CONFIG_BASENAME,
};
pub use context::{
    apply_log_context, capture_log_context, contextualize_future, current_log_context,
    enter_log_context, merge_log_context, update_log_context, with_captured_log_context,
    with_log_context, with_log_context_async, ContextFuture, LogContext, LogContextGuard,
};
pub use shutdown::{
    transition_shutdown_state, ShutdownAction, ShutdownEvent, ShutdownPhase, ShutdownStateMachine,
    ShutdownTransition,
};
pub use span::{with_span, with_span_async, Span, Tracer, OTEL_STATUS_ERROR, OTEL_STATUS_OK};
