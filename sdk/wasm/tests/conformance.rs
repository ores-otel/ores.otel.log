use next_loggers_wasm::{
    with_span, LogContext, LogLevel, Logger, OpenTelemetrySpan, OpenTelemetryTracer,
    OpenTelemetryTransport, SupabaseTransport, Transport, SCHEMA,
};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[test]
fn explicit_host_context_flows_to_otel_and_supabase() {
    let otel = Arc::new(Mutex::new(Vec::new()));
    let supabase = Arc::new(Mutex::new(Vec::new()));
    let otel_sink = otel.clone();
    let supabase_sink = supabase.clone();

    let logger = Logger::new("payments")
        .unwrap()
        .named("audit")
        .with_field("environment", "test")
        .with_id_factory(|| "wasm-record-1".to_string())
        .with_clock(|| "2026-01-02T03:04:05.000Z".to_string())
        .with_transport(Arc::new(OpenTelemetryTransport::new(move |record| {
            otel_sink.lock().unwrap().push(record);
            Ok(())
        })))
        .with_transport(Arc::new(SupabaseTransport::new(move |record| {
            supabase_sink.lock().unwrap().push(record);
            Ok(())
        })));

    let context = LogContext {
        trace_id: Some("0123456789abcdef0123456789abcdef".to_string()),
        span_id: Some("0123456789abcdef".to_string()),
        trace_flags: 1,
        trace_state: Some("vendor=value".to_string()),
        fields: BTreeMap::from([("requestId".to_string(), "request-1".to_string())]),
        tags: vec!["otel".to_string(), "wasm".to_string(), "otel".to_string()],
    };

    let record = logger
        .log(
            LogLevel::Error,
            "payment failed",
            Some(&context),
            BTreeMap::from([("orderId".to_string(), "order-42".to_string())]),
        )
        .unwrap();

    assert_eq!(record.schema, SCHEMA);
    assert_eq!(record.level, LogLevel::Error);
    assert_eq!(
        record.trace_id.as_deref(),
        Some("0123456789abcdef0123456789abcdef")
    );
    assert_eq!(
        record.fields.get("otel.span_id").map(String::as_str),
        Some("0123456789abcdef")
    );
    assert_eq!(
        record.fields.get("requestId").map(String::as_str),
        Some("request-1")
    );
    assert_eq!(
        record.fields.get("orderId").map(String::as_str),
        Some("order-42")
    );
    assert_eq!(record.tags, vec!["otel", "wasm"]);

    let otel = otel.lock().unwrap();
    assert_eq!(otel.len(), 1);
    assert_eq!(otel[0].severity_number, 17);
    assert_eq!(
        otel[0].attributes.get("trace.id").map(String::as_str),
        Some("0123456789abcdef0123456789abcdef")
    );
    assert_eq!(supabase.lock().unwrap().as_slice(), &[record]);
}

#[test]
fn per_call_otel_routing_preserves_ordinary_transport() {
    let ordinary = Arc::new(Mutex::new(Vec::new()));
    let otel = Arc::new(Mutex::new(Vec::new()));
    let ordinary_sink = ordinary.clone();
    let otel_sink = otel.clone();
    let logger = Logger::new("routing")
        .unwrap()
        .with_transport(Arc::new(SupabaseTransport::new(move |record| {
            ordinary_sink.lock().unwrap().push(record);
            Ok(())
        })))
        .with_transport(Arc::new(OpenTelemetryTransport::new(move |record| {
            otel_sink.lock().unwrap().push(record);
            Ok(())
        })));

    logger.info("default", None).unwrap();
    logger
        .event(LogLevel::Info, "ordinary-only", None, BTreeMap::new())
        .not_otel()
        .send()
        .unwrap();
    logger
        .event(LogLevel::Info, "forced-on", None, BTreeMap::new())
        .use_otel()
        .send()
        .unwrap();

    assert_eq!(ordinary.lock().unwrap().len(), 3);
    assert_eq!(otel.lock().unwrap().len(), 2);
}

