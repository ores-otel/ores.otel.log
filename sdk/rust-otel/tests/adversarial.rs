use next_loggers::{json, JsonObject, LogLevel, Logger, LoggerError, MemoryTransport, Options};
use oresoftware_next_loggers_otel::{
    apply_context, current_context, with_context, with_span, ContextScope, LoggerContextExt, Span,
    TraceContext, Tracer,
};
use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

fn logger_with_memory() -> (Logger, Arc<MemoryTransport>) {
    let memory = Arc::new(MemoryTransport::default());
    let logger = Logger::new(Options {
        app_name: "rust-adversarial".into(),
        console: false,
        max_level: LogLevel::Trace,
        transports: vec![memory.clone()],
        ..Options::default()
    });
    (logger, memory)
}

#[test]
fn nested_context_scopes_restore_the_parent() {
    assert_eq!(current_context(), None);
    let parent = TraceContext {
        trace_id: "parent".into(),
        ..TraceContext::default()
    };
    let child = TraceContext {
        trace_id: "child".into(),
        ..TraceContext::default()
    };
    with_context(parent.clone(), || {
        assert_eq!(current_context(), Some(parent.clone()));
        with_context(child.clone(), || {
            assert_eq!(current_context(), Some(child.clone()));
        });
        assert_eq!(current_context(), Some(parent.clone()));
    });
    assert_eq!(current_context(), None);
}

#[test]
fn context_scope_restores_after_a_panic() {
    let expected = "panic-value";
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _scope = ContextScope::enter(TraceContext {
            trace_id: "panic-trace".into(),
            ..TraceContext::default()
        });
        assert_eq!(current_context().unwrap().trace_id, "panic-trace");
        panic!("{expected}");
    }));
    assert!(result.is_err());
    assert_eq!(current_context(), None);
}

#[test]
fn thread_local_contexts_never_cross_contaminate() {
    const COUNT: usize = 32;
    let barrier = Arc::new(Barrier::new(COUNT));
    let results = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for index in 0..COUNT {
        let barrier = barrier.clone();
        let results = results.clone();
        handles.push(thread::spawn(move || {
            let trace = format!("trace-{index:02}");
            with_context(
                TraceContext {
                    trace_id: trace.clone(),
                    ..TraceContext::default()
                },
                || {
                    barrier.wait();
                    results
                        .lock()
                        .unwrap()
                        .push((trace, current_context().unwrap().trace_id));
                },
            );
            assert_eq!(current_context(), None);
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    let results = results.lock().unwrap();
    assert_eq!(results.len(), COUNT);
    assert!(results.iter().all(|(expected, actual)| expected == actual));
}

#[test]
fn apply_context_merges_every_correlation_field() {
    let (logger, memory) = logger_with_memory();
    let mut fields = JsonObject::new();
    fields.insert("route".into(), json!("/pay"));
    let context = TraceContext {
        trace_id: "trace-1".into(),
        span_id: "span-1".into(),
        trace_flags: 1,
        trace_state: "vendor=value".into(),
        baggage: vec![("tenant".into(), "acme".into())],
        fields,
        tags: vec!["request".into()],
    };
    apply_context(logger.info(vec![json!("inside")]), &context)
        .add_fields({
            let mut value = JsonObject::new();
            value.insert("event".into(), json!(true));
            value
        })
        .send()
        .unwrap();
    let record = memory.records().remove(0);
    assert_eq!(record.trace_id.as_deref(), Some("trace-1"));
    assert_eq!(record.fields.get("otel.span_id"), Some(&json!("span-1")));
    assert_eq!(record.fields.get("otel.trace_flags"), Some(&json!(1)));
    assert_eq!(record.fields.get("otel.trace_state"), Some(&json!("vendor=value")));
    assert_eq!(record.fields.get("route"), Some(&json!("/pay")));
    assert_eq!(record.fields.get("event"), Some(&json!(true)));
    assert!(record.tags.contains(&"otel".to_string()));
    assert!(record.tags.contains(&"request".to_string()));
}

#[derive(Default, Debug)]
struct SpanState {
    status: u8,
    description: String,
    recorded: Vec<String>,
    ended: usize,
    panic_context: bool,
    panic_record: bool,
    panic_status: bool,
    panic_end: bool,
}

struct SharedSpan(Arc<Mutex<SpanState>>);
impl Span for SharedSpan {
    fn context(&self) -> TraceContext {
        let state = self.0.lock().unwrap();
        assert!(!state.panic_context, "context unavailable");
        TraceContext {
            trace_id: "trace-span".into(),
            span_id: "span-span".into(),
            trace_flags: 1,
            ..TraceContext::default()
        }
    }
    fn record_error(&mut self, error: &str) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.panic_record, "record unavailable");
        state.recorded.push(error.into());
    }
    fn set_status(&mut self, code: u8, description: &str) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.panic_status, "status unavailable");
        state.status = code;
        state.description = description.into();
    }
    fn end(&mut self) {
        let mut state = self.0.lock().unwrap();
        assert!(!state.panic_end, "end unavailable");
        state.ended += 1;
    }
}

