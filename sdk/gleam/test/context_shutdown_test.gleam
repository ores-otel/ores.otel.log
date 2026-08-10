import gleam/erlang/process
import gleam/json
import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import oresoftware_next_loggers as logging
import oresoftware_next_loggers/context as legacy_context
import oresoftware_next_loggers/shutdown as legacy_shutdown
import oresoftware_next_loggers_context as context
import oresoftware_next_loggers_shutdown as shutdown

pub fn main() {
  gleeunit.main()
}

fn logger() -> logging.Logger {
  logging.new(
    logging.options("context-test", "gleam", fn() { "record-1" }, fn() {
      "2026-01-02T03:04:05.000Z"
    }),
    logging.noop_transport(),
  )
}

pub fn process_local_context_applies_user_trace_and_routine_test() {
  let value =
    context.LogContext(
      ..context.new(),
      logged_in_user: Some([#("id", json.string("user-1"))]),
      fields: [#("request.id", json.string("req-1"))],
      trace_id: Some("trace-1"),
      trace_ids: ["trace-1", "trace-2"],
      span_id: Some("span-1"),
      trace_flags: Some(1),
      routine_id: Some("handler"),
      tags: ["http"],
    )

  context.with_context(value, fn() {
    let event = context.info(logger(), "hello", [json.string("hello")])
    let record = logging.record(event)
    record.logged_in_user
    |> should.equal(Some([#("id", json.string("user-1"))]))
    record.trace_id |> should.equal(Some("trace-1"))
    record.trace_ids |> should.equal(["trace-1", "trace-2"])
    record.routine_id |> should.equal(Some("handler"))
    record.fields
    |> should.equal([
      #("request.id", json.string("req-1")),
      #("otel.span_id", json.string("span-1")),
      #("otel.trace_flags", json.int(1)),
    ])
  })

  context.current_context() |> should.equal(None)
}

pub fn nested_context_merges_and_restores_test() {
  let outer =
    context.LogContext(
      ..context.new(),
      logged_in_user: Some([#("id", json.string("outer"))]),
      tags: ["outer"],
    )
  let inner =
    context.LogContext(
      ..context.new(),
      logged_in_user: Some([#("role", json.string("admin"))]),
      tags: ["inner"],
    )

  context.with_context(outer, fn() {
    context.with_context(inner, fn() {
      let assert Some(current) = context.current_context()
      current.logged_in_user
      |> should.equal(
        Some([
          #("id", json.string("outer")),
          #("role", json.string("admin")),
        ]),
      )
      current.tags |> should.equal(["outer", "inner"])
    })
    let assert Some(current) = context.current_context()
    current.logged_in_user
    |> should.equal(Some([#("id", json.string("outer"))]))
  })
}

pub fn explicit_zero_trace_flags_override_parent_test() {
  let parent = context.LogContext(..context.new(), trace_flags: Some(1))
  let child = context.LogContext(..context.new(), trace_flags: Some(0))
  context.merge(parent, child).trace_flags
  |> should.equal(Some(0))
}

pub fn shutdown_transition_contract_test() {
  let state = shutdown.new(True)
  let #(state, first) = shutdown.trigger(state, shutdown.Sigint)
  first |> should.equal(shutdown.BeginGraceful)
  shutdown.phase(state) |> should.equal(shutdown.Draining)
  let #(state, second) = shutdown.trigger(state, shutdown.StdinEof)
  second |> should.equal(shutdown.Force)
  shutdown.phase(state) |> should.equal(shutdown.Forced)
  let #(_, ignored) = shutdown.trigger(state, shutdown.Sigterm)
  ignored |> should.equal(shutdown.Ignore)
}

pub fn legacy_process_context_is_scoped_and_applied_test() {
  let value =
    legacy_context.LogContext(
      ..legacy_context.empty(),
      fields: [#("request.id", json.string("r1"))],
      logged_in_user: Some([#("id", json.string("u1"))]),
      trace_id: Some("trace-1"),
    )
  let record =
    legacy_context.with_log_context(value, fn() {
      let assert Some(captured) = legacy_context.capture()
      captured.trace_id |> should.equal(Some("trace-1"))
      legacy_context.info(logger(), "hello", [json.string("hello")])
      |> logging.record
    })
  legacy_context.current() |> should.equal(None)
  record.trace_id |> should.equal(Some("trace-1"))
  record.logged_in_user
  |> should.equal(Some([#("id", json.string("u1"))]))
}

pub fn legacy_shutdown_coordinator_contract_test() {
  let subject = process.new_subject()
  let coordinator =
    legacy_shutdown.new(fn(event) { process.send(subject, event) })
  legacy_shutdown.request(coordinator, legacy_shutdown.Sigint, True)
  |> should.equal(legacy_shutdown.Drain)
  legacy_shutdown.phase(coordinator) |> should.equal(legacy_shutdown.Draining)
  legacy_shutdown.request(coordinator, legacy_shutdown.StdinEof, True)
  |> should.equal(legacy_shutdown.Force)
  legacy_shutdown.phase(coordinator) |> should.equal(legacy_shutdown.Forcing)
  legacy_shutdown.mark_stopped(coordinator, legacy_shutdown.StdinEof, True)
  legacy_shutdown.phase(coordinator) |> should.equal(legacy_shutdown.Stopped)

  let assert Ok(first) = process.receive(subject, within: 1000)
  first.phase |> should.equal(legacy_shutdown.Draining)
  let assert Ok(second) = process.receive(subject, within: 1000)
  second.phase |> should.equal(legacy_shutdown.Forcing)
}
