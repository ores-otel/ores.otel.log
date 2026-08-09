import gleam/erlang/process.{type Subject}
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor

pub const schema = "next-loggers/v1"

pub type Level {
  Trace
  Debug
  Info
  Warn
  ErrorLevel
  Fatal
}

pub type JsonObject =
  List(#(String, Json))

pub type LogRecord {
  LogRecord(
    schema: String,
    id: String,
    timestamp: String,
    level: Level,
    runtime: String,
    app_name: String,
    message: String,
    values: List(Json),
    fields: JsonObject,
    name: Option(String),
    logged_in_user: Option(JsonObject),
    users: List(JsonObject),
    trace_id: Option(String),
    trace_ids: List(String),
    routine_id: Option(String),
    tags: List(String),
    context: List(Json),
    meta: List(Json),
    errors: List(Json),
    stack_trace: List(String),
  )
}

pub type OtelLogRecord {
  OtelLogRecord(
    body: String,
    severity_text: String,
    severity_number: Int,
    timestamp: String,
    attributes: JsonObject,
  )
}

pub type Transport {
  Transport(
    write: fn(LogRecord) -> Result(Nil, String),
    flush: fn() -> Result(Nil, String),
    flush_on_exit: fn(List(LogRecord)) -> Result(Nil, String),
    close: fn() -> Result(Nil, String),
  )
}

pub type Options {
  Options(
    app_name: String,
    runtime: String,
    name: Option(String),
    minimum_level: Level,
    fields: JsonObject,
    id_generator: fn() -> String,
    clock: fn() -> String,
  )
}

pub opaque type Logger {
  Logger(subject: Subject(Message), options: Options)
}

pub opaque type LogEvent {
  LogEvent(subject: Subject(Message), record: LogRecord, sent: Bool)
}

type State {
  State(
    transport: Transport,
    pending: List(LogRecord),
    closed: Bool,
    minimum_level: Level,
  )
}

type Message {
  Track(LogRecord)
  Update(LogRecord)
  Send(LogRecord, Bool, Subject(Result(Bool, String)))
  Flush(Subject(Result(Nil, String)))
  FlushOnExit(Subject(Result(Nil, String)))
  Close(Subject(Result(Nil, String)))
}

pub fn options(
  app_name: String,
  runtime: String,
  id_generator: fn() -> String,
  clock: fn() -> String,
) -> Options {
  Options(
    app_name:,
    runtime:,
    name: None,
    minimum_level: Info,
    fields: [],
    id_generator:,
    clock:,
  )
}

pub fn noop_transport() -> Transport {
  Transport(
    write: fn(_) { Ok(Nil) },
    flush: fn() { Ok(Nil) },
    flush_on_exit: fn(_) { Ok(Nil) },
    close: fn() { Ok(Nil) },
  )
}

/// Adapt records to an application-owned OpenTelemetry emitter without
/// installing a global provider or automatic instrumentation.
pub fn otel_transport(
  sink: fn(OtelLogRecord) -> Result(Nil, String),
) -> Transport {
  Transport(
    write: fn(record) { sink(to_otel_record(record)) },
    flush: fn() { Ok(Nil) },
    flush_on_exit: fn(_) { Ok(Nil) },
    close: fn() { Ok(Nil) },
  )
}

/// Delegate records to an application-owned authenticated Supabase sender.
pub fn supabase_transport(
  sender: fn(LogRecord) -> Result(Nil, String),
) -> Transport {
  Transport(
    write: sender,
    flush: fn() { Ok(Nil) },
    flush_on_exit: fn(_) { Ok(Nil) },
    close: fn() { Ok(Nil) },
  )
}

pub fn to_otel_record(record: LogRecord) -> OtelLogRecord {
  let base_attributes = [
    #("service.name", json.string(record.app_name)),
    #("next_logger.schema", json.string(record.schema)),
    #("next_logger.runtime", json.string(record.runtime)),
    #("log.record.uid", json.string(record.id)),
  ]
  let correlated = optional_string(base_attributes, "trace.id", record.trace_id)
  let attributes = otel_field_attributes(record.fields, correlated)
  OtelLogRecord(
    body: record.message,
    severity_text: level_name(record.level),
    severity_number: otel_severity_number(record.level),
    timestamp: record.timestamp,
    attributes:,
  )
}

pub fn new(options options: Options, transport transport: Transport) -> Logger {
  let assert Ok(started) =
    actor.new(State(
      transport:,
      pending: [],
      closed: False,
      minimum_level: options.minimum_level,
    ))
    |> actor.on_message(handle_message)
    |> actor.start

  Logger(subject: started.data, options:)
}

pub fn trace(logger: Logger, message: String, values: List(Json)) -> LogEvent {
  event(logger, Trace, message, values)
}

pub fn debug(logger: Logger, message: String, values: List(Json)) -> LogEvent {
  event(logger, Debug, message, values)
}

pub fn info(logger: Logger, message: String, values: List(Json)) -> LogEvent {
  event(logger, Info, message, values)
}

pub fn warn(logger: Logger, message: String, values: List(Json)) -> LogEvent {
  event(logger, Warn, message, values)
}

pub fn error(logger: Logger, message: String, values: List(Json)) -> LogEvent {
  event(logger, ErrorLevel, message, values)
}

pub fn fatal(logger: Logger, message: String, values: List(Json)) -> LogEvent {
  event(logger, Fatal, message, values)
}

fn event(
  logger: Logger,
  level: Level,
  message: String,
  values: List(Json),
) -> LogEvent {
  let Logger(subject:, options:) = logger
  let Options(app_name:, runtime:, name:, fields:, id_generator:, clock:, ..) =
    options
  let record =
    LogRecord(
      schema:,
      id: id_generator(),
      timestamp: clock(),
      level:,
      runtime:,
      app_name:,
      message:,
      values:,
      fields:,
      name:,
      logged_in_user: None,
      users: [],
      trace_id: None,
      trace_ids: [],
      routine_id: None,
      tags: [],
      context: [],
      meta: [],
      errors: [],
      stack_trace: [],
    )
  actor.send(subject, Track(record))
  LogEvent(subject:, record:, sent: False)
}

pub fn add_fields(event: LogEvent, fields: JsonObject) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, fields: list.append(record.fields, fields)),
    sent:,
  ))
}

