use next_loggers_wasm::{
    LogContext, LogLevel, Logger, OpenTelemetryTransport, SupabaseTransport, Transport, SCHEMA,
};
use std::collections::BTreeMap;
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