struct SharedTracer {
    state: Arc<Mutex<SpanState>>,
    panic_start: bool,
    error_start: bool,
}
impl Tracer for SharedTracer {
    fn start(&self, _name: &str, _attributes: &JsonObject) -> Result<Box<dyn Span>, LoggerError> {
        assert!(!self.panic_start, "tracer unavailable");
        if self.error_start {
            return Err(LoggerError("sdk unavailable".into()));
        }
        Ok(Box::new(SharedSpan(self.state.clone())))
    }
}

#[test]
fn callback_errors_preserve_identity_and_complete_the_span() {
    let (logger, _) = logger_with_memory();
    let state = Arc::new(Mutex::new(SpanState::default()));
    let expected = LoggerError("declined".into());
    let result = with_span(
        &logger,
        &SharedTracer {
            state: state.clone(),
            panic_start: false,
            error_start: false,
        },
        "failure",
        JsonObject::new(),
        |_| Err::<usize, _>(expected.clone()),
    );
    assert_eq!(result.unwrap_err(), expected);
    let state = state.lock().unwrap();
    assert_eq!(state.status, 2);
    assert_eq!(state.description, "declined");
    assert_eq!(state.recorded, vec!["declined"]);
    assert_eq!(state.ended, 1);
}

#[test]
fn callback_panics_are_recorded_ended_and_rethrown_unchanged() {
    let (logger, _) = logger_with_memory();
    let state = Arc::new(Mutex::new(SpanState::default()));
    let expected = Arc::new("panic-identity".to_string());
    let panic_value = expected.clone();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _ = with_span(
            &logger,
            &SharedTracer {
                state: state.clone(),
                panic_start: false,
                error_start: false,
            },
            "panic",
            JsonObject::new(),
            |_| -> Result<usize, LoggerError> { std::panic::panic_any(panic_value) },
        );
    }));
    let payload = result.unwrap_err();
    let actual = payload.downcast_ref::<Arc<String>>().unwrap();
    assert!(Arc::ptr_eq(actual, &expected));
    let state = state.lock().unwrap();
    assert_eq!(state.status, 2);
    assert_eq!(state.ended, 1);
    assert_eq!(state.recorded.len(), 1);
}

#[test]
fn tracer_error_and_panic_both_fall_back_to_a_noop_span() {
    let (logger, memory) = logger_with_memory();
    for (panic_start, error_start, expected) in [
        (false, true, 31usize),
        (true, false, 37usize),
    ] {
        let value = with_span(
            &logger,
            &SharedTracer {
                state: Arc::new(Mutex::new(SpanState::default())),
                panic_start,
                error_start,
            },
            "fallback",
            JsonObject::new(),
            |_| Ok(expected),
        )
        .unwrap();
        assert_eq!(value, expected);
    }
    assert!(memory
        .records()
        .iter()
        .filter(|record| record.message.contains("start span"))
        .count()
        >= 2);
}

#[test]
fn broken_span_context_fails_open_with_an_empty_context() {
    let (logger, memory) = logger_with_memory();
    let state = Arc::new(Mutex::new(SpanState {
        panic_context: true,
        ..SpanState::default()
    }));
    let value = with_span(
        &logger,
        &SharedTracer {
            state,
            panic_start: false,
            error_start: false,
        },
        "context",
        JsonObject::new(),
        |_| {
            assert_eq!(current_context().unwrap().trace_id, "");
            Ok(41)
        },
    )
    .unwrap();
    assert_eq!(value, 41);
    assert!(memory
        .records()
        .iter()
        .any(|record| record.message.contains("read span context")));
}

#[test]
fn status_record_and_end_panics_never_replace_success() {
    let (logger, memory) = logger_with_memory();
    let state = Arc::new(Mutex::new(SpanState {
        panic_record: true,
        panic_status: true,
        panic_end: true,
        ..SpanState::default()
    }));
    let value = with_span(
        &logger,
        &SharedTracer {
            state,
            panic_start: false,
            error_start: false,
        },
        "resilient",
        JsonObject::new(),
        |_| Ok(43),
    )
    .unwrap();
    assert_eq!(value, 43);
    let records = memory.records();
    assert!(records
        .iter()
        .any(|record| record.message.contains("set success status")));
    assert!(records
        .iter()
        .any(|record| record.message.contains("end span")));
}

#[test]
fn explicit_context_methods_cover_all_log_levels() {
    let (logger, memory) = logger_with_memory();
    let context = TraceContext {
        trace_id: "trace-levels".into(),
        ..TraceContext::default()
    };
    let events = [
        logger.trace_context(&context, vec![json!("trace")]),
        logger.debug_context(&context, vec![json!("debug")]),
        logger.info_context(&context, vec![json!("info")]),
        logger.warn_context(&context, vec![json!("warn")]),
        logger.error_context(&context, vec![json!("error")]),
        logger.fatal_context(&context, vec![json!("fatal")]),
    ];
    for event in events {
        event.send().unwrap();
    }
    let records = memory.records();
    assert_eq!(records.len(), 6);
    assert!(records
        .iter()
        .all(|record| record.trace_id.as_deref() == Some("trace-levels")));
}

fn _assert_panic_payload_is_send(payload: &(dyn Any + Send)) {
    let _ = payload;
}
