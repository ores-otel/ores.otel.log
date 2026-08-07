use next_loggers::{json, JsonObject, Logger, LoggerError, MemoryTransport, Options};
use oresoftware_next_loggers_otel::{
    current_context, with_context, with_span, LoggerContextExt, Span, TraceContext, Tracer,
};
use std::sync::{Arc, Mutex};

#[test]
fn thread_local_context_is_scoped_and_explicit_context_reaches_records() {
    let transport = Arc::new(MemoryTransport::default());
    let logger = Logger::new(Options {
        console: false,
        transports: vec![transport.clone()],
        ..Options::default()
    });
    let context = TraceContext {
        trace_id: "trace-1".into(),
        span_id: "span-1".into(),
        trace_flags: 1,
        ..TraceContext::default()
    };
    with_context(context.clone(), || {
        assert_eq!(current_context(), Some(context.clone()));
        logger
            .info_context(&context, vec![json!("inside")])
            .send()
            .unwrap();
    });
    assert_eq!(current_context(), None);
    let mut records = transport.records();
    let record = records.remove(0);
    assert_eq!(record.trace_id.as_deref(), Some("trace-1"));
    assert_eq!(record.fields.get("otel.span_id"), Some(&json!("span-1")));
}

#[derive(Default)]
struct State {
    status: u8,
    ended: usize,
    recorded: String,
    fail_lifecycle: bool,
}

struct FakeSpan(Arc<Mutex<State>>);
impl Span for FakeSpan {
    fn context(&self) -> TraceContext {
        TraceContext {
            trace_id: "trace-span".into(),
            span_id: "span-span".into(),
            trace_flags: 1,
            ..TraceContext::default()
        }
    }
    fn record_error(&mut self, error: &str) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.fail_lifecycle, "record unavailable");
        state.recorded = error.into();
    }
    fn set_status(&mut self, code: u8, _description: &str) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.fail_lifecycle, "status unavailable");
        state.status = code;
    }
    fn end(&mut self) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.fail_lifecycle, "end unavailable");
        state.ended += 1;
    }
}
struct FakeTracer(Arc<Mutex<State>>);
impl Tracer for FakeTracer {
    fn start(&self, _name: &str, _attributes: &JsonObject) -> Result<Box<dyn Span>, LoggerError> {
        Ok(Box::new(FakeSpan(self.0.clone())))
    }
}

#[test]
fn explicit_span_is_wrapped() {
    let state = Arc::new(Mutex::new(State::default()));
    let logger = Logger::new(Options {
        console: false,
        max_level: next_loggers::LogLevel::Debug,
        ..Options::default()
    });
    let value = with_span(
        &logger,
        &FakeTracer(state.clone()),
        "operation",
        JsonObject::new(),
        |_| Ok(7),
    )
    .unwrap();
    assert_eq!(value, 7);
    let state = state.lock().unwrap();
    assert_eq!(state.status, 1);
    assert_eq!(state.ended, 1);
}

#[test]
fn lifecycle_panics_do_not_replace_application_result() {
    let state = Arc::new(Mutex::new(State {
        fail_lifecycle: true,
        ..State::default()
    }));
    let transport = Arc::new(MemoryTransport::default());
    let logger = Logger::new(Options {
        console: false,
        max_level: next_loggers::LogLevel::Debug,
        transports: vec![transport.clone()],
        ..Options::default()
    });
    let value = with_span(
        &logger,
        &FakeTracer(state),
        "resilient",
        JsonObject::new(),
        |_| Ok(11),
    )
    .unwrap();
    assert_eq!(value, 11);
    assert!(transport
        .records()
        .iter()
        .any(|record| record.message.contains("set success status")));
    assert!(transport
        .records()
        .iter()
        .any(|record| record.message.contains("end span")));
}

struct FailingTracer;
impl Tracer for FailingTracer {
    fn start(&self, _name: &str, _attributes: &JsonObject) -> Result<Box<dyn Span>, LoggerError> {
        Err(LoggerError("sdk unavailable".into()))
    }
}

#[test]
fn start_failure_uses_noop_span_and_runs_callback() {
    let transport = Arc::new(MemoryTransport::default());
    let logger = Logger::new(Options {
        console: false,
        max_level: next_loggers::LogLevel::Debug,
        transports: vec![transport.clone()],
        ..Options::default()
    });
    let value = with_span(
        &logger,
        &FailingTracer,
        "fallback",
        JsonObject::new(),
        |_| Ok(12),
    )
    .unwrap();
    assert_eq!(value, 12);
    assert!(transport
        .records()
        .iter()
        .any(|record| record.message.contains("start span")));
}
