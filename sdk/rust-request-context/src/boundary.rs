use crate::{current_request_context, with_request_context, RequestContext};
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::fmt;
use std::future::{poll_fn, Future};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::task::Poll;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestTransport {
    Http,
    Tcp,
    WebSocket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestScope {
    Request,
    Connection,
    Session,
    Message,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestFailureKind {
    Exception,
    Panic,
    Timeout,
    Cancelled,
    Disconnect,
}

/// Allowlisted protocol correlation only. Payloads, credentials, cookies,
/// authorization headers, and direct identity data do not belong here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestBoundary {
    pub transport: RequestTransport,
    pub scope: RequestScope,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

impl RequestBoundary {
    pub fn http(phase: impl Into<String>, operation: Option<String>) -> Self {
        Self {
            transport: RequestTransport::Http,
            scope: RequestScope::Request,
            phase: phase.into(),
            operation,
            connection_id: None,
            message_id: None,
        }
    }

    pub fn tcp_connection(
        phase: impl Into<String>,
        connection_id: Option<String>,
        operation: Option<String>,
    ) -> Self {
        Self {
            transport: RequestTransport::Tcp,
            scope: RequestScope::Connection,
            phase: phase.into(),
            operation,
            connection_id,
            message_id: None,
        }
    }

    pub fn tcp_message(
        phase: impl Into<String>,
        connection_id: Option<String>,
        message_id: Option<String>,
        operation: Option<String>,
    ) -> Self {
        Self {
            transport: RequestTransport::Tcp,
            scope: RequestScope::Message,
            phase: phase.into(),
            operation,
            connection_id,
            message_id,
        }
    }

    pub fn websocket_session(
        phase: impl Into<String>,
        connection_id: Option<String>,
        operation: Option<String>,
    ) -> Self {
        Self {
            transport: RequestTransport::WebSocket,
            scope: RequestScope::Session,
            phase: phase.into(),
            operation,
            connection_id,
            message_id: None,
        }
    }

    pub fn websocket_message(
        phase: impl Into<String>,
        connection_id: Option<String>,
        message_id: Option<String>,
        operation: Option<String>,
    ) -> Self {
        Self {
            transport: RequestTransport::WebSocket,
            scope: RequestScope::Message,
            phase: phase.into(),
            operation,
            connection_id,
            message_id,
        }
    }

    pub fn validated(mut self) -> Result<Self, RequestBoundaryValidationError> {
        self.phase = bounded_text("phase", self.phase, 128, true)?.unwrap_or_default();
        self.operation = bounded_text("operation", self.operation.unwrap_or_default(), 256, false)?;
        self.connection_id = bounded_text(
            "connectionId",
            self.connection_id.unwrap_or_default(),
            256,
            false,
        )?;
        self.message_id = bounded_text(
            "messageId",
            self.message_id.unwrap_or_default(),
            256,
            false,
        )?;

        match (self.transport, self.scope) {
            (RequestTransport::Http, RequestScope::Request) => {
                if self.connection_id.is_some() || self.message_id.is_some() {
                    return Err(RequestBoundaryValidationError::new(
                        "HTTP request scope cannot carry connection or message IDs",
                    ));
                }
            }
            (RequestTransport::Tcp, RequestScope::Connection) => {
                if self.message_id.is_some() {
                    return Err(RequestBoundaryValidationError::new(
                        "TCP connection scope cannot carry a message ID",
                    ));
                }
            }
            (RequestTransport::Tcp, RequestScope::Message) => {}
            (RequestTransport::WebSocket, RequestScope::Session) => {
                if self.message_id.is_some() {
                    return Err(RequestBoundaryValidationError::new(
                        "WebSocket session scope cannot carry a message ID",
                    ));
                }
            }
            (RequestTransport::WebSocket, RequestScope::Message) => {}
            (RequestTransport::Http, _)
            | (RequestTransport::Tcp, _)
            | (RequestTransport::WebSocket, _) => {
                return Err(RequestBoundaryValidationError::new(
                    "transport and request scope are incompatible",
                ));
            }
        }
        Ok(self)
    }
}

fn bounded_text(
    field: &str,
    value: String,
    maximum: usize,
    required: bool,
) -> Result<Option<String>, RequestBoundaryValidationError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return if required {
            Err(RequestBoundaryValidationError::new(format!(
                "{field} is required"
            )))
        } else {
            Ok(None)
        };
    }
    if value.len() > maximum || value.chars().any(char::is_control) {
        return Err(RequestBoundaryValidationError::new(format!(
            "{field} must be bounded text"
        )));
    }
    Ok(Some(value))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestBoundaryValidationError {
    message: String,
}

impl RequestBoundaryValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for RequestBoundaryValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RequestBoundaryValidationError {}

pub enum RequestBoundaryCause<E> {
    Error(E),
    Panic(Box<dyn Any + Send + 'static>),
    InvalidBoundary(RequestBoundaryValidationError),
}

impl<E: fmt::Debug> fmt::Debug for RequestBoundaryCause<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Error(error) => formatter.debug_tuple("Error").field(error).finish(),
            Self::Panic(payload) => formatter
                .debug_tuple("Panic")
                .field(&panic_payload_message(payload.as_ref()))
                .finish(),
            Self::InvalidBoundary(error) => formatter
                .debug_tuple("InvalidBoundary")
                .field(error)
                .finish(),
        }
    }
}

