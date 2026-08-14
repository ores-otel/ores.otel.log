import gleam/erlang/process
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleeunit
import gleeunit/should
import oresoftware_next_loggers as logging

type Captured {
  Written(logging.LogRecord)
  OtelWritten(logging.OtelLogRecord)
  SupabaseWritten(logging.LogRecord)
  Flushed
  ExitRecords(List(logging.LogRecord))
  Closed
}

type AuditEvent {
  AuditEvent(logging.LogEvent)
}

type SpanCall {
  StatusSet
  ExceptionRecorded
  SpanEnded
}

pub fn main() {
  gleeunit.main()
}

fn transport(subject: process.Subject(Captured)) -> logging.Transport {
  logging.Transport(
    write: fn(record) {
      process.send(subject, Written(record))
      Ok(Nil)
    },
    flush: fn() {
      process.send(subject, Flushed)
      Ok(Nil)
    },
    flush_on_exit: fn(records) {
      process.send(subject, ExitRecords(records))
      Ok(Nil)
    },
    close: fn() {
      process.send(subject, Closed)
      Ok(Nil)
    },
  )
}

fn fixture_options() -> logging.Options {
  let base =
    logging.options(
      "payments",
      "contract-test",
      fn() { "contract-record-1" },
      fn() { "2026-01-02T03:04:05.000Z" },
    )
  logging.Options(..base, name: Some("audit"), fields: [
    #("environment", json.string("test")),
  ])
}

