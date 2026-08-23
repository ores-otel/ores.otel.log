import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import oresoftware_next_loggers as logging
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

pub fn first_tty_sigint_arms_eof_and_eof_forces_test() {
  let state = shutdown.new(True)
  let #(state, first) = shutdown.trigger(state, shutdown.Sigint)
  first |> should.equal(shutdown.BeginGraceful)
  shutdown.phase(state) |> should.equal(shutdown.Draining)
  shutdown.eof_armed(state) |> should.equal(True)
  shutdown.signal_count(state) |> should.equal(1)

  let #(state, second) = shutdown.trigger(state, shutdown.StdinEof)
  second |> should.equal(shutdown.Force)
  shutdown.phase(state) |> should.equal(shutdown.Forced)
  shutdown.signal_count(state) |> should.equal(1)
}

pub fn initial_eof_is_ignored_test() {
  let state = shutdown.new(True)
  let #(state, action) = shutdown.trigger(state, shutdown.StdinEof)
  action |> should.equal(shutdown.Ignore)
  shutdown.phase(state) |> should.equal(shutdown.Running)
  shutdown.signal_count(state) |> should.equal(0)
}

pub fn tty_sigterm_does_not_arm_eof_test() {
  let state = shutdown.new(True)
  let #(state, action) = shutdown.trigger(state, shutdown.Sigterm)
  action |> should.equal(shutdown.BeginGraceful)
  shutdown.eof_armed(state) |> should.equal(False)
  shutdown.signal_count(state) |> should.equal(1)

  let #(state, eof_action) = shutdown.trigger(state, shutdown.StdinEof)
  eof_action |> should.equal(shutdown.Ignore)
  shutdown.phase(state) |> should.equal(shutdown.Draining)
}

pub fn non_tty_sigint_does_not_arm_eof_test() {
  let state = shutdown.new(False)
  let #(state, action) = shutdown.trigger(state, shutdown.Sigint)
  action |> should.equal(shutdown.BeginGraceful)
  shutdown.eof_armed(state) |> should.equal(False)

  let #(_, eof_action) = shutdown.trigger(state, shutdown.StdinEof)
  eof_action |> should.equal(shutdown.Ignore)
}

pub fn second_signal_forces_and_counts_two_signals_test() {
  let state = shutdown.new(True)
  let #(state, _) = shutdown.trigger(state, shutdown.Sigint)
  let #(state, action) = shutdown.trigger(state, shutdown.Sigterm)
  action |> should.equal(shutdown.Force)
  shutdown.signal_count(state) |> should.equal(2)
}

pub fn timeout_forces_without_incrementing_signal_count_test() {
  let state = shutdown.new(False)
  let #(state, _) = shutdown.trigger(state, shutdown.Sigterm)
  let #(state, action) = shutdown.timeout(state)
  action |> should.equal(shutdown.Force)
  shutdown.signal_count(state) |> should.equal(1)
}

pub fn formal_shutdown_relation_refines_all_twelve_shared_pairs_test() {
  let cases = [
    #(
      shutdown.Running,
      shutdown.Trigger,
      shutdown.Draining,
      shutdown.ModelBeginGraceful,
    ),
    #(shutdown.Draining, shutdown.Trigger, shutdown.Forced, shutdown.ModelForce),
    #(shutdown.Forced, shutdown.Trigger, shutdown.Forced, shutdown.ModelIgnore),
    #(shutdown.Closed, shutdown.Trigger, shutdown.Closed, shutdown.ModelIgnore),
    #(shutdown.Running, shutdown.ForceNow, shutdown.Forced, shutdown.ModelForce),
    #(
      shutdown.Draining,
      shutdown.ForceNow,
      shutdown.Forced,
      shutdown.ModelForce,
    ),
    #(shutdown.Forced, shutdown.ForceNow, shutdown.Forced, shutdown.ModelIgnore),
    #(shutdown.Closed, shutdown.ForceNow, shutdown.Closed, shutdown.ModelIgnore),
    #(
      shutdown.Running,
      shutdown.MarkClosed,
      shutdown.Running,
      shutdown.ModelIgnore,
    ),
    #(
      shutdown.Draining,
      shutdown.MarkClosed,
      shutdown.Closed,
      shutdown.ModelClose,
    ),
    #(
      shutdown.Forced,
      shutdown.MarkClosed,
      shutdown.Forced,
      shutdown.ModelIgnore,
    ),
    #(
      shutdown.Closed,
      shutdown.MarkClosed,
      shutdown.Closed,
      shutdown.ModelIgnore,
    ),
  ]

  list.each(cases, fn(vector) {
    let #(phase, event, expected_phase, expected_action) = vector
    shutdown.transition(phase, event)
    |> should.equal(shutdown.Transition(expected_phase, expected_action))
  })
}