pub fn add_user(event: LogEvent, user: JsonObject) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, users: list.append(record.users, [user])),
    sent:,
  ))
}

pub fn set_logged_in_user(event: LogEvent, user: JsonObject) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, logged_in_user: Some(user)),
    sent:,
  ))
}

pub fn add_trace(event: LogEvent, trace_id: String) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  let first_trace = case record.trace_id {
    Some(value) -> Some(value)
    None -> Some(trace_id)
  }
  update(LogEvent(
    subject:,
    record: LogRecord(
      ..record,
      trace_id: first_trace,
      trace_ids: list.append(record.trace_ids, [trace_id]),
    ),
    sent:,
  ))
}

pub fn add_routine_id(event: LogEvent, routine_id: String) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, routine_id: Some(routine_id)),
    sent:,
  ))
}

pub fn add_tags(event: LogEvent, tags: List(String)) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, tags: list.append(record.tags, tags)),
    sent:,
  ))
}

pub fn add_context(event: LogEvent, value: Json) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, context: list.append(record.context, [value])),
    sent:,
  ))
}

pub fn add_meta(event: LogEvent, value: Json) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, meta: list.append(record.meta, [value])),
    sent:,
  ))
}

pub fn add_error(event: LogEvent, value: Json) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(..record, errors: list.append(record.errors, [value])),
    sent:,
  ))
}

pub fn capture_stack_trace(event: LogEvent, stack_trace: String) -> LogEvent {
  let LogEvent(subject:, record:, sent:) = event
  update(LogEvent(
    subject:,
    record: LogRecord(
      ..record,
      stack_trace: list.append(record.stack_trace, [stack_trace]),
    ),
    sent:,
  ))
}

