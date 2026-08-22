import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import oresoftware_next_loggers as core

/// BEAM-native process-local logging context. Process dictionary storage is
/// scoped by `with_context`, restored in an Erlang `after` block, and never
/// inherited by spawned processes; pass or install a context explicitly when
/// crossing a process boundary.
pub type LogContext {
  LogContext(
    logged_in_user: Option(core.JsonObject),
    users: List(core.JsonObject),
    fields: core.JsonObject,
    trace_id: Option(String),
    trace_ids: List(String),
    span_id: Option(String),
    trace_flags: Option(Int),
    trace_state: Option(String),
    baggage: core.JsonObject,
    routine_id: Option(String),
    tags: List(String),
    context: List(Json),
    meta: List(Json),
  )
}

pub fn new() -> LogContext {
  LogContext(
    logged_in_user: None,
    users: [],
    fields: [],
    trace_id: None,
    trace_ids: [],
    span_id: None,
    trace_flags: None,
    trace_state: None,
    baggage: [],
    routine_id: None,
    tags: [],
    context: [],
    meta: [],
  )
}

fn remove_key(fields: core.JsonObject, key: String) -> core.JsonObject {
  list.filter(fields, fn(entry) {
    let #(candidate, _) = entry
    candidate != key
  })
}

fn merge_object(
  base: core.JsonObject,
  patch: core.JsonObject,
) -> core.JsonObject {
  list.fold(patch, base, fn(merged, entry) {
    let #(key, _) = entry
    list.append(remove_key(merged, key), [entry])
  })
}

fn append_unique(values: List(String), value: String) -> List(String) {
  case value == "" || list.contains(values, value) {
    True -> values
    False -> list.append(values, [value])
  }
}

fn append_unique_all(
  values: List(String),
  additions: List(String),
) -> List(String) {
  list.fold(additions, values, append_unique)
}

fn merge_user(
  base: Option(core.JsonObject),
  patch: Option(core.JsonObject),
) -> Option(core.JsonObject) {
  case base, patch {
    None, None -> None
    Some(value), None -> Some(value)
    None, Some(value) -> Some(value)
    Some(parent), Some(value) -> Some(merge_object(parent, value))
  }
}

fn first_option(values: List(a)) -> Option(a) {
  case values {
    [first, ..] -> Some(first)
    [] -> None
  }
}

pub fn merge(base: LogContext, patch: LogContext) -> LogContext {
  let traces = case base.trace_id {
    Some(value) -> append_unique(base.trace_ids, value)
    None -> base.trace_ids
  }
  let traces = case patch.trace_id {
    Some(value) -> append_unique(traces, value)
    None -> traces
  }
  let traces = append_unique_all(traces, patch.trace_ids)
  let primary_trace = case patch.trace_id {
    Some(value) -> Some(value)
    None ->
      case base.trace_id {
        Some(value) -> Some(value)
        None -> first_option(traces)
      }
  }
  LogContext(
    logged_in_user: merge_user(base.logged_in_user, patch.logged_in_user),
    users: list.append(base.users, patch.users),
    fields: merge_object(base.fields, patch.fields),
    trace_id: primary_trace,
    trace_ids: traces,
    span_id: case patch.span_id {
      Some(value) -> Some(value)
      None -> base.span_id
    },
    trace_flags: case patch.trace_flags {
      Some(value) -> Some(value)
      None -> base.trace_flags
    },
    trace_state: case patch.trace_state {
      Some(value) -> Some(value)
      None -> base.trace_state
    },
    baggage: merge_object(base.baggage, patch.baggage),
    routine_id: case patch.routine_id {
      Some(value) -> Some(value)
      None -> base.routine_id
    },
    tags: append_unique_all(base.tags, patch.tags),
    context: list.append(base.context, patch.context),
    meta: list.append(base.meta, patch.meta),
  )
}

@external(erlang, "oresoftware_next_loggers_context_ffi", "current")
fn ffi_current() -> Result(LogContext, Nil)

@external(erlang, "oresoftware_next_loggers_context_ffi", "set_current")
fn ffi_set_current(context: LogContext) -> Nil