#[test]
fn context_is_never_hidden_in_global_or_thread_local_state() {
    let logger = Logger::new("app").unwrap();
    let first = LogContext {
        trace_id: Some("trace-a".to_string()),
        ..LogContext::default()
    };
    let second = LogContext {
        trace_id: Some("trace-b".to_string()),
        ..LogContext::default()
    };
    assert_eq!(
        logger.info("a", Some(&first)).unwrap().trace_id.as_deref(),
        Some("trace-a")
    );
    assert_eq!(
        logger.info("b", Some(&second)).unwrap().trace_id.as_deref(),
        Some("trace-b")
    );
    assert_eq!(logger.info("none", None).unwrap().trace_id, None);
}

#[test]
fn transport_errors_are_visible_to_the_host() {
    struct Broken;
    impl Transport for Broken {
        fn write(&self, _record: &next_loggers_wasm::LogRecord) -> Result<(), String> {
            Err("offline".to_string())
        }
    }

    let logger = Logger::new("app").unwrap().with_transport(Arc::new(Broken));
    assert_eq!(logger.error("boom", None).unwrap_err(), "offline");
}

#[derive(Debug)]
struct AppError;

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("application failed")
    }
}

struct TestSpan {
    recording: bool,
    statuses: Arc<AtomicUsize>,
    exceptions: Arc<AtomicUsize>,
    ended: Arc<AtomicUsize>,
}

impl OpenTelemetrySpan for TestSpan {
    fn context(&self) -> Result<LogContext, String> {
        Ok(LogContext {
            trace_id: Some("fedcba9876543210fedcba9876543210".to_string()),
            span_id: Some("fedcba9876543210".to_string()),
            trace_flags: 0,
            ..LogContext::default()
        })
    }

    fn is_recording(&self) -> Result<bool, String> {
        Ok(self.recording)
    }

    fn record_exception(&self, _error: &str) -> Result<(), String> {
        self.exceptions.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn set_status(&self, _code: u8, _description: &str) -> Result<(), String> {
        self.statuses.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn end(&self) -> Result<(), String> {
        self.ended.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct TestTracer {
    recording: bool,
    statuses: Arc<AtomicUsize>,
    exceptions: Arc<AtomicUsize>,
    ended: Arc<AtomicUsize>,
}

impl OpenTelemetryTracer for TestTracer {
    fn start_span(
        &self,
        _name: &str,
        _attributes: &BTreeMap<String, String>,
    ) -> Result<Box<dyn OpenTelemetrySpan>, String> {
        Ok(Box::new(TestSpan {
            recording: self.recording,
            statuses: self.statuses.clone(),
            exceptions: self.exceptions.clone(),
            ended: self.ended.clone(),
        }))
    }
}

#[test]
fn sampled_out_host_span_correlates_without_recording_mutations() {
    let ordinary = Arc::new(Mutex::new(Vec::new()));
    let ordinary_sink = ordinary.clone();
    let logger =
        Logger::new("wasm-span")
            .unwrap()
            .with_transport(Arc::new(SupabaseTransport::new(move |record| {
                ordinary_sink.lock().unwrap().push(record);
                Ok(())
            })));
    let statuses = Arc::new(AtomicUsize::new(0));
    let exceptions = Arc::new(AtomicUsize::new(0));
    let ended = Arc::new(AtomicUsize::new(0));
    let tracer = TestTracer {
        recording: false,
        statuses: statuses.clone(),
        exceptions: exceptions.clone(),
        ended: ended.clone(),
    };

    let trace = with_span(
        &logger,
        &tracer,
        "sampled-out",
        BTreeMap::new(),
        |_span, context| -> Result<String, AppError> {
            Ok(logger
                .info("inside sampled-out", Some(context))
                .unwrap()
                .trace_id
                .unwrap())
        },
    )
    .unwrap();

    assert_eq!(trace, "fedcba9876543210fedcba9876543210");
    assert_eq!(statuses.load(Ordering::SeqCst), 0);
    assert_eq!(exceptions.load(Ordering::SeqCst), 0);
    assert_eq!(ended.load(Ordering::SeqCst), 1);
    assert!(ordinary
        .lock()
        .unwrap()
        .iter()
        .any(|record| record.message == "inside sampled-out"));
}
