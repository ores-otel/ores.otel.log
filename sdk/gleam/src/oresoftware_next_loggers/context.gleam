//// Process-local logging context for the BEAM.
////
//// Erlang process dictionary storage is intentionally hidden behind this
//// typed API. New BEAM processes do not inherit process dictionary values, so
//// capture the frame and use `start_with_log_context` when spawning work.

import gleam/erlang/process
import gleam/json.{type Json}
import gleam/option.{type Option, None, Some}
import oresoftware_next_loggers as logging

pub type LogContext {
  LogContext(
    fields: logging.JsonObject,
    logged_in_user: Option(logging.JsonObject),
    users: List(logging.JsonObject),
    trace_id: Option(String),
    trace_ids: List(String),
    routine_id: Option(String),
    tags: List(String),
    context: List(Json),
    meta: List(Json),
  )
}

@external(erlang, "next_loggers_context_ffi", "get")
fn ffi_get() -> Option(LogContext)

@external(erlang, "next_loggers_context_ffi", "with_context")
fn ffi_with_context(context: LogContext, callback: fn() -> value) -> value

pub fn empty() -> LogContext {
  LogContext(
    fields: [],
    logged_in_user: None,
    users: [],
    trace_id: None,
    trace_ids: [],
    routine_id: None,
    tags: [],
    context: [],
    meta: [],
  )
}

pub fn current() -> Option(LogContext) {
  ffi_get()
}

/// Captures the current process frame for a message, callback, or new process.
pub fn capture() -> Option(LogContext) {
  current()
}

/// Enters an exact nested frame and restores the previous frame even if the
/// callback raises in Erlang code.
pub fn with_log_context(context: LogContext, callback: fn() -> value) -> value {
  ffi_with_context(context, callback)
}

/// Re-enters a captured frame. `None` leaves the current process untouched.
pub fn with_captured_log_context(
  captured: Option(LogContext),
  callback: fn() -> value,
) -> value {
  case captured {
    Some(context) -> with_log_context(context, callback)
    None -> callback()
  }
}

/// Starts a linked or unlinked BEAM process with an explicit captured frame.
pub fn start_with_log_context(
  context: LogContext,
  linked: Bool,
  callback: fn() -> value,
) -> process.Pid {
  let run = fn() { with_log_context(context, callback) }
  case linked {
    True -> process.spawn(run)
    False -> process.spawn_unlinked(run)
  }
}

pub fn merge(base: LogContext, patch: LogContext) -> LogContext {
  let LogContext(
    fields: base_fields,
    logged_in_user: base_user,
    users: base_users,
    trace_id: base_trace,
    trace_ids: base_traces,
    routine_id: base_routine,
    tags: base_tags,
    context: base_context,
    meta: base_meta,
  ) = base
  let LogContext(
    fields: patch_fields,
    logged_in_user: patch_user,
    users: patch_users,
    trace_id: patch_trace,
    trace_ids: patch_traces,
    routine_id: patch_routine,
    tags: patch_tags,
    context: patch_context,
    meta: patch_meta,
  ) = patch

  LogContext(
    fields: append_unique_fields(base_fields, patch_fields),
    logged_in_user: merge_optional_fields(base_user, patch_user),
    users: list_append(base_users, patch_users),
    trace_id: prefer_option(base_trace, patch_trace),
    trace_ids: append_unique_strings(
      append_optional_string(base_traces, base_trace),
      append_optional_string(patch_traces, patch_trace),
    ),
    routine_id: prefer_option(base_routine, patch_routine),
    tags: append_unique_strings(base_tags, patch_tags),
    context: list_append(base_context, patch_context),
    meta: list_append(base_meta, patch_meta),
  )
}

pub fn with_merged_log_context(
  patch: LogContext,
  callback: fn() -> value,
) -> value {
  let next = case current() {
    Some(base) -> merge(base, patch)
    None -> patch
  }
  with_log_context(next, callback)
}

pub fn apply(event: logging.LogEvent, context: LogContext) -> logging.LogEvent {
  let LogContext(
    fields:,
    logged_in_user:,
    users:,
    trace_id:,
    trace_ids:,
    routine_id:,
    tags:,
    context: context_values,
    meta: meta_values,
  ) = context

  let event = logging.add_fields(event, fields)
  let event = case logged_in_user {
    Some(user) -> logging.set_logged_in_user(event, user)
    None -> event
  }
  let event = add_users(event, users)
  let event = case trace_id {
    Some(value) -> logging.add_trace(event, value)
    None -> event
  }
  let event = add_traces(event, trace_ids)
  let event = case routine_id {
    Some(value) -> logging.add_routine_id(event, value)
    None -> event
  }
  let event = logging.add_tags(event, tags)
  let event = add_context_values(event, context_values)
  add_meta_values(event, meta_values)
}

