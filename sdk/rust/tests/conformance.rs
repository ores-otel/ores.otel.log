use next_loggers::{
    Event, JsonObject, LogLevel, Logger, MemoryTransport, OpenTelemetryLogRecord,
    OpenTelemetryTransport, Options, SupabaseTransport, Transport,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn object(value: Value) -> JsonObject {
    value.as_object().expect("expected JSON object").clone()
}

#[test]
fn matches_shared_record_fixture() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../contracts/fixtures/conformance-record.json"
    ))
    .expect("valid shared fixture");

    let transport = Arc::new(MemoryTransport::default());
    let mut options = Options::default();
    options.app_name = "payments".into();
    options.name = Some("audit".into());
    options.runtime = "contract-test".into();
    options.fields = object(json!({"environment": "test"}));
    options.console = false;
    options.transports = vec![transport.clone() as Arc<dyn Transport>];
    options.id_factory = Arc::new(|| "contract-record-1".into());
    options.clock = Arc::new(|| "2026-01-02T03:04:05.000Z".into());
    let logger = Logger::new(options);

    let event = logger
        .error(vec![json!("payment failed"), json!(42)])
        .add_fields(object(json!({"orderId": "order-42"})))
        .add_logged_in_user_id("user-1")
        .add_user_info(object(json!({"id": "user-2"})))
        .add_trace("trace-1", false)
        .add_trace("trace-2", false)
        .add_routine_id("charge-card")
        .add_tags(["payments", "critical", "payments"])
        .add_context(json!({"attempt": 2}))
        .add_meta(json!({"source": "fixture"}));

    let first = event.send().expect("first send").expect("record");
    let second = event.send().expect("second send").expect("cached record");
    assert_eq!(first, second);
    assert_eq!(transport.records().len(), 1);
    assert_eq!(
        serde_json::to_value(&transport.records()[0]).unwrap(),
        expected
    );
    logger.close().expect("close logger");
}

#[test]
fn shutdown_recovers_unsent_events() {
    let transport = Arc::new(MemoryTransport::default());
    let logger = Logger::new(Options::default().with_transport(transport.clone()));
    logger.warn(vec![json!("created but not explicitly sent")]);
    logger.close().expect("close logger");

    assert_eq!(transport.records().len(), 1);
    assert_eq!(
        transport.records()[0].message,
        "created but not explicitly sent"
    );
    assert_eq!(transport.exit_records().len(), 1);
    assert!(transport.is_closed());
}

trait AuditEventExt {
    fn with_actor(self, actor: &str) -> Self;
}

impl AuditEventExt for Event {
    fn with_actor(self, actor: &str) -> Self {
        self.add_fields(object(json!({"actor": actor})))
    }
}

#[test]
fn levels_send_false_and_extension_traits_work() {
    let transport = Arc::new(MemoryTransport::default());
    let mut options = Options::default().with_transport(transport.clone());
    options.max_level = LogLevel::Warn;
    options.console = false;
    let logger = Logger::new(options);

    logger.info(vec![json!("filtered")]).send().unwrap();
    logger
        .error(vec![json!("local")])
        .with_actor("user-9")
        .send_with_store(false)
        .unwrap();
    logger
        .fatal(vec![json!("stored")])
        .with_actor("user-9")
        .send()
        .unwrap();

    assert_eq!(transport.records().len(), 1);
    assert_eq!(transport.records()[0].level, LogLevel::Fatal);
    assert_eq!(transport.records()[0].fields["actor"], json!("user-9"));
}

#[test]
fn explicit_opentelemetry_and_supabase_transports_work() {
    let otel = Arc::new(Mutex::new(Vec::<OpenTelemetryLogRecord>::new()));
    let supabase = Arc::new(Mutex::new(Vec::new()));
    let otel_sink = otel.clone();
    let supabase_sink = supabase.clone();

    let mut options = Options::default();
    options.app_name = "checkout".into();
    options.runtime = "rust".into();
    options.console = false;
    options.id_factory = Arc::new(|| "otel-record-1".into());
    options.clock = Arc::new(|| "2026-01-02T03:04:05.000Z".into());
    options.transports = vec![
        Arc::new(OpenTelemetryTransport::new(move |record| {
            otel_sink.lock().unwrap().push(record);
            Ok(())
        })) as Arc<dyn Transport>,
        Arc::new(SupabaseTransport::new(move |record| {
            supabase_sink.lock().unwrap().push(record);
            Ok(())
        })) as Arc<dyn Transport>,
    ];
    let logger = Logger::new(options);

    logger
        .error(vec![json!("payment failed")])
        .add_trace("0123456789abcdef0123456789abcdef", false)
        .add_fields(object(json!({
            "otel.span_id": "0123456789abcdef",
            "region": "us-east-1"
        })))
        .send()
        .expect("send through OTEL and Supabase");

    let otel = otel.lock().unwrap();
    assert_eq!(otel.len(), 1);
    assert_eq!(otel[0].severity_text, "ERROR");
    assert_eq!(otel[0].severity_number, 17);
    assert_eq!(
        otel[0].attributes["trace.id"],
        json!("0123456789abcdef0123456789abcdef")
    );
    assert_eq!(otel[0].attributes["service.name"], json!("checkout"));
    drop(otel);

    let supabase = supabase.lock().unwrap();
    assert_eq!(supabase.len(), 1);
    assert_eq!(supabase[0].schema, "next-loggers/v1");
    assert_eq!(supabase[0].message, "payment failed");
}