fn update(event: LogEvent) -> LogEvent {
  let LogEvent(subject:, record:, ..) = event
  actor.send(subject, Update(record))
  event
}

pub fn send(event: LogEvent) -> Result(LogEvent, String) {
  send_with_store(event, True)
}

pub fn send_with_store(event: LogEvent, store: Bool) -> Result(LogEvent, String) {
  let LogEvent(subject:, record:, sent:) = event
  case sent {
    True -> Ok(event)
    False -> {
      case actor.call(subject, 5000, Send(record, store, _)) {
        Ok(was_sent) -> Ok(LogEvent(subject:, record:, sent: was_sent))
        Error(reason) -> Error(reason)
      }
    }
  }
}

pub fn record(event: LogEvent) -> LogRecord {
  let LogEvent(record:, ..) = event
  record
}

pub fn flush(logger: Logger) -> Result(Nil, String) {
  let Logger(subject:, ..) = logger
  actor.call(subject, 5000, Flush)
}

pub fn flush_on_exit(logger: Logger) -> Result(Nil, String) {
  let Logger(subject:, ..) = logger
  actor.call(subject, 5000, FlushOnExit)
}

pub fn close(logger: Logger) -> Result(Nil, String) {
  let Logger(subject:, ..) = logger
  actor.call(subject, 5000, Close)
}

pub fn encode_record(record: LogRecord) -> Json {
  let base = [
    #("schema", json.string(record.schema)),
    #("id", json.string(record.id)),
    #("timestamp", json.string(record.timestamp)),
    #("level", json.string(level_name(record.level))),
    #("runtime", json.string(record.runtime)),
    #("appName", json.string(record.app_name)),
    #("message", json.string(record.message)),
    #("values", json.preprocessed_array(record.values)),
    #("fields", json.object(record.fields)),
  ]
  let with_name = optional_string(base, "name", record.name)
  let with_logged_in_user =
    optional_json_object(with_name, "loggedInUser", record.logged_in_user)
  let with_users =
    optional_json_object_list(with_logged_in_user, "users", record.users)
  let with_trace_id = optional_string(with_users, "traceId", record.trace_id)
  let with_trace_ids =
    optional_string_list(with_trace_id, "traceIds", record.trace_ids)
  let with_routine_id =
    optional_string(with_trace_ids, "routineId", record.routine_id)
  let with_tags = optional_string_list(with_routine_id, "tags", record.tags)
  let with_context = optional_json_list(with_tags, "context", record.context)
  let with_meta = optional_json_list(with_context, "meta", record.meta)
  let with_errors = optional_json_list(with_meta, "errors", record.errors)
  let complete =
    optional_string_list(with_errors, "stackTrace", record.stack_trace)
  json.object(complete)
}

pub fn record_to_string(record: LogRecord) -> String {
  record |> encode_record |> json.to_string
}

pub fn level_name(level: Level) -> String {
  case level {
    Trace -> "TRACE"
    Debug -> "DEBUG"
    Info -> "INFO"
    Warn -> "WARN"
    ErrorLevel -> "ERROR"
    Fatal -> "FATAL"
  }
}

pub fn otel_severity_number(level: Level) -> Int {
  case level {
    Trace -> 1
    Debug -> 5
    Info -> 9
    Warn -> 13
    ErrorLevel -> 17
    Fatal -> 21
  }
}

