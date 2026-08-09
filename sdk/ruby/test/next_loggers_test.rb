# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/oresoftware/next_loggers"

class NextLoggersTest < Minitest::Test
  def test_per_event_otel_routing_preserves_ordinary_logging
    ordinary = []
    otel = []
    logger = ORESoftware::NextLoggers::Logger.new(
      app_name: "routing",
      transports: [->(record) { ordinary << record }, ORESoftware::NextLoggers::OtelTransport.new { |record| otel << record }]
    )

    logger.info("default")
    logger.info("ordinary-only", {}, otel: false)
    logger.not_otel
    logger.info("logger-off")
    logger.info("override", {}, otel: true)

    assert_equal %w[default ordinary-only logger-off override], ordinary.map { |record| record.fetch("message") }
    assert_equal %w[default override], otel.map { |record| record.fetch("body") }
  end

  def test_context_flows_to_otel_and_supabase_and_is_restored
    otel = []
    supabase = []
    logger = ORESoftware::NextLoggers::Logger.new(
      app_name: "payments",
      name: "audit",
      fields: { environment: "test" },
      id_factory: -> { "ruby-record-1" },
      clock: -> { "2026-01-02T03:04:05.000Z" },
      transports: [
        ORESoftware::NextLoggers::OtelTransport.new { |record| otel << record },
        ORESoftware::NextLoggers::SupabaseTransport.new { |record| supabase << record }
      ]
    )

    record = ORESoftware::NextLoggers.with_context(
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1,
      trace_state: "vendor=value",
      fields: { requestId: "request-1" },
      tags: %w[otel ruby]
    ) do
      logger.error("payment failed", orderId: "order-42")
    end

    assert_equal "next-loggers/v1", record.fetch("schema")
    assert_equal "ERROR", record.fetch("level")
    assert_equal "0123456789abcdef0123456789abcdef", record.fetch("traceId")
    assert_equal "0123456789abcdef", record.fetch("fields").fetch("otel.span_id")
    assert_equal "request-1", record.fetch("fields").fetch("requestId")
    assert_equal "order-42", record.fetch("fields").fetch("orderId")
    assert_equal 17, otel.fetch(0).fetch("severityNumber")
    assert_same record, supabase.fetch(0)
    assert_nil ORESoftware::NextLoggers.current_context
  end

  def test_thread_local_context_is_isolated
    logger = ORESoftware::NextLoggers::Logger.new(app_name: "app", transports: [])
    traces = Queue.new

    threads = { a: "trace-a", b: "trace-b" }.map do |name, trace_id|
      Thread.new do
        value = ORESoftware::NextLoggers.with_context(trace_id: trace_id, span_id: "#{name}-span") do
          logger.info(name.to_s).fetch("traceId")
        end
        traces << value
      end
    end
    threads.each(&:join)

    assert_equal %w[trace-a trace-b], [traces.pop, traces.pop].sort
  end

  def test_sampled_out_span_correlates_without_recording_mutations
    records = []
    logger = ORESoftware::NextLoggers::Logger.new(
      app_name: "spans",
      transports: [->(record) { records << record }]
    )
    span = Struct.new(:status_calls, :exception_calls, :ended) do
      def context
        { trace_id: "fedcba9876543210fedcba9876543210", span_id: "fedcba9876543210", trace_flags: 0 }
      end

      def recording?
        false
      end

      def set_status(*)
        self.status_calls += 1
      end

      def record_exception(*)
        self.exception_calls += 1
      end

      def end
        self.ended += 1
      end
    end.new(0, 0, 0)
    tracer = Object.new
    tracer.define_singleton_method(:start_span) { |_name, _attributes| span }

    result = ORESoftware::NextLoggers.with_span(logger, tracer, "sampled-out") do
      logger.info("inside sampled-out").fetch("traceId")
    end

    assert_equal "fedcba9876543210fedcba9876543210", result
    assert_equal 0, span.status_calls
    assert_equal 0, span.exception_calls
    assert_equal 1, span.ended
    assert records.any? { |record| record.fetch("message") == "inside sampled-out" }
  end
end
