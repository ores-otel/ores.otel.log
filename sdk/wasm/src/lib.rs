//! Dependency-free WASM logger for the language-neutral `next-loggers/v1` contract.
//!
//! WebAssembly hosts differ in their task/thread models, so context is passed
//! explicitly by the host instead of being hidden in a global or thread-local.
//! OTEL and Supabase are ordinary injected sinks; no runtime is patched.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const SCHEMA: &str = "next-loggers/v1";

#[no_mangle]
pub extern "C" fn next_loggers_schema_version() -> u32 {
    1
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
            Self::Fatal => "FATAL",
        }
    }

    pub fn otel_severity_number(self) -> u8 {
        match self {
            Self::Trace => 1,
            Self::Debug => 5,
            Self::Info => 9,
            Self::Warn => 13,
            Self::Error => 17,
            Self::Fatal => 21,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LogContext {
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub trace_flags: u8,
    pub trace_state: Option<String>,
    pub fields: BTreeMap<String, String>,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogRecord {
    pub schema: String,
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub runtime: String,
    pub app_name: String,
    pub name: Option<String>,
    pub message: String,
    pub values: Vec<String>,
    pub fields: BTreeMap<String, String>,
    pub trace_id: Option<String>,
    pub trace_ids: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OtelLogRecord {
    pub body: String,
    pub severity_text: String,
    pub severity_number: u8,
    pub timestamp: String,
    pub attributes: BTreeMap<String, String>,
}

pub trait Transport: Send + Sync {
    fn write(&self, record: &LogRecord) -> Result<(), String>;
}

pub struct OpenTelemetryTransport<F>
where
    F: Fn(OtelLogRecord) -> Result<(), String> + Send + Sync,
{
    sink: F,
}

impl<F> OpenTelemetryTransport<F>
where
    F: Fn(OtelLogRecord) -> Result<(), String> + Send + Sync,
{
    pub fn new(sink: F) -> Self {
        Self { sink }
    }
}

impl<F> Transport for OpenTelemetryTransport<F>
where
    F: Fn(OtelLogRecord) -> Result<(), String> + Send + Sync,
{
    fn write(&self, record: &LogRecord) -> Result<(), String> {
        let mut attributes = BTreeMap::from([
            ("service.name".to_string(), record.app_name.clone()),
            ("next_logger.schema".to_string(), record.schema.clone()),
            ("next_logger.runtime".to_string(), record.runtime.clone()),
            ("log.record.uid".to_string(), record.id.clone()),
        ]);
        if let Some(trace_id) = &record.trace_id {
            attributes.insert("trace.id".to_string(), trace_id.clone());
        }
        for (key, value) in &record.fields {
            attributes.insert(format!("next_logger.field.{key}"), value.clone());
        }
        (self.sink)(OtelLogRecord {
            body: record.message.clone(),
            severity_text: record.level.as_str().to_string(),
            severity_number: record.level.otel_severity_number(),
            timestamp: record.timestamp.clone(),
            attributes,
        })
    }
}

pub struct SupabaseTransport<F>
where
    F: Fn(LogRecord) -> Result<(), String> + Send + Sync,
{
    sender: F,
}

impl<F> SupabaseTransport<F>
where
    F: Fn(LogRecord) -> Result<(), String> + Send + Sync,
{
    pub fn new(sender: F) -> Self {
        Self { sender }
    }
}

impl<F> Transport for SupabaseTransport<F>
where
    F: Fn(LogRecord) -> Result<(), String> + Send + Sync,
{
    fn write(&self, record: &LogRecord) -> Result<(), String> {
        (self.sender)(record.clone())
    }
}

pub struct Logger {
    app_name: String,
    name: Option<String>,
    runtime: String,
    fields: BTreeMap<String, String>,
    transports: Vec<Arc<dyn Transport>>,
    id_factory: Arc<dyn Fn() -> String + Send + Sync>,
    clock: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Logger {
    pub fn new(app_name: impl Into<String>) -> Result<Self, String> {
        let app_name = app_name.into();
        if app_name.trim().is_empty() {
            return Err("app_name must not be empty".to_string());
        }
        Ok(Self {
            app_name,
            name: None,
            runtime: "wasm".to_string(),
            fields: BTreeMap::new(),
            transports: Vec::new(),
            id_factory: Arc::new(default_id),
            // WASM hosts should inject an RFC3339 clock. This deterministic
            // fallback is safe on targets without wall-clock capabilities.
            clock: Arc::new(|| "1970-01-01T00:00:00.000Z".to_string()),
        })
    }

    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_field(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.fields.insert(key.into(), value.into());
        self
    }

    pub fn with_transport<T: Transport + 'static>(mut self, transport: Arc<T>) -> Self {
        self.transports.push(transport);
        self
    }

    pub fn with_id_factory<F>(mut self, factory: F) -> Self
    where
        F: Fn() -> String + Send + Sync + 'static,
    {
        self.id_factory = Arc::new(factory);
        self
    }

    pub fn with_clock<F>(mut self, clock: F) -> Self
    where
        F: Fn() -> String + Send + Sync + 'static,
    {
        self.clock = Arc::new(clock);
        self
    }

    pub fn log(
        &self,
        level: LogLevel,
        message: impl Into<String>,
        context: Option<&LogContext>,
        event_fields: BTreeMap<String, String>,
    ) -> Result<LogRecord, String> {
        let message = message.into();
        let mut fields = self.fields.clone();
        let mut trace_id = None;
        let mut tags = Vec::new();
        if let Some(context) = context {
            fields.extend(context.fields.clone());
            if let Some(span_id) = &context.span_id {
                fields.insert("otel.span_id".to_string(), span_id.clone());
            }
            fields.insert(
                "otel.trace_flags".to_string(),
                context.trace_flags.to_string(),
            );
            if let Some(trace_state) = &context.trace_state {
                fields.insert("otel.trace_state".to_string(), trace_state.clone());
            }
            trace_id = context.trace_id.clone();
            tags = unique(context.tags.clone());
        }
        fields.extend(event_fields);
        let trace_ids = trace_id.clone().into_iter().collect();
        let record = LogRecord {
            schema: SCHEMA.to_string(),
            id: (self.id_factory)(),
            timestamp: (self.clock)(),
            level,
            runtime: self.runtime.clone(),
            app_name: self.app_name.clone(),
            name: self.name.clone(),
            message: message.clone(),
            values: vec![message],
            fields,
            trace_id,
            trace_ids,
            tags,
        };
        for transport in &self.transports {
            transport.write(&record)?;
        }
        Ok(record)
    }

    pub fn info(
        &self,
        message: impl Into<String>,
        context: Option<&LogContext>,
    ) -> Result<LogRecord, String> {
        self.log(LogLevel::Info, message, context, BTreeMap::new())
    }

    pub fn error(
        &self,
        message: impl Into<String>,
        context: Option<&LogContext>,
    ) -> Result<LogRecord, String> {
        self.log(LogLevel::Error, message, context, BTreeMap::new())
    }
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

fn default_id() -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    format!("wasm-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}
