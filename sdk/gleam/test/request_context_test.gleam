import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import oresoftware_next_loggers_context as ambient
import oresoftware_next_loggers_request_context as request_context

pub fn main() {
  gleeunit.main()
}

fn example(request_id: String) -> request_context.RequestContext {
  request_context.new(request_id)
  |> request_context.with_logged_in_user_id("user-gleam")
  |> request_context.with_tenant_id("tenant-gleam")
  |> request_context.with_session_id("session-gleam")
  |> request_context.with_correlation_id("correlation-gleam")
}

pub fn request_identity_is_scoped_and_restored_test() {
  ambient.current_context() |> should.equal(None)

  let snapshot =
    request_context.with_context(example("request-gleam"), fn() {
      request_context.current_request_id()
      |> should.equal(Some("request-gleam"))
      request_context.current_logged_in_user_id()
      |> should.equal(Some("user-gleam"))
      request_context.current_tenant_id()
      |> should.equal(Some("tenant-gleam"))
      request_context.current_session_id()
      |> should.equal(Some("session-gleam"))
      request_context.current_correlation_id()
      |> should.equal(Some("correlation-gleam"))
      request_context.capture_context()
    })

  ambient.current_context() |> should.equal(None)
  let assert Some(context) = snapshot
  context.routine_id |> should.equal(Some("request-gleam"))
}

pub fn captured_context_can_be_explicitly_reentered_test() {
  let snapshot =
    request_context.with_context(example("request-captured"), fn() {
      request_context.capture_context()
    })

  request_context.current_request_id() |> should.equal(None)
  request_context.run_captured(snapshot, fn() {
    request_context.current_request_id()
    |> should.equal(Some("request-captured"))
    request_context.current_logged_in_user_id()
    |> should.equal(Some("user-gleam"))
  })
  request_context.current_request_id() |> should.equal(None)
}

pub fn nested_context_uses_one_ambient_carrier_test() {
  request_context.with_context(example("request-parent"), fn() {
    request_context.with_context(
      request_context.new("request-child")
        |> request_context.with_session_id("session-child"),
      fn() {
        request_context.current_request_id()
        |> should.equal(Some("request-child"))
        request_context.current_tenant_id()
        |> should.equal(Some("tenant-gleam"))
        request_context.current_session_id()
        |> should.equal(Some("session-child"))
      },
    )
    request_context.current_request_id()
    |> should.equal(Some("request-parent"))
  })
}