pub fn apply_current(event: logging.LogEvent) -> logging.LogEvent {
  case current() {
    Some(context) -> apply(event, context)
    None -> event
  }
}

pub fn trace(
  logger: logging.Logger,
  message: String,
  values: List(Json),
) -> logging.LogEvent {
  logging.trace(logger, message, values) |> apply_current
}

pub fn debug(
  logger: logging.Logger,
  message: String,
  values: List(Json),
) -> logging.LogEvent {
  logging.debug(logger, message, values) |> apply_current
}

pub fn info(
  logger: logging.Logger,
  message: String,
  values: List(Json),
) -> logging.LogEvent {
  logging.info(logger, message, values) |> apply_current
}

pub fn warn(
  logger: logging.Logger,
  message: String,
  values: List(Json),
) -> logging.LogEvent {
  logging.warn(logger, message, values) |> apply_current
}

pub fn error(
  logger: logging.Logger,
  message: String,
  values: List(Json),
) -> logging.LogEvent {
  logging.error(logger, message, values) |> apply_current
}

pub fn fatal(
  logger: logging.Logger,
  message: String,
  values: List(Json),
) -> logging.LogEvent {
  logging.fatal(logger, message, values) |> apply_current
}

fn add_users(
  event: logging.LogEvent,
  users: List(logging.JsonObject),
) -> logging.LogEvent {
  case users {
    [] -> event
    [first, ..rest] -> add_users(logging.add_user(event, first), rest)
  }
}

fn add_traces(
  event: logging.LogEvent,
  traces: List(String),
) -> logging.LogEvent {
  case traces {
    [] -> event
    [first, ..rest] -> add_traces(logging.add_trace(event, first), rest)
  }
}

fn add_context_values(
  event: logging.LogEvent,
  values: List(Json),
) -> logging.LogEvent {
  case values {
    [] -> event
    [first, ..rest] ->
      add_context_values(logging.add_context(event, first), rest)
  }
}

fn add_meta_values(
  event: logging.LogEvent,
  values: List(Json),
) -> logging.LogEvent {
  case values {
    [] -> event
    [first, ..rest] -> add_meta_values(logging.add_meta(event, first), rest)
  }
}

fn prefer_option(base: Option(value), patch: Option(value)) -> Option(value) {
  case patch {
    Some(value) -> Some(value)
    None -> base
  }
}

fn merge_optional_fields(
  base: Option(logging.JsonObject),
  patch: Option(logging.JsonObject),
) -> Option(logging.JsonObject) {
  case #(base, patch) {
    #(None, None) -> None
    #(Some(value), None) -> Some(value)
    #(None, Some(value)) -> Some(value)
    #(Some(left), Some(right)) -> Some(append_unique_fields(left, right))
  }
}

fn append_optional_string(
  values: List(String),
  value: Option(String),
) -> List(String) {
  case value {
    Some(value) -> append_unique_strings(values, [value])
    None -> values
  }
}

fn append_unique_strings(
  base: List(String),
  patch: List(String),
) -> List(String) {
  case patch {
    [] -> base
    [first, ..rest] -> {
      let next = case string_member(base, first) {
        True -> base
        False -> list_append(base, [first])
      }
      append_unique_strings(next, rest)
    }
  }
}

fn append_unique_fields(
  base: logging.JsonObject,
  patch: logging.JsonObject,
) -> logging.JsonObject {
  case patch {
    [] -> base
    [#(key, value), ..rest] ->
      append_unique_fields(replace_field(base, key, value), rest)
  }
}

fn replace_field(
  fields: logging.JsonObject,
  key: String,
  value: Json,
) -> logging.JsonObject {
  case fields {
    [] -> [#(key, value)]
    [#(current_key, current_value), ..rest] ->
      case current_key == key {
        True -> [#(key, value), ..rest]
        False -> [
          #(current_key, current_value),
          ..replace_field(rest, key, value)
        ]
      }
  }
}

fn string_member(values: List(String), needle: String) -> Bool {
  case values {
    [] -> False
    [first, ..rest] ->
      case first == needle {
        True -> True
        False -> string_member(rest, needle)
      }
  }
}

fn list_append(left: List(value), right: List(value)) -> List(value) {
  case left {
    [] -> right
    [first, ..rest] -> [first, ..list_append(rest, right)]
  }
}
