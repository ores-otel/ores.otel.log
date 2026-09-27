//! Native Axum 0.8 adapter. Retains application-owned auth, middleware, and OTEL
//! providers. Emits next-loggers/v1 JSON and scopes the canonical poll-safe logger
//! carrier; this is correlation, not an OpenTelemetry span provider/exporter.
use crate::TraceParent;
use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue},
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
    return install_with_logger(router, logger);
}

pub fn install_with_logger<S>(router: Router<S>, logger: Logger) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    return router.layer(from_fn_with_state(logger, correlate));
}

/// Sanitized server-side correlation derived from one request's `traceparent`.
///
/// This intentionally exposes only validated W3C correlation identifiers. Raw
/// headers, baggage, tracestate, URL/query values, cookies, authorization, and
/// application identity never enter this value. Services that retain their own
/// OTLP provider or metrics pipeline can reuse this parser without installing
/// the convenience `next_loggers` middleware.
#[derive(Clone, Debug)]
pub struct RequestCorrelation {
    traceparent: TraceParent,
    parent_span_id: Option<String>,
}

impl RequestCorrelation {
    pub fn traceparent(&self) -> &TraceParent {
        return &self.traceparent;
    }

    pub fn parent_span_id(&self) -> Option<&str> {
        return self.parent_span_id.as_deref();
    }

    pub fn log_context(&self) -> LogContext {
        let mut context = LogContext {
            trace_id: Some(self.traceparent.trace_id().into()),
            span_id: Some(self.traceparent.span_id().into()),
            trace_flags: self.traceparent.flags(),
            remote: Some(false),
            ..Default::default()
        };
        if let Some(parent_span_id) = self.parent_span_id() {
            context
                .fields
                .insert("otel.parent_span_id".into(), json!(parent_span_id));
        }
        return context;
    }
}

/// Parse at most one valid W3C `traceparent` and derive a fresh server span.
///
/// Missing, malformed, non-UTF-8, or duplicate headers fail closed to a new
/// unsampled root. The returned child is always generated locally, so callers
/// never need to retain or echo untrusted raw header bytes.
pub fn request_correlation(headers: &HeaderMap) -> RequestCorrelation {
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
    let traceparent = match &parent {
        Some(parent) => parent.child(&span),
        None => TraceParent::new(&Uuid::new_v4().simple().to_string(), &span, 0),
    }
    .expect("UUID-derived nonzero lowercase IDs are valid");
    let parent_span_id = parent.map(|value| value.span_id().to_string());
    return RequestCorrelation {
        traceparent,
        parent_span_id,
    };
}

async fn correlate(State(logger): State<Logger>, mut request: Request, next: Next) -> Response {
    let correlation = request_correlation(request.headers());
    let trace = correlation.traceparent().clone();
    let method = match request.method().as_str() {
        "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH" => {
            request.method().as_str().to_owned()
        }
        _ => "OTHER".into(),
    };
    let context = correlation.log_context();
    // The event API is deliberately explicit: entering a carrier alone does
    // not project its fields onto records. Keep a validated snapshot, rather
    // than copying arbitrary identity or baggage from later application scopes.
    let record_context = context.clone();
    request.extensions_mut().insert(trace.clone());
    return with_log_context_async(context, async move {
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
        return response;
    })
    .await;
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
            return Ok(());
        }
    }

    #[test]
    fn missing_or_duplicate_header_starts_unsampled_root() {
        let mut headers = HeaderMap::new();
        let root = request_correlation(&headers);
        assert!(root.parent_span_id().is_none());
        assert!(!root.traceparent().sampled());
        headers.append("traceparent", HeaderValue::from_static(PARENT));
        headers.append("traceparent", HeaderValue::from_static(PARENT));
        let duplicate = request_correlation(&headers);
        assert!(duplicate.parent_span_id().is_none());
        assert!(!duplicate.traceparent().sampled());
    }

    #[test]
    fn malformed_header_starts_unsampled_root_without_retaining_input() {
        let mut headers = HeaderMap::new();
        headers.insert("traceparent", HeaderValue::from_static("not-a-traceparent"));
        let correlation = request_correlation(&headers);
        assert!(correlation.parent_span_id().is_none());
        assert!(!correlation.traceparent().sampled());
        assert!(!format!("{:?}", correlation).contains("not-a-traceparent"));
    }

    #[test]
    fn valid_parent_gets_new_span_and_exposes_only_validated_parent_id() {
        let mut headers = HeaderMap::new();
        headers.insert("traceparent", HeaderValue::from_static(PARENT));
        let correlation = request_correlation(&headers);
        assert_eq!(
            correlation.traceparent().trace_id(),
            "4bf92f3577b34da6a3ce929d0e0e4736"
        );
        assert_ne!(correlation.traceparent().span_id(), "00f067aa0ba902b7");
        assert_eq!(correlation.parent_span_id(), Some("00f067aa0ba902b7"));
        assert!(!correlation.traceparent().sampled());
        let context = correlation.log_context();
        assert_eq!(
            context.trace_id.as_deref(),
            Some("4bf92f3577b34da6a3ce929d0e0e4736")
        );
        assert!(context.logged_in_user.is_empty());
        assert!(context.baggage.is_empty());
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
                    return (axum::http::StatusCode::ACCEPTED, "ok");
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
