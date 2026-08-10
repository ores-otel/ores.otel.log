import gleam/erlang/process
import gleam/json
import gleam/option.{None, Some}
import gleeunit/should
import oresoftware_next_loggers as logging
import oresoftware_next_loggers/context as log_context
import oresoftware_next_loggers/shutdown

pub fn process_context_is_scoped_and_applied_test() {
  let context =
    log_context.LogContext(
      ..log_context.empty(),
      fields: [#("request.id", json.string("r1"))],
      logged_in_user: Some([#("id", json.string("u1"))]),
      trace_id: Some("trace-1"),
    )
  let options =
    logging.options("context-test", "gleam", fn() { "id-1" }, fn() {
      "2026-01-02T03:04:05.000Z"
    })
  let logger = logging.new(options, logging.noop_transport())
  let record =
    log_context.with_log_context(context, fn() {
      let assert Some(captured) = log_context.capture()
      captured.trace_id |> should.equal(Some("trace-1"))
      log_context.info(logger, "hello", [json.string("hello")])
      |> logging.record
    })
  log_context.current() |> should.equal(None)
  record.trace_id |> should.equal(Some("trace-1"))
  record.logged_in_user |> should.equal(Some([#("id", json.string("u1"))]))
}

pub fn shutdown_is_drain_then_force_test() {
  let subject = process.new_subject()
  let coordinator = shutdown.new(fn(event) { process.send(subject, event) })
  shutdown.request(coordinator, shutdown.Sigint, True)
  |> should.equal(shutdown.Drain)
  shutdown.phase(coordinator) |> should.equal(shutdown.Draining)
  shutdown.request(coordinator, shutdown.StdinEof, True)
  |> should.equal(shutdown.Force)
  shutdown.phase(coordinator) |> should.equal(shutdown.Forcing)
  shutdown.mark_stopped(coordinator, shutdown.StdinEof, True)
  shutdown.phase(coordinator) |> should.equal(shutdown.Stopped)

  let assert Ok(first) = process.receive(subject, within: 1000)
  first.phase |> should.equal(shutdown.Draining)
  let assert Ok(second) = process.receive(subject, within: 1000)
  second.phase |> should.equal(shutdown.Forcing)
}
