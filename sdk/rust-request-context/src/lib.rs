//! Typed request correlation over the canonical `next-loggers` poll-safe
//! execution context. This crate never creates a second thread-local or Tokio
//! task-local.

use next_loggers::{
    capture_log_context, current_log_context, json, with_log_context, with_log_context_async,
    JsonObject, LogContext, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(feature = "tokio")]
use std::future::Future;

pub const REQUEST_CONTEXT_SCHEMA: &str = "ores.request-context.v1";

/// Allowlisted request-scoped correlation data. Never place credentials,
/// authorization headers, cookies, raw tokens, or email addresses here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_in_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub baggage: BTreeMap<String, String>,
}

impl RequestContext {
    /// The correlation fields this request contributes to a log record: the
    /// schema marker, every non-blank string identifier, then the numeric
    /// timestamps that are set. Built as one new map from optional entries.
    fn log_fields(&self) -> JsonObject {
        let strings = [
            ("request.id", Some(&self.request_id)),
            ("user.id", self.logged_in_user_id.as_ref()),
            ("tenant.id", self.tenant_id.as_ref()),
            ("session.id", self.session_id.as_ref()),
            ("correlation.id", self.correlation_id.as_ref()),
            ("request.parent_id", self.parent_request_id.as_ref()),
            ("operation.name", self.operation.as_ref()),
            ("service.name", self.service_name.as_ref()),
            ("request.locale", self.locale.as_ref()),
        ];
        let numbers = [
            ("request.started_at_unix_ms", self.started_at_unix_ms),
            ("request.deadline_unix_ms", self.deadline_unix_ms),
        ];
        std::iter::once((
            "request.context.schema".to_string(),
            Value::String(REQUEST_CONTEXT_SCHEMA.into()),
        ))
        .chain(
            strings
                .into_iter()
                .filter_map(|(key, value)| string_entry(key, value)),
        )
        .chain(
            numbers
                .into_iter()
                .filter_map(|(key, value)| value.map(|value| (key.to_string(), json!(value)))),
        )
        .collect()
    }

    /// Project this request into the one canonical logger context carrier.
    pub fn to_log_context(&self) -> LogContext {
        let logged_in_user: JsonObject = normalized(self.logged_in_user_id.as_deref())
            .map(|user_id| ("id".to_string(), Value::String(user_id.to_string())))
            .into_iter()
            .collect();

        let trace_ids = self.trace_id.iter().cloned().collect();
        LogContext {
            logged_in_user,
            fields: self.log_fields(),
            trace_id: self.trace_id.clone(),
            trace_ids,
            span_id: self.span_id.clone(),
            baggage: self.baggage.clone(),
            routine_id: normalized(Some(&self.request_id)).map(str::to_string),
            tags: vec!["ores-request-context".into()],
            ..Default::default()
        }
        .normalized()
    }

    /// Reconstruct a defensive request snapshot from the canonical carrier.
    pub fn from_log_context(context: &LogContext) -> Option<Self> {
        let request_id = field_string(&context.fields, "request.id")?;
        let logged_in_user_id = context
            .logged_in_user
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| {
                context
                    .logged_in_user
                    .get("ddUserId")
                    .and_then(Value::as_str)
            })
            .or_else(|| field_str(&context.fields, "user.id"))
            .map(str::to_string);

        Some(Self {
            request_id,
            logged_in_user_id,
            tenant_id: field_string(&context.fields, "tenant.id"),
            session_id: field_string(&context.fields, "session.id"),
            correlation_id: field_string(&context.fields, "correlation.id"),
            parent_request_id: field_string(&context.fields, "request.parent_id"),
            trace_id: context.trace_id.clone(),
            span_id: context.span_id.clone(),
            operation: field_string(&context.fields, "operation.name"),
            service_name: field_string(&context.fields, "service.name"),
            locale: field_string(&context.fields, "request.locale"),
            started_at_unix_ms: field_u64(&context.fields, "request.started_at_unix_ms"),
            deadline_unix_ms: field_u64(&context.fields, "request.deadline_unix_ms"),
            baggage: context.baggage.clone(),
        })
    }
}

fn normalized(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// One optional field entry: present only when `value` is a non-blank string.
fn string_entry(key: &str, value: Option<&String>) -> Option<(String, Value)> {
    normalized(value.map(String::as_str))
        .map(|value| (key.to_string(), Value::String(value.to_string())))
}

fn field_str<'a>(fields: &'a JsonObject, key: &str) -> Option<&'a str> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .and_then(|value| normalized(Some(value)))
}

fn field_string(fields: &JsonObject, key: &str) -> Option<String> {
    field_str(fields, key).map(str::to_string)
}

fn field_u64(fields: &JsonObject, key: &str) -> Option<u64> {
    fields.get(key).and_then(Value::as_u64)
}

/// Return the current request snapshot from the canonical poll-local logger
/// context. An empty/default logger frame is treated as no request.
pub fn current_request_context() -> Option<RequestContext> {
    RequestContext::from_log_context(&current_log_context())
}

/// Capture a request snapshot for explicit transfer to a queue or detached task.
pub fn capture_request_context() -> Option<RequestContext> {
    current_request_context()
}

pub fn current_request_id() -> Option<String> {
    field_string(&current_log_context().fields, "request.id")
}

pub fn current_logged_in_user_id() -> Option<String> {
    let context = current_log_context();
    context
        .logged_in_user
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| {
            context
                .logged_in_user
                .get("ddUserId")
                .and_then(Value::as_str)
        })
        .or_else(|| field_str(&context.fields, "user.id"))
        .map(str::to_string)
}

pub fn current_tenant_id() -> Option<String> {
    field_string(&current_log_context().fields, "tenant.id")
}

pub fn current_session_id() -> Option<String> {
    field_string(&current_log_context().fields, "session.id")
}

pub fn current_correlation_id() -> Option<String> {
    field_string(&current_log_context().fields, "correlation.id")
}

/// Scope synchronous/thread-bound work through the existing logger RAII stack.
pub fn with_thread_request_context<T>(
    request_context: RequestContext,
    callback: impl FnOnce() -> T,
) -> T {
    with_log_context(request_context.to_log_context(), callback)
}

/// Scope an async future through the logger's poll-safe `ContextFuture`. The
/// snapshot is installed only while this future is being polled, so interleaved
/// Tokio tasks cannot observe one another's request data.
pub async fn with_request_context<F>(request_context: RequestContext, future: F) -> F::Output
where
    F: Future,
{
    with_log_context_async(request_context.to_log_context(), future).await
}

/// Re-enter an explicitly captured request snapshot.
pub async fn with_captured_request_context<F>(
    request_context: Option<RequestContext>,
    future: F,
) -> F::Output
where
    F: Future,
{
    match request_context {
        Some(context) => with_request_context(context, future).await,
        None => future.await,
    }
}

/// Tokio tasks do not implicitly inherit a logical request. This helper
/// captures the complete canonical logger frame and re-enters it in the child.
#[cfg(feature = "tokio")]
pub fn spawn_with_current_request_context<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let captured = capture_log_context();
    tokio::spawn(with_log_context_async(captured, future))
}
