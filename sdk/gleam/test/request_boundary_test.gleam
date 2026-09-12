import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import oresoftware_next_loggers_context as ambient
import oresoftware_next_loggers_request_boundary as boundary
import oresoftware_next_loggers_request_context as request_context

pub fn main() {
  gleeunit.main()
}

@external(erlang, "erlang", "error")
fn beam_error(reason: String) -> Nil

@external(erlang, "oresoftware_next_loggers_context_probe", "request_id")
fn logger_request_id() -> Result(String, Nil)

@external(erlang, "oresoftware_next_loggers_context_probe", "transport")
fn logger_transport() -> Result(String, Nil)

@external(erlang, "oresoftware_next_loggers_context_probe", "scope")
fn logger_scope() -> Result(String, Nil)

@external(erlang, "oresoftware_next_loggers_context_probe", "phase")
fn logger_phase() -> Result(String, Nil)

fn context(request_id: String) -> request_context.RequestContext {
  request_context.new(request_id)
  |> request_context.with_logged_in_user_id("user-gleam")
  |> request_context.with_tenant_id("tenant-gleam")
}

pub fn beam_error_is_pinned_to_websocket_message_and_does_not_escape_test() {
  let result =
    boundary.run(
      context("request-websocket"),
      boundary.websocket_message(
        "dispatch",
        Some("session-1"),
        Some("message-1"),
        Some("websocket.dispatch"),
      ),
      fn() {
        logger_request_id() |> should.equal(Ok("request-websocket"))
        logger_transport() |> should.equal(Ok("websocket"))
        logger_scope() |> should.equal(Ok("message"))
        logger_phase() |> should.equal(Ok("dispatch"))
        beam_error("handler panic")
      },
    )

  let assert Error(
    boundary.BoundaryFailure(kind, _, failure_context, code),
  ) = result
  kind |> should.equal(boundary.Panic)
  failure_context.request_id |> should.equal("request-websocket")
  code |> should.equal("request_boundary_failed")
  ambient.current_context() |> should.equal(None)
  logger_request_id() |> should.equal(Error(Nil))
  logger_transport() |> should.equal(Error(Nil))
}

pub fn nested_boundary_restores_parent_context_and_logger_metadata_test() {
  request_context.with_context(context("request-parent"), fn() {
    request_context.current_request_id()
    |> should.equal(Some("request-parent"))
    logger_request_id() |> should.equal(Ok("request-parent"))

    boundary.run(
      context("request-child"),
      boundary.tcp_message(
        "decode",
        Some("connection-1"),
        Some("message-1"),
        Some("tcp.decode"),
      ),
      fn() {
        request_context.current_request_id()
        |> should.equal(Some("request-child"))
        logger_request_id() |> should.equal(Ok("request-child"))
        logger_transport() |> should.equal(Ok("tcp"))
        logger_scope() |> should.equal(Ok("message"))
        "decoded"
      },
    )
    |> should.equal(Ok("decoded"))

    request_context.current_request_id()
    |> should.equal(Some("request-parent"))
    logger_request_id() |> should.equal(Ok("request-parent"))
    logger_transport() |> should.equal(Error(Nil))
  })

  request_context.current_request_id() |> should.equal(None)
  logger_request_id() |> should.equal(Error(Nil))
}

pub fn invalid_transport_scope_is_rejected_without_running_callback_test() {
  let invalid =
    boundary.RequestBoundary(
      transport: boundary.Http,
      scope: boundary.Message,
      phase: "handler",
      operation: None,
      connection_id: None,
      message_id: None,
    )

  let result =
    boundary.run(context("request-invalid"), invalid, fn() {
      panic as "invalid boundary callback ran"
    })
  let assert Error(
    boundary.BoundaryFailure(kind, _, failure_context, code),
  ) = result
  kind |> should.equal(boundary.Exception)
  failure_context.request_id |> should.equal("request-invalid")
  code |> should.equal("invalid_http_scope")
  ambient.current_context() |> should.equal(None)
}
