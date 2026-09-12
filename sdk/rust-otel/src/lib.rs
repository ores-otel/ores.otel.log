//! Explicit OpenTelemetry and context adapters for `next_loggers`.
//!
//! No runtime is instrumented or patched. `ContextScope` is synchronous and
//! thread-local. Async executors should carry `TraceContext` explicitly and use
//! the `LoggerContextExt` methods because futures may migrate between threads.

use next_loggers::{json, Event, JsonObject, Logger, LoggerError, Value};
use std::cell::RefCell;
use std::fmt::Display;
use std::marker::PhantomData;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::thread::ThreadId;
use std::time::Instant;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub trace_flags: u8,
    pub trace_state: String,
    pub baggage: Vec<(String, String)>,
    pub fields: JsonObject,
    pub tags: Vec<String>,
}

thread_local! {
    static CONTEXT: RefCell<Vec<TraceContext>> = const { RefCell::new(Vec::new()) };
}

/// A synchronous scope that cannot be moved or shared across threads.
pub struct ContextScope {
    owner: ThreadId,
    closed: bool,
    not_send_or_sync: PhantomData<Rc<()>>,
}

impl ContextScope {
    pub fn enter(context: TraceContext) -> Self {
        CONTEXT.with(|stack| stack.borrow_mut().push(context));
        Self {
            owner: std::thread::current().id(),
            closed: false,
            not_send_or_sync: PhantomData,
        }
    }

    pub fn close(mut self) {
        self.pop();
    }

    fn pop(&mut self) {
        if self.closed {
            return;
        }
        assert_eq!(
            self.owner,
            std::thread::current().id(),
            "next-loggers context scope closed on a different thread"
        );
        CONTEXT.with(|stack| {
            assert!(
                stack.borrow_mut().pop().is_some(),
                "next-loggers context scope stack underflow"
            );
        });
        self.closed = true;
    }
}

impl Drop for ContextScope {
    fn drop(&mut self) {
        self.pop();
    }
}

pub fn current_context() -> Option<TraceContext> {
    CONTEXT.with(|stack| stack.borrow().last().cloned())
}

pub fn with_context<T>(context: TraceContext, callback: impl FnOnce() -> T) -> T {
    let _scope = ContextScope::enter(context);
    callback()
}

/// The event fields contributed by a trace context: its own fields, then the
/// OTEL span attributes that are present, assembled as one new map (later
/// entries win on a key collision, as successive inserts did).
fn context_fields(context: &TraceContext) -> JsonObject {
    let span_fields = [
        (!context.span_id.is_empty()).then(|| {
            (
                "otel.span_id".to_string(),
                Value::String(context.span_id.clone()),
            )
        }),
        Some(("otel.trace_flags".to_string(), json!(context.trace_flags))),
        (!context.trace_state.is_empty()).then(|| {
            (
                "otel.trace_state".to_string(),
                Value::String(context.trace_state.clone()),
            )
        }),
        (!context.baggage.is_empty()).then(|| {
            let baggage: JsonObject = context
                .baggage
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect();
            ("otel.baggage".to_string(), Value::Object(baggage))
        }),
    ];
    context
        .fields
        .clone()
        .into_iter()
        .chain(span_fields.into_iter().flatten())
        .collect()
}

pub fn apply_context(event: Event, context: &TraceContext) -> Event {
    let event = event.add_fields(context_fields(context));
    let event = if context.trace_id.is_empty() {
        event
    } else {
        event.add_trace(context.trace_id.clone(), true)
    };
    event.add_tags(
        std::iter::once("otel".to_string())
            .chain(context.tags.iter().cloned())
            .collect::<Vec<_>>(),
    )
}

pub trait LoggerContextExt {
    fn trace_context(&self, context: &TraceContext, values: Vec<Value>) -> Event;
    fn debug_context(&self, context: &TraceContext, values: Vec<Value>) -> Event;
    fn info_context(&self, context: &TraceContext, values: Vec<Value>) -> Event;
    fn warn_context(&self, context: &TraceContext, values: Vec<Value>) -> Event;
    fn error_context(&self, context: &TraceContext, values: Vec<Value>) -> Event;
    fn fatal_context(&self, context: &TraceContext, values: Vec<Value>) -> Event;
}