fn otel_field_attributes(
  fields: JsonObject,
  attributes: JsonObject,
) -> JsonObject {
  case fields {
    [] -> attributes
    [#(key, value), ..rest] ->
      otel_field_attributes(
        rest,
        list.append(attributes, [#("next_logger.field." <> key, value)]),
      )
  }
}

fn handle_message(state: State, message: Message) -> actor.Next(State, Message) {
  let State(transport:, pending:, closed:, minimum_level:) = state
  case message {
    Track(record) ->
      actor.continue(State(..state, pending: [record, ..pending]))
    Update(record) ->
      actor.continue(State(..state, pending: replace_record(pending, record)))
    Send(record, store, reply) -> {
      case closed {
        True -> {
          process.send(reply, Error("logger is closed"))
          actor.continue(state)
        }
        False -> {
          let enabled = level_rank(record.level) >= level_rank(minimum_level)
          case store && enabled {
            False -> {
              process.send(reply, Ok(True))
              actor.continue(
                State(..state, pending: remove_record(pending, record.id)),
              )
            }
            True -> {
              case transport.write(record) {
                Ok(Nil) -> {
                  process.send(reply, Ok(True))
                  actor.continue(
                    State(..state, pending: remove_record(pending, record.id)),
                  )
                }
                Error(reason) -> {
                  process.send(reply, Error(reason))
                  actor.continue(
                    State(..state, pending: replace_record(pending, record)),
                  )
                }
              }
            }
          }
        }
      }
    }
    Flush(reply) -> {
      let result = transport.flush()
      process.send(reply, result)
      actor.continue(state)
    }
    FlushOnExit(reply) -> {
      let result = drain(transport, pending)
      process.send(reply, result)
      case result {
        Ok(Nil) -> actor.continue(State(..state, pending: []))
        Error(_) -> actor.continue(state)
      }
    }
    Close(reply) -> {
      let result = case drain(transport, pending) {
        Error(reason) -> Error(reason)
        Ok(Nil) -> transport.close()
      }
      process.send(reply, result)
      actor.stop()
    }
  }
}

fn drain(transport: Transport, records: List(LogRecord)) -> Result(Nil, String) {
  case write_all(transport, list.reverse(records)) {
    Error(reason) -> Error(reason)
    Ok(Nil) -> {
      case transport.flush_on_exit(list.reverse(records)) {
        Error(reason) -> Error(reason)
        Ok(Nil) -> transport.flush()
      }
    }
  }
}

fn write_all(
  transport: Transport,
  records: List(LogRecord),
) -> Result(Nil, String) {
  case records {
    [] -> Ok(Nil)
    [first, ..rest] -> {
      case transport.write(first) {
        Error(reason) -> Error(reason)
        Ok(Nil) -> write_all(transport, rest)
      }
    }
  }
}

fn replace_record(records: List(LogRecord), replacement: LogRecord) {
  records
  |> list.map(fn(record) {
    case record.id == replacement.id {
      True -> replacement
      False -> record
    }
  })
}

fn remove_record(records: List(LogRecord), id: String) {
  records |> list.filter(fn(record) { record.id != id })
}

fn level_rank(level: Level) -> Int {
  case level {
    Trace -> 0
    Debug -> 1
    Info -> 2
    Warn -> 3
    ErrorLevel -> 4
    Fatal -> 5
  }
}

fn optional_string(
  entries: List(#(String, Json)),
  key: String,
  value: Option(String),
) {
  case value {
    Some(value) -> list.append(entries, [#(key, json.string(value))])
    None -> entries
  }
}

fn optional_json_object(
  entries: List(#(String, Json)),
  key: String,
  value: Option(JsonObject),
) {
  case value {
    Some(value) -> list.append(entries, [#(key, json.object(value))])
    None -> entries
  }
}

fn optional_string_list(
  entries: List(#(String, Json)),
  key: String,
  values: List(String),
) {
  case values {
    [] -> entries
    _ ->
      list.append(entries, [
        #(key, json.array(values, of: json.string)),
      ])
  }
}

fn optional_json_list(
  entries: List(#(String, Json)),
  key: String,
  values: List(Json),
) {
  case values {
    [] -> entries
    _ ->
      list.append(entries, [
        #(key, json.preprocessed_array(values)),
      ])
  }
}

fn optional_json_object_list(
  entries: List(#(String, Json)),
  key: String,
  values: List(JsonObject),
) {
  case values {
    [] -> entries
    _ ->
      list.append(entries, [
        #(key, json.array(values, of: json.object)),
      ])
  }
}
