import gleam/option.{type Option, None, Some}
import gleam/string
import oresoftware_next_loggers_context as ambient
import oresoftware_next_loggers_request_context as request_context

pub type Transport {
  Http
  Tcp
  WebSocket
}

pub type Scope {
  Request
  Connection
  Session
  Message
}

pub type FailureKind {
  Exception
  Panic
  Timeout
  Cancelled
  Disconnect
}

/// Protocol metadata is allowlisted. Never include payloads, credentials,
/// authorization headers, cookies, raw tokens, or email addresses.
pub type RequestBoundary {
  RequestBoundary(
    transport: Transport,
    scope: Scope,
    phase: String,
    operation: Option(String),
    connection_id: Option(String),
    message_id: Option(String),
  )
}

pub type BoundaryFailure {
  BoundaryFailure(
    kind: FailureKind,
    boundary: RequestBoundary,
    context: request_context.RequestContext,
    code: String,
  )
}

pub fn http(phase: String, operation: Option(String)) -> RequestBoundary {
  RequestBoundary(
    transport: Http,
    scope: Request,
    phase: phase,
    operation: operation,
    connection_id: None,
    message_id: None,
  )
}

pub fn tcp_connection(
  phase: String,
  connection_id: Option(String),
  operation: Option(String),
) -> RequestBoundary {
  RequestBoundary(
    transport: Tcp,
    scope: Connection,
    phase: phase,
    operation: operation,
    connection_id: connection_id,
    message_id: None,
  )
}

pub fn tcp_message(
  phase: String,
  connection_id: Option(String),
  message_id: Option(String),
  operation: Option(String),
) -> RequestBoundary {
  RequestBoundary(
    transport: Tcp,
    scope: Message,
    phase: phase,
    operation: operation,
    connection_id: connection_id,
    message_id: message_id,
  )
}

pub fn websocket_session(
  phase: String,
  connection_id: Option(String),
  operation: Option(String),
) -> RequestBoundary {
  RequestBoundary(
    transport: WebSocket,
    scope: Session,
    phase: phase,
    operation: operation,
    connection_id: connection_id,
    message_id: None,
  )
}

pub fn websocket_message(
  phase: String,
  connection_id: Option(String),
  message_id: Option(String),
  operation: Option(String),
) -> RequestBoundary {
  RequestBoundary(
    transport: WebSocket,
    scope: Message,
    phase: phase,
    operation: operation,
    connection_id: connection_id,
    message_id: message_id,
  )
}

@external(erlang, "oresoftware_next_loggers_context_ffi", "run_protected")
fn ffi_run_protected(
  context: ambient.LogContext,
  transport: String,
  scope: String,
  phase: String,
  connection_id: String,
  message_id: String,
  operation: String,
  callback: fn() -> result,
) -> Result(result, String)

/// Run one HTTP, TCP, or WebSocket operation in the current BEAM process.
/// Ordinary `error`, `throw`, and `exit` failures become a typed result while
/// the canonical context and OTP Logger process metadata are still installed.
/// Untrappable VM failures such as `kill` and OOM remain outside this boundary.
pub fn run(
  context: request_context.RequestContext,
  boundary: RequestBoundary,
  callback: fn() -> result,
) -> Result(result, BoundaryFailure) {
  case normalize(boundary) {
    Error(code) ->
      Error(BoundaryFailure(
        kind: Exception,
        boundary: boundary,
        context: context,
        code: code,
      ))
    Ok(#(normalized, transport, scope)) -> {
      let request_log_context = request_context.to_log_context(context)
      let log_context = case ambient.current_context() {
        Some(parent) -> ambient.merge(parent, request_log_context)
        None -> request_log_context
      }
      case ffi_run_protected(
        log_context,
        transport,
        scope,
        normalized.phase,
        option_string(normalized.connection_id),
        option_string(normalized.message_id),
        option_string(normalized.operation),
        callback,
      ) {
        Ok(value) -> Ok(value)
        Error(kind) ->
          Error(BoundaryFailure(
            kind: failure_kind(kind),
            boundary: normalized,
            context: context,
            code: "request_boundary_failed",
          ))
      }
    }
  }
}

fn normalize(
  boundary: RequestBoundary,
) -> Result(#(RequestBoundary, String, String), String) {
  let phase = string.trim(boundary.phase)
  case phase == "" || string.length(phase) > 128 {
    True -> Error("invalid_phase")
    False -> {
      let normalized = RequestBoundary(
        ..boundary,
        phase: phase,
        operation: normalize_optional(boundary.operation),
        connection_id: normalize_optional(boundary.connection_id),
        message_id: normalize_optional(boundary.message_id),
      )
      case normalized.transport, normalized.scope {
        Http, Request ->
          case normalized.connection_id, normalized.message_id {
            None, None -> Ok(#(normalized, "http", "request"))
            _, _ -> Error("invalid_http_scope")
          }
        Tcp, Connection ->
          case normalized.message_id {
            None -> Ok(#(normalized, "tcp", "connection"))
            Some(_) -> Error("invalid_tcp_connection_scope")
          }
        Tcp, Message -> Ok(#(normalized, "tcp", "message"))
        WebSocket, Session ->
          case normalized.message_id {
            None -> Ok(#(normalized, "websocket", "session"))
            Some(_) -> Error("invalid_websocket_session_scope")
          }
        WebSocket, Message -> Ok(#(normalized, "websocket", "message"))
        Http, _ -> Error("invalid_http_scope")
        Tcp, _ -> Error("invalid_tcp_scope")
        WebSocket, _ -> Error("invalid_websocket_scope")
      }
    }
  }
}

fn normalize_optional(value: Option(String)) -> Option(String) {
  case value {
    None -> None
    Some(value) -> {
      let value = string.trim(value)
      case value == "" || string.length(value) > 256 {
        True -> None
        False -> Some(value)
      }
    }
  }
}

fn option_string(value: Option(String)) -> String {
  case value {
    Some(value) -> value
    None -> ""
  }
}

fn failure_kind(value: String) -> FailureKind {
  case value {
    "exception" -> Exception
    "panic" -> Panic
    "timeout" -> Timeout
    "cancelled" -> Cancelled
    "disconnect" -> Disconnect
    _ -> Exception
  }
}