pub fn matches_shared_record_fixture_test() {
  let subject = process.new_subject()
  let logger = logging.new(fixture_options(), transport(subject))
  let event =
    logging.error(logger, "payment failed 42", [
      json.string("payment failed"),
      json.int(42),
    ])
    |> logging.add_fields([#("orderId", json.string("order-42"))])
    |> logging.set_logged_in_user([#("id", json.string("user-1"))])
    |> logging.add_user([#("id", json.string("user-2"))])
    |> logging.add_trace("trace-1")
    |> logging.add_trace("trace-2")
    |> logging.add_routine_id("charge-card")
    |> logging.add_tags(["payments", "critical"])
    |> logging.add_context(json.object([#("attempt", json.int(2))]))
    |> logging.add_meta(json.object([#("source", json.string("fixture"))]))

  let assert Ok(sent) = logging.send(event)
  let assert Ok(Written(record)) = process.receive(subject, within: 1000)
  let expected =
    "{\"schema\":\"next-loggers/v1\",\"id\":\"contract-record-1\",\"timestamp\":\"2026-01-02T03:04:05.000Z\",\"level\":\"ERROR\",\"runtime\":\"contract-test\",\"appName\":\"payments\",\"message\":\"payment failed 42\",\"values\":[\"payment failed\",42],\"fields\":{\"environment\":\"test\",\"orderId\":\"order-42\"},\"name\":\"audit\",\"loggedInUser\":{\"id\":\"user-1\"},\"users\":[{\"id\":\"user-2\"}],\"traceId\":\"trace-1\",\"traceIds\":[\"trace-1\",\"trace-2\"],\"routineId\":\"charge-card\",\"tags\":[\"payments\",\"critical\"],\"context\":[{\"attempt\":2}],\"meta\":[{\"source\":\"fixture\"}]}"

  logging.record_to_string(record)
  |> should.equal(expected)

  let assert Ok(_) = logging.send(sent)
  process.receive(subject, within: 10)
  |> should.equal(Error(Nil))

  let AuditEvent(inner) = AuditEvent(sent)
  logging.record(inner).level
  |> should.equal(logging.ErrorLevel)
}

pub fn shutdown_recovers_unsent_events_test() {
  let subject = process.new_subject()
  let logger = logging.new(fixture_options(), transport(subject))
  let _unsent = logging.warn(logger, "drain me", [json.string("drain me")])

  logging.flush_on_exit(logger)
  |> should.equal(Ok(Nil))

  let assert Ok(Written(record)) = process.receive(subject, within: 1000)
  record.message |> should.equal("drain me")
  let assert Ok(ExitRecords(records)) = process.receive(subject, within: 1000)
  records |> list.length |> should.equal(1)
  process.receive(subject, within: 1000)
  |> should.equal(Ok(Flushed))
}

pub fn level_filter_and_send_false_test() {
  let subject = process.new_subject()
  let options =
    logging.Options(..fixture_options(), minimum_level: logging.Warn)
  let logger = logging.new(options, transport(subject))

  let assert Ok(info) =
    logging.info(logger, "filtered", [json.string("filtered")])
    |> logging.send
  let assert Ok(local) =
    logging.warn(logger, "local", [json.string("local")])
    |> logging.send_with_store(False)

  logging.record(info).message |> should.equal("filtered")
  logging.record(local).message |> should.equal("local")
  process.receive(subject, within: 10)
  |> should.equal(Error(Nil))
}

pub fn explicit_otel_and_supabase_transports_test() {
  let otel_subject = process.new_subject()
  let otel_transport =
    logging.otel_transport(fn(record) {
      process.send(otel_subject, OtelWritten(record))
      Ok(Nil)
    })
  let otel_logger = logging.new(fixture_options(), otel_transport)
  let assert Ok(_) =
    logging.error(otel_logger, "payment failed", [
      json.string("payment failed"),
    ])
    |> logging.add_trace("0123456789abcdef0123456789abcdef")
    |> logging.add_fields([
      #("otel.span_id", json.string("0123456789abcdef")),
      #("region", json.string("us-east-1")),
    ])
    |> logging.send

  let assert Ok(OtelWritten(otel)) = process.receive(otel_subject, within: 1000)
  let logging.OtelLogRecord(
    body:,
    severity_text:,
    severity_number:,
    attributes:,
    ..,
  ) = otel
  body |> should.equal("payment failed")
  severity_text |> should.equal("ERROR")
  severity_number |> should.equal(17)
  attributes
  |> json.object
  |> json.to_string
  |> should.equal(
    "{\"service.name\":\"payments\",\"next_logger.schema\":\"next-loggers/v1\",\"next_logger.runtime\":\"contract-test\",\"log.record.uid\":\"contract-record-1\",\"trace.id\":\"0123456789abcdef0123456789abcdef\",\"next_logger.field.environment\":\"test\",\"next_logger.field.otel.span_id\":\"0123456789abcdef\",\"next_logger.field.region\":\"us-east-1\"}",
  )

  let supabase_subject = process.new_subject()
  let supabase_transport =
    logging.supabase_transport(fn(record) {
      process.send(supabase_subject, SupabaseWritten(record))
      Ok(Nil)
    })
  let supabase_logger = logging.new(fixture_options(), supabase_transport)
  let assert Ok(_) =
    logging.info(supabase_logger, "cart updated", [
      json.string("cart updated"),
    ])
    |> logging.send
  let assert Ok(SupabaseWritten(record)) =
    process.receive(supabase_subject, within: 1000)
  record.schema |> should.equal("next-loggers/v1")
  record.message |> should.equal("cart updated")
}

pub fn per_event_otel_routing_test() {
  let otel_subject = process.new_subject()
  let ordinary_subject = process.new_subject()
  let otel_transport =
    logging.otel_transport(fn(record) {
      process.send(otel_subject, OtelWritten(record))
      Ok(Nil)
    })
  let logger =
    logging.new(
      fixture_options(),
      logging.fanout_transport([transport(ordinary_subject), otel_transport]),
    )

  let assert Ok(_) =
    logging.info(logger, "ordinary-only", [json.string("ordinary-only")])
    |> logging.event_not_otel
    |> logging.send
  let assert Ok(Written(ordinary_only)) =
    process.receive(ordinary_subject, within: 1000)
  ordinary_only.message |> should.equal("ordinary-only")
  process.receive(otel_subject, within: 10)
  |> should.equal(Error(Nil))

  let assert Ok(_) =
    logging.info(logger, "telemetry", [json.string("telemetry")])
    |> logging.event_use_otel
    |> logging.send
  let assert Ok(Written(ordinary_telemetry)) =
    process.receive(ordinary_subject, within: 1000)
  ordinary_telemetry.message |> should.equal("telemetry")
  let assert Ok(OtelWritten(record)) =
    process.receive(otel_subject, within: 1000)
  record.body |> should.equal("telemetry")
}

pub fn sampled_out_span_correlates_without_recording_mutations_test() {
  let log_subject = process.new_subject()
  let span_subject = process.new_subject()
  let logger = logging.new(fixture_options(), transport(log_subject))
  let context =
    logging.OtelSpanContext(
      trace_id: Some("fedcba9876543210fedcba9876543210"),
      span_id: Some("fedcba9876543210"),
      trace_flags: 0,
      trace_state: None,
      fields: [],
      tags: [],
    )
  let span =
    logging.OtelSpan(
      context:,
      is_recording: fn() { Ok(False) },
      record_exception: fn(_) {
        process.send(span_subject, ExceptionRecorded)
        Ok(Nil)
      },
      set_status: fn(_, _) {
        process.send(span_subject, StatusSet)
        Ok(Nil)
      },
      end: fn() {
        process.send(span_subject, SpanEnded)
        Ok(Nil)
      },
    )
  let tracer = logging.OtelTracer(start: fn(_, _) { Ok(span) })

  let assert Ok(trace_id) =
    logging.with_span(logger, tracer, "sampled-out", [], fn(_, span_context) {
      let assert Ok(_) =
        logging.info(logger, "inside sampled-out", [])
        |> logging.apply_span_context(span_context)
        |> logging.send
      let assert logging.OtelSpanContext(trace_id: Some(trace_id), ..) =
        span_context
      Ok(trace_id)
    })

  trace_id |> should.equal("fedcba9876543210fedcba9876543210")
  let assert Ok(SpanEnded) = process.receive(span_subject, within: 1000)
  process.receive(span_subject, within: 10)
  |> should.equal(Error(Nil))
}