pub struct RequestBoundaryFailure<C> {
    pub kind: RequestFailureKind,
    pub boundary: RequestBoundary,
    pub context: RequestContext,
    pub cause: C,
    pub observed_at_unix_ms: u64,
}

impl<C: fmt::Debug> fmt::Debug for RequestBoundaryFailure<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestBoundaryFailure")
            .field("kind", &self.kind)
            .field("boundary", &self.boundary)
            .field("context", &self.context)
            .field("cause", &self.cause)
            .field("observed_at_unix_ms", &self.observed_at_unix_ms)
            .finish()
    }
}

pub type RequestBoundaryResult<T, E> =
    Result<T, RequestBoundaryFailure<RequestBoundaryCause<E>>>;

fn observed_at_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn panic_payload_message<'a>(payload: &'a (dyn Any + Send + 'static)) -> &'a str {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else {
        "non-string panic payload"
    }
}

async fn catch_future_unwind<F>(future: F) -> Result<F::Output, Box<dyn Any + Send + 'static>>
where
    F: Future,
{
    let mut future = Box::pin(future);
    poll_fn(move |task_context| {
        match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(task_context))) {
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(payload)),
        }
    })
    .await
}

fn report_safely<C, Report>(report: &Report, failure: &RequestBoundaryFailure<C>)
where
    Report: Fn(&RequestBoundaryFailure<C>),
{
    let _ = catch_unwind(AssertUnwindSafe(|| report(failure)));
}

fn classify_safely<E, Classify>(
    classify: &Classify,
    error: &E,
    boundary: &RequestBoundary,
) -> RequestFailureKind
where
    Classify: Fn(&E, &RequestBoundary) -> RequestFailureKind,
{
    catch_unwind(AssertUnwindSafe(|| classify(error, boundary)))
        .unwrap_or(RequestFailureKind::Exception)
}

/// Catches errors and unwinding panics from exactly one logical HTTP, TCP, or
/// WebSocket operation. The canonical poll-local logger context is active while
/// the operation and reporter run; no process-global panic hook is installed.
pub async fn run_with_classified_request_boundary<T, E, F, Classify, Report>(
    request_context: RequestContext,
    boundary: RequestBoundary,
    operation: F,
    classify: Classify,
    report: Report,
) -> RequestBoundaryResult<T, E>
where
    F: Future<Output = Result<T, E>>,
    Classify: Fn(&E, &RequestBoundary) -> RequestFailureKind,
    Report: Fn(&RequestBoundaryFailure<RequestBoundaryCause<E>>),
{
    let explicit_context = request_context.clone();
    with_request_context(request_context, async move {
        let invalid_boundary = boundary.clone();
        let boundary = match boundary.validated() {
            Ok(boundary) => boundary,
            Err(error) => {
                let failure = RequestBoundaryFailure {
                    kind: RequestFailureKind::Exception,
                    boundary: invalid_boundary,
                    context: current_request_context().unwrap_or(explicit_context),
                    cause: RequestBoundaryCause::InvalidBoundary(error),
                    observed_at_unix_ms: observed_at_unix_ms(),
                };
                report_safely(&report, &failure);
                return Err(failure);
            }
        };

        match catch_future_unwind(operation).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => {
                let kind = classify_safely(&classify, &error, &boundary);
                let failure = RequestBoundaryFailure {
                    kind,
                    boundary,
                    context: current_request_context().unwrap_or(explicit_context),
                    cause: RequestBoundaryCause::Error(error),
                    observed_at_unix_ms: observed_at_unix_ms(),
                };
                report_safely(&report, &failure);
                Err(failure)
            }
            Err(payload) => {
                let failure = RequestBoundaryFailure {
                    kind: RequestFailureKind::Panic,
                    boundary,
                    context: current_request_context().unwrap_or(explicit_context),
                    cause: RequestBoundaryCause::Panic(payload),
                    observed_at_unix_ms: observed_at_unix_ms(),
                };
                report_safely(&report, &failure);
                Err(failure)
            }
        }
    })
    .await
}

pub async fn run_with_request_boundary<T, E, F, Report>(
    request_context: RequestContext,
    boundary: RequestBoundary,
    operation: F,
    report: Report,
) -> RequestBoundaryResult<T, E>
where
    F: Future<Output = Result<T, E>>,
    Report: Fn(&RequestBoundaryFailure<RequestBoundaryCause<E>>),
{
    run_with_classified_request_boundary(
        request_context,
        boundary,
        operation,
        |_error, _boundary| RequestFailureKind::Exception,
        report,
    )
    .await
}
