import gleam/dict.{type Dict}
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import oresoftware_next_loggers as core
import oresoftware_next_loggers_context as ambient

pub const schema = "ores.request-context.v1"

/// Allowlisted request-scoped correlation data. Never include credentials,
/// cookies, authorization headers, raw tokens, or email addresses.
pub type RequestContext {
  RequestContext(
    request_id: String,
    logged_in_user_id: Option(String),
    tenant_id: Option(String),
    session_id: Option(String),
    correlation_id: Option(String),
    parent_request_id: Option(String),
    trace_id: Option(String),
    span_id: Option(String),
    operation: Option(String),
    service_name: Option(String),
    locale: Option(String),
    started_at_unix_ms: Option(Int),
    deadline_unix_ms: Option(Int),
    baggage: Dict(String, String),
  )
}

pub fn new(request_id: String) -> RequestContext {
  RequestContext(
    request_id: request_id,
    logged_in_user_id: None,
    tenant_id: None,
    session_id: None,
    correlation_id: None,
    parent_request_id: None,
    trace_id: None,
    span_id: None,
    operation: None,
    service_name: None,
    locale: None,
    started_at_unix_ms: None,
    deadline_unix_ms: None,
    baggage: dict.new(),
  )
}

pub fn with_logged_in_user_id(
  context: RequestContext,
  user_id: String,
) -> RequestContext {
  RequestContext(..context, logged_in_user_id: Some(user_id))
}

pub fn with_tenant_id(
  context: RequestContext,
  tenant_id: String,
) -> RequestContext {
  RequestContext(..context, tenant_id: Some(tenant_id))
}

pub fn with_session_id(
  context: RequestContext,
  session_id: String,
) -> RequestContext {
  RequestContext(..context, session_id: Some(session_id))
}

pub fn with_correlation_id(
  context: RequestContext,
  correlation_id: String,
) -> RequestContext {
  RequestContext(..context, correlation_id: Some(correlation_id))
}

pub fn to_log_context(context: RequestContext) -> ambient.LogContext {
  let fields = [
    #("request.context.schema", json.string(schema)),
    #("request.id", json.string(context.request_id)),
  ]
  let fields = add_string_field(fields, "user.id", context.logged_in_user_id)
  let fields = add_string_field(fields, "tenant.id", context.tenant_id)
  let fields = add_string_field(fields, "session.id", context.session_id)
  let fields =
    add_string_field(fields, "correlation.id", context.correlation_id)
  let fields =
    add_string_field(fields, "request.parent_id", context.parent_request_id)
  let fields = add_string_field(fields, "operation.name", context.operation)
  let fields = add_string_field(fields, "service.name", context.service_name)
  let fields = add_string_field(fields, "request.locale", context.locale)
  let fields =
    add_int_field(
      fields,
      "request.started_at_unix_ms",
      context.started_at_unix_ms,
    )
  let fields =
    add_int_field(fields, "request.deadline_unix_ms", context.deadline_unix_ms)
  let logged_in_user = case context.logged_in_user_id {
    Some(value) -> Some([#("id", json.string(value))])
    None -> None
  }
  let trace_ids = case context.trace_id {
    Some(value) -> [value]
    None -> []
  }
  let baggage =
    context.baggage
    |> dict.to_list
    |> list.map(fn(entry) {
      let #(key, value) = entry
      #(key, json.string(value))
    })

  ambient.LogContext(
    logged_in_user: logged_in_user,
    users: [],
    fields: fields,
    trace_id: context.trace_id,
    trace_ids: trace_ids,
    span_id: context.span_id,
    trace_flags: None,
    trace_state: None,
    baggage: baggage,
    routine_id: Some(context.request_id),
    tags: identity_tags(context),
    context: [],
    meta: [],
  )
}

/// Scope work through the existing next-loggers process-local carrier.
pub fn with_context(
  context: RequestContext,
  callback: fn() -> result,
) -> result {
  ambient.with_context(to_log_context(context), callback)
}

/// Capture the immutable canonical frame for a queue or child process.
pub fn capture_context() -> Option(ambient.LogContext) {
  ambient.current_context()
}

/// Re-enter an explicitly captured frame in a child process or callback.
pub fn run_captured(
  snapshot: Option(ambient.LogContext),
  callback: fn() -> result,
) -> result {
  case snapshot {
    Some(context) -> ambient.with_context(context, callback)
    None -> callback()
  }
}

pub fn current_request_id() -> Option(String) {
  case ambient.current_context() {
    Some(context) ->
      case context.routine_id {
        Some(value) -> Some(value)
        None ->
          find_identity_tag(list.reverse(context.tags), "ores.request_id=")
      }
    None -> None
  }
}

pub fn current_logged_in_user_id() -> Option(String) {
  current_identity("ores.logged_in_user_id=")
}

pub fn current_tenant_id() -> Option(String) {
  current_identity("ores.tenant_id=")
}

pub fn current_session_id() -> Option(String) {
  current_identity("ores.session_id=")
}

pub fn current_correlation_id() -> Option(String) {
  current_identity("ores.correlation_id=")
}

fn current_identity(prefix: String) -> Option(String) {
  case ambient.current_context() {
    Some(context) -> find_identity_tag(list.reverse(context.tags), prefix)
    None -> None
  }
}

fn identity_tags(context: RequestContext) -> List(String) {
  let tags = [
    "ores-request-context",
    "ores.request_id=" <> context.request_id,
  ]
  let tags =
    add_identity_tag(tags, "ores.logged_in_user_id=", context.logged_in_user_id)
  let tags = add_identity_tag(tags, "ores.tenant_id=", context.tenant_id)
  let tags = add_identity_tag(tags, "ores.session_id=", context.session_id)
  add_identity_tag(tags, "ores.correlation_id=", context.correlation_id)
}

fn add_identity_tag(
  tags: List(String),
  prefix: String,
  value: Option(String),
) -> List(String) {
  case value {
    Some(value) -> list.append(tags, [prefix <> value])
    None -> tags
  }
}

fn find_identity_tag(tags: List(String), prefix: String) -> Option(String) {
  case tags {
    [] -> None
    [tag, ..rest] ->
      case string.starts_with(tag, prefix) {
        True -> Some(string.drop_start(tag, up_to: string.length(prefix)))
        False -> find_identity_tag(rest, prefix)
      }
  }
}

fn add_string_field(
  fields: core.JsonObject,
  key: String,
  value: Option(String),
) -> core.JsonObject {
  case value {
    Some(value) -> list.append(fields, [#(key, json.string(value))])
    None -> fields
  }
}

fn add_int_field(
  fields: core.JsonObject,
  key: String,
  value: Option(Int),
) -> core.JsonObject {
  case value {
    Some(value) -> list.append(fields, [#(key, json.int(value))])
    None -> fields
  }
}