impl LoggerContextExt for Logger {
    fn trace_context(&self, context: &TraceContext, values: Vec<Value>) -> Event {
        apply_context(self.trace(values), context)
    }
    fn debug_context(&self, context: &TraceContext, values: Vec<Value>) -> Event {
        apply_context(self.debug(values), context)
    }
    fn info_context(&self, context: &TraceContext, values: Vec<Value>) -> Event {
        apply_context(self.info(values), context)
    }
    fn warn_context(&self, context: &TraceContext, values: Vec<Value>) -> Event {
        apply_context(self.warn(values), context)
    }
    fn error_context(&self, context: &TraceContext, values: Vec<Value>) -> Event {
        apply_context(self.error(values), context)
    }
    fn fatal_context(&self, context: &TraceContext, values: Vec<Value>) -> Event {
        apply_context(self.fatal(values), context)
    }
}

/// Structural span contract. Applications adapt their installed OTel SDK.
pub trait Span {
    fn context(&self) -> TraceContext;
    fn is_recording(&self) -> bool {
        true
    }
    fn record_error(&mut self, error: &str);
    fn set_status(&mut self, code: u8, description: &str);
    fn end(&mut self);
}

/// Structural tracer contract. This crate never installs a provider.
pub trait Tracer {
    fn start(&self, name: &str, attributes: &JsonObject) -> Result<Box<dyn Span>, LoggerError>;
}

#[derive(Default)]
struct NoopSpan;
impl Span for NoopSpan {
    fn context(&self) -> TraceContext {
        TraceContext::default()
    }
    fn is_recording(&self) -> bool {
        false
    }
    fn record_error(&mut self, _error: &str) {}
    fn set_status(&mut self, _code: u8, _description: &str) {}
    fn end(&mut self) {}
}

/// Starts an explicit span and mirrors its lifecycle through next-loggers.
/// OTel start/context/status/end failures fail open. Callback errors and panics
/// are preserved exactly after best-effort exception/status/end reporting.
pub fn with_span<T>(
    logger: &Logger,
    tracer: &dyn Tracer,
    name: &str,
    attributes: JsonObject,
    callback: impl FnOnce(&mut dyn Span) -> Result<T, LoggerError>,
) -> Result<T, LoggerError> {
    let mut span: Box<dyn Span> =
        match catch_unwind(AssertUnwindSafe(|| tracer.start(name, &attributes))) {
            Ok(Ok(span)) => span,
            Ok(Err(error)) => {
                report_bridge_failure(logger, &TraceContext::default(), name, "start span", &error);
                Box::<NoopSpan>::default()
            }
            Err(payload) => {
                report_bridge_failure(
                    logger,
                    &TraceContext::default(),
                    name,
                    "start span",
                    &panic_text(payload.as_ref()),
                );
                Box::<NoopSpan>::default()
            }
        };

    let context = match catch_unwind(AssertUnwindSafe(|| span.context())) {
        Ok(context) => context,
        Err(payload) => {
            report_bridge_failure(
                logger,
                &TraceContext::default(),
                name,
                "read span context",
                &panic_text(payload.as_ref()),
            );
            TraceContext::default()
        }
    };
    let started = Instant::now();
    let _scope = ContextScope::enter(context.clone());
    send_safely(
        LoggerContextExt::debug_context(
            logger,
            &context,
            vec![json!("span started:"), json!(name)],
        )
        .add_fields(span_fields(name, "start", None))
        .add_tags(["otel-span"]),
    );
    let recording = span_recording_safely(logger, &context, name, span.as_ref());

    let callback_result = catch_unwind(AssertUnwindSafe(|| callback(span.as_mut())));
    match callback_result {
        Ok(result) => {
            match &result {
                Ok(_) => {
                    if recording {
                        invoke_span_safely(
                            logger,
                            &context,
                            name,
                            "set success status",
                            span.as_mut(),
                            |span| span.set_status(1, ""),
                        );
                    }
                    send_safely(
                        LoggerContextExt::debug_context(
                            logger,
                            &context,
                            vec![json!("span completed:"), json!(name)],
                        )
                        .add_fields(span_fields(
                            name,
                            "end",
                            Some(started.elapsed().as_secs_f64() * 1000.0),
                        ))
                        .add_tags(["otel-span"]),
                    );
                }
                Err(error) => {
                    let description = error.to_string();
                    if recording {
                        invoke_span_safely(
                            logger,
                            &context,
                            name,
                            "record exception",
                            span.as_mut(),
                            |span| span.record_error(&description),
                        );
                        invoke_span_safely(
                            logger,
                            &context,
                            name,
                            "set error status",
                            span.as_mut(),
                            |span| span.set_status(2, &description),
                        );
                    }
                    send_safely(
                        LoggerContextExt::error_context(
                            logger,
                            &context,
                            vec![json!("span failed:"), json!(name), json!(description)],
                        )
                        .add_fields(span_fields(
                            name,
                            "error",
                            Some(started.elapsed().as_secs_f64() * 1000.0),
                        ))
                        .add_tags(["otel-span"]),
                    );
                }
            }
            invoke_span_safely(logger, &context, name, "end span", span.as_mut(), |span| {
                span.end()
            });
            result
        }
        Err(payload) => {
            let description = panic_text(payload.as_ref());
            if recording {
                invoke_span_safely(
                    logger,
                    &context,
                    name,
                    "record panic",
                    span.as_mut(),
                    |span| span.record_error(&description),
                );
                invoke_span_safely(
                    logger,
                    &context,
                    name,
                    "set panic status",
                    span.as_mut(),
                    |span| span.set_status(2, &description),
                );
            }
            send_safely(
                LoggerContextExt::error_context(
                    logger,
                    &context,
                    vec![json!("span panicked:"), json!(name), json!(description)],
                )
                .add_fields(span_fields(
                    name,
                    "panic",
                    Some(started.elapsed().as_secs_f64() * 1000.0),
                ))
                .add_tags(["otel-span"]),
            );
            invoke_span_safely(logger, &context, name, "end span", span.as_mut(), |span| {
                span.end()
            });
            resume_unwind(payload)
        }
    }
}