@external(erlang, "oresoftware_next_loggers_context_ffi", "clear_current")
fn ffi_clear_current() -> Nil

@external(erlang, "oresoftware_next_loggers_context_ffi", "with_context")
fn ffi_with_context(context: LogContext, callback: fn() -> a) -> a

pub fn current_context() -> Option(LogContext) {
  case ffi_current() {
    Ok(context) -> Some(context)
    Error(Nil) -> None
  }
}

pub fn current_logged_in_user() -> Option(core.JsonObject) {
  case current_context() {
    Some(context) -> context.logged_in_user
    None -> None
  }
}

pub fn set_current(context: LogContext) -> Nil {
  ffi_set_current(context)
}

pub fn clear_current() -> Nil {
  ffi_clear_current()
}

pub fn with_context(context: LogContext, callback: fn() -> a) -> a {
  let inherited = case current_context() {
    Some(parent) -> merge(parent, context)
    None -> context
  }
  ffi_with_context(inherited, callback)
}

pub fn update_current(patch: LogContext) -> Bool {
  case current_context() {
    Some(context) -> {
      set_current(merge(context, patch))
      True
    }
    None -> False
  }
}

fn contextual_fields(context: LogContext) -> core.JsonObject {
  let fields = case context.span_id {
    Some(value) ->
      merge_object(context.fields, [#("otel.span_id", json.string(value))])
    None -> context.fields
  }
  let fields = case context.trace_flags {
    Some(value) ->
      merge_object(fields, [#("otel.trace_flags", json.int(value))])
    None -> fields
  }
  let fields = case context.trace_state {
    Some(value) ->
      merge_object(fields, [#("otel.trace_state", json.string(value))])
    None -> fields
  }
  case context.baggage {
    [] -> fields
    values -> merge_object(fields, [#("otel.baggage", json.object(values))])
  }
}

pub fn apply(event: core.LogEvent, context: LogContext) -> core.LogEvent {
  let event = core.add_fields(event, contextual_fields(context))
  let event = case context.logged_in_user {
    Some(user) -> core.set_logged_in_user(event, user)
    None -> event
  }
  let event =
    list.fold(context.users, event, fn(event, user) {
      core.add_user(event, user)
    })
  let traces = case context.trace_id {
    Some(value) -> append_unique([], value)
    None -> []
  }
  let traces = append_unique_all(traces, context.trace_ids)
  let event =
    list.fold(traces, event, fn(event, trace_id) {
      core.add_trace(event, trace_id)
    })
  let event = case context.routine_id {
    Some(value) -> core.add_routine_id(event, value)
    None -> event
  }
  let event = core.add_tags(event, context.tags)
  let event =
    list.fold(context.context, event, fn(event, value) {
      core.add_context(event, value)
    })
  list.fold(context.meta, event, fn(event, value) {
    core.add_meta(event, value)
  })
}

pub fn apply_current(event: core.LogEvent) -> core.LogEvent {
  case current_context() {
    Some(context) -> apply(event, context)
    None -> event
  }
}

pub fn trace(
  logger: core.Logger,
  message: String,
  values: List(Json),
) -> core.LogEvent {
  core.trace(logger, message, values) |> apply_current
}

pub fn debug(
  logger: core.Logger,
  message: String,
  values: List(Json),
) -> core.LogEvent {
  core.debug(logger, message, values) |> apply_current
}

pub fn info(
  logger: core.Logger,
  message: String,
  values: List(Json),
) -> core.LogEvent {
  core.info(logger, message, values) |> apply_current
}

pub fn warn(
  logger: core.Logger,
  message: String,
  values: List(Json),
) -> core.LogEvent {
  core.warn(logger, message, values) |> apply_current
}

pub fn error(
  logger: core.Logger,
  message: String,
  values: List(Json),
) -> core.LogEvent {
  core.error(logger, message, values) |> apply_current
}

pub fn fatal(
  logger: core.Logger,
  message: String,
  values: List(Json),
) -> core.LogEvent {
  core.fatal(logger, message, values) |> apply_current
}
