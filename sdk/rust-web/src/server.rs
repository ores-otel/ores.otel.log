//! Native Axum 0.8 adapter. Retains application-owned auth, middleware, and OTEL
//! providers. Emits next-loggers/v1 JSON and scopes the canonical poll-safe logger
//! carrier; this is correlation, not an OpenTelemetry span provider/exporter.
use crate::TraceParent;
use axum::{
    extract::{Request, State},
    http::HeaderValue,
    middleware::{from_fn_with_state, Next},
    response::Response,
    Router,
};
use next_loggers::{
    json, with_log_context_async, LogContext, LogRecord, Logger, LoggerError, Options, Transport,
};
use std::{io::Write, sync::Arc};
use uuid::Uuid;

struct JsonStdout;
impl Transport for JsonStdout {
    fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
        let mut line = record.to_json()?;
        line.push('\n');
        std::io::stdout()
            .lock()
            .write_all(line.as_bytes())
            .map_err(|_| LoggerError("telemetry stdout write failed".into()))
    }
}

/// The convenience sink is structured stdout for the existing log pipeline.
/// Use install_with_logger to retain a service's own transports and flush guard.
pub fn install<S>(router: Router<S>, service: &str) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let logger = Logger::new(
        Options {
            app_name: service.into(),
            console: false,
            ..Options::default()
        }
        .with_transport(Arc::new(JsonStdout)),
    );
    install_with_logger(router, logger)
}

pub fn install_with_logger<S>(router: Router<S>, logger: Logger) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(from_fn_with_state(logger, correlate))
}

fn context_for(headers: &axum::http::HeaderMap) -> (TraceParent, Option<TraceParent>) {
    let mut values = headers.get_all("traceparent").iter();
    let first = values.next();
    let parent = if values.next().is_none() {
        first
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<TraceParent>().ok())
    } else {
        None
    };
    let span = Uuid::new_v4().simple().to_string()[..16].to_string();
    let trace = match &parent {
        Some(parent) => parent.child(&span),
        None => TraceParent::new(&Uuid::new_v4().simple().to_string(), &span, 0),
    }
    .expect("UUID-derived nonzero lowercase IDs are valid");
    (trace, parent)
}

async fn correlate(State(logger): State<Logger>, mut request: Request, next: Next) -> Response {
    let (trace, parent) = context_for(request.headers());
    let method = match request.method().as_str() {
        "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH" => {
            request.method().as_str().to_owned()
        }
        _ => "OTHER".into(),
    };
    let mut context = LogContext {
        trace_id: Some(trace.trace_id().into()),
        span_id: Some(trace.span_id().into()),
        trace_flags: trace.flags(),
        remote: Some(false),
        ..Default::default()
    };
    if let Some(parent) = parent {
        context
            .fields
            .insert("otel.parent_span_id".into(), json!(parent.span_id()));
    }
    // The event API is deliberately explicit: entering a carrier alone does
    // not project its fields onto records. Keep a validated snapshot, rather
    // than copying arbitrary identity or baggage from later application scopes.
    let record_context = context.clone();
    request.extensions_mut().insert(trace.clone());
    with_log_context_async(context, async move {
        let mut response = next.run(request).await;
        // Validated context is exactly 55 ASCII bytes; never echo an input header.
        if let Ok(header) = HeaderValue::from_str(&trace.to_string()) {
            response
                .headers_mut()
                .entry("traceparent")
                .or_insert(header);
        }
        // No URL, query, body, cookies, user IDs, authorization, baggage or raw
        // client header values are captured. Export failure cannot fail HTTP.
        let event = logger.info(vec![json!({
            "event.name": "http.server.complete", "http.request.method": method,
            "http.response.status_code": response.status().as_u16()
        })]);
        let _ = next_loggers::apply_log_context(event, &record_context).send();
        response
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{HeaderMap, Request as HttpRequest},
        routing::get,
    };
    use std::sync::Mutex;
    use tower::ServiceExt;
    const PARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";

    #[derive(Default)]
    struct Capture(Mutex<Vec<LogRecord>>);
    impl Transport for Capture {
        fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
            self.0.lock().unwrap().push(record.clone());
            Ok(())
        }
    }

    #[test]
    fn missing_or_duplicate_header_starts_unsampled_root() {
        let mut headers = HeaderMap::new();
        let (root, parent) = context_for(&headers);
        assert!(parent.is_none());
        assert!(!root.sampled());
        headers.append("traceparent", HeaderValue::from_static(PARENT));
        headers.append("traceparent", HeaderValue::from_static(PARENT));
        assert!(context_for(&headers).1.is_none());
    }
    #[test]
    fn valid_parent_gets_new_span() {
        let mut headers = HeaderMap::new();
        headers.insert("traceparent", HeaderValue::from_static(PARENT));
        let (child, parent) = context_for(&headers);
        let parent = parent.unwrap();
        assert_eq!(child.trace_id(), parent.trace_id());
        assert_ne!(child.span_id(), parent.span_id());
        assert!(!child.sampled());
    }
    #[tokio::test]
    async fn scopes_handler_and_preserves_response() {
        let capture = Arc::new(Capture::default());
        let logger = Logger::new(
            Options {
                console: false,
                ..Options::default()
            }
            .with_transport(capture.clone()),
        );
        let app = install_with_logger(
            Router::new().route(
                "/",
                get(|| async {
                    tokio::task::yield_now().await;
                    let context = next_loggers::current_log_context();
                    assert_eq!(
                        context.trace_id.as_deref(),
                        Some("4bf92f3577b34da6a3ce929d0e0e4736")
                    );
                    assert!(context.logged_in_user.is_empty());
                    assert!(context.baggage.is_empty());
                    (axum::http::StatusCode::ACCEPTED, "ok")
                }),
            ),
            logger,
        );
        let response = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/")
                    .header("traceparent", PARENT)
                    .header("baggage", "authorization=secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::ACCEPTED);
        let child: TraceParent = response.headers()["traceparent"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(child.trace_id(), "4bf92f3577b34da6a3ce929d0e0e4736");
        assert!(next_loggers::current_log_context().trace_id.is_none());
        let records = capture.0.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].trace_id.as_deref(), Some(child.trace_id()));
        assert!(!records[0]
            .to_json()
            .unwrap()
            .contains("authorization=secret"));
    }
}