fn span_recording_safely(
    logger: &Logger,
    context: &TraceContext,
    name: &str,
    span: &dyn Span,
) -> bool {
    match catch_unwind(AssertUnwindSafe(|| span.is_recording())) {
        Ok(recording) => recording,
        Err(payload) => {
            report_bridge_failure(
                logger,
                context,
                name,
                "read recording state",
                &panic_text(payload.as_ref()),
            );
            false
        }
    }
}

fn invoke_span_safely(
    logger: &Logger,
    context: &TraceContext,
    name: &str,
    operation: &str,
    span: &mut dyn Span,
    callback: impl FnOnce(&mut dyn Span),
) {
    if let Err(payload) = catch_unwind(AssertUnwindSafe(|| callback(span))) {
        report_bridge_failure(
            logger,
            context,
            name,
            operation,
            &panic_text(payload.as_ref()),
        );
    }
}

fn report_bridge_failure(
    logger: &Logger,
    context: &TraceContext,
    name: &str,
    operation: &str,
    error: &impl Display,
) {
    send_safely(
        LoggerContextExt::warn_context(
            logger,
            context,
            vec![
                json!("OpenTelemetry"),
                json!(operation),
                json!("failed:"),
                json!(error.to_string()),
            ],
        )
        .add_fields(JsonObject::from_iter([
            ("otel.bridge_operation".into(), json!(operation)),
            ("otel.span_name".into(), json!(name)),
        ]))
        .add_tags(["otel-span", "otel-bridge-error"]),
    );
}

fn span_fields(name: &str, phase: &str, duration_ms: Option<f64>) -> JsonObject {
    [
        ("otel.span_name".to_string(), json!(name)),
        ("otel.span_phase".to_string(), json!(phase)),
    ]
    .into_iter()
    .chain(duration_ms.map(|value| ("otel.duration_ms".to_string(), json!(value))))
    .collect()
}

fn send_safely(event: Event) {
    let _ = catch_unwind(AssertUnwindSafe(|| event.send()));
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(value) = payload.downcast_ref::<&str>() {
        (*value).to_string()
    } else if let Some(value) = payload.downcast_ref::<String>() {
        value.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

pub fn error_text(error: &impl Display) -> String {
    error.to_string()
}
