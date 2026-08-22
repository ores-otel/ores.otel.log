# frozen_string_literal: true

require "securerandom"
require "time"
require_relative "next_loggers/version"

module ORESoftware
  # Dependency-free Ruby implementation of the next-loggers/v1 wire contract.
  module NextLoggers
    SCHEMA = "next-loggers/v1"
    LEVELS = %w[TRACE DEBUG INFO WARN ERROR FATAL].freeze
    OTEL_SEVERITY_NUMBERS = {
      "TRACE" => 1,
      "DEBUG" => 5,
      "INFO" => 9,
      "WARN" => 13,
      "ERROR" => 17,
      "FATAL" => 21
    }.freeze
    CONTEXT_KEY = :__oresoftware_next_loggers_context

    Context = Struct.new(
      :trace_id,
      :span_id,
      :trace_flags,
      :trace_state,
      :fields,
      :tags,
      keyword_init: true
    ) do
      def initialize(**values)
        super
        self.trace_flags = trace_flags.nil? ? 1 : Integer(trace_flags)
        self.fields = (fields || {}).each_with_object({}) do |(key, value), out|
          out[key.to_s] = value
        end.freeze
        self.tags = Array(tags).map(&:to_s).uniq.freeze
        freeze
      end
    end

    module_function

    def current_context
      Thread.current.thread_variable_get(CONTEXT_KEY)
    end

    # Install context for the current thread and always restore the prior frame.
    def with_context(context)
      previous = current_context
      Thread.current.thread_variable_set(CONTEXT_KEY, normalize_context(context))
      yield
    ensure
      Thread.current.thread_variable_set(CONTEXT_KEY, previous)
    end

    def normalize_context(context)
      return nil if context.nil?
      return context if context.is_a?(Context)
      raise ArgumentError, "context must be a Hash, Context, or nil" unless context.is_a?(Hash)

      Context.new(
        trace_id: context[:trace_id] || context["trace_id"] || context[:traceId] || context["traceId"],
        span_id: context[:span_id] || context["span_id"] || context[:spanId] || context["spanId"],
        trace_flags: context[:trace_flags] || context["trace_flags"] || context[:traceFlags] || context["traceFlags"],
        trace_state: context[:trace_state] || context["trace_state"] || context[:traceState] || context["traceState"],
        fields: context[:fields] || context["fields"],
        tags: context[:tags] || context["tags"]
      )
    end

    def with_span(logger, tracer, name, attributes = {})
      span = begin
        tracer.start_span(name.to_s, attributes.dup)
      rescue StandardError => error
        safe_log(logger, :warn, "OpenTelemetry start span failed", "otel.bridge_error" => error.message)
        return yield nil
      end
      context = begin
        span.respond_to?(:context) ? normalize_context(span.context) : Context.new
      rescue StandardError => error
        safe_log(logger, :warn, "OpenTelemetry read span context failed", "otel.bridge_error" => error.message)
        Context.new
      end
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)

      with_context(context) do
        safe_log(logger, :debug, "span started: #{name}", "otel.span_name" => name.to_s, "otel.span_phase" => "start")
        begin
          result = yield span
          if span_recording?(span)
            safe_span_call(logger, name, "set success status") { span.set_status(1, "") if span.respond_to?(:set_status) }
          end
          safe_log(
            logger,
            :debug,
            "span completed: #{name}",
            "otel.span_name" => name.to_s,
            "otel.span_phase" => "end",
            "otel.duration_ms" => (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000
          )
          result
        rescue Exception => error # rubocop:disable Lint/RescueException
          if span_recording?(span)
            safe_span_call(logger, name, "record exception") { span.record_exception(error) if span.respond_to?(:record_exception) }
            safe_span_call(logger, name, "set error status") { span.set_status(2, error.message) if span.respond_to?(:set_status) }
          end
          safe_log(logger, :error, "span failed: #{name}", "otel.span_name" => name.to_s, "otel.span_phase" => "error")
          raise
        ensure
          begin
            span.end if span.respond_to?(:end)
          rescue StandardError => error
            safe_log(logger, :warn, "OpenTelemetry end span failed", "otel.span_name" => name.to_s, "otel.bridge_error" => error.message)
          end
        end
      end
    end

    def span_recording?(span)
      !span.respond_to?(:recording?) || span.recording?
    rescue StandardError
      false
    end

    def safe_log(logger, level, message, fields)
      logger.public_send(level, message, fields)
    rescue StandardError
      nil
    end

    def safe_span_call(logger, name, operation)
      yield
    rescue StandardError => error
      safe_log(
        logger,
        :warn,
        "OpenTelemetry #{operation} failed",
        "otel.span_name" => name.to_s,
        "otel.bridge_error" => error.message
      )
      nil
    end

    # Application-owned OTEL sink. No global provider or runtime patching occurs.
    class OtelTransport
      def initialize(&sink)
        raise ArgumentError, "sink block is required" unless sink

        @sink = sink
      end

      def write(record)
        attributes = {
          "service.name" => record.fetch("appName"),
          "next_logger.schema" => record.fetch("schema"),
          "next_logger.runtime" => record.fetch("runtime"),
          "log.record.uid" => record.fetch("id")
        }
        attributes["trace.id"] = record["traceId"] if record.key?("traceId")
        record.fetch("fields").each do |key, value|
          attributes["next_logger.field.#{key}"] = value
        end

        @sink.call(
          {
            "body" => record.fetch("message"),
            "severityText" => record.fetch("level"),
            "severityNumber" => OTEL_SEVERITY_NUMBERS.fetch(record.fetch("level")),
            "timestamp" => record.fetch("timestamp"),
            "attributes" => attributes.freeze
          }.freeze
        )
      end

      def open_telemetry?
        true
      end
    end

    # Client-safe Supabase transport; the application supplies its sender.
    class SupabaseTransport
      def initialize(&sender)
        raise ArgumentError, "sender block is required" unless sender

        @sender = sender
      end

      def write(record)
        @sender.call(record)
      end
    end

    class LogEvent
      attr_reader :logger, :level, :message, :fields

      def initialize(logger, level, message, fields = {})
        @logger = logger
        @level = level
        @message = message
        @fields = fields
        @otel_enabled = nil
      end

      def use_otel
        with_otel(true)
      end

      def not_otel
        with_otel(false)
      end

      def with_otel(enabled)
        @otel_enabled = !!enabled
        self
      end

      def reset_otel
        @otel_enabled = nil
        self
      end

      def otel_enabled?(fallback)
        @otel_enabled.nil? ? !!fallback : @otel_enabled
      end

      def send
        logger.emit_event(self)
      end
    end

    class Logger
      def initialize(
        app_name:,
        name: nil,
        runtime: "ruby",
        fields: {},
        transports: [],
        otel: true,
        id_factory: -> { SecureRandom.uuid },
        clock: -> { Time.now.utc.iso8601(3) }
      )
        raise ArgumentError, "app_name is required" if app_name.to_s.strip.empty?
        raise ArgumentError, "id_factory must respond to call" unless id_factory.respond_to?(:call)
        raise ArgumentError, "clock must respond to call" unless clock.respond_to?(:call)

        @app_name = app_name.to_s.freeze
        @name = name&.to_s
        @runtime = runtime.to_s.strip.empty? ? "ruby" : runtime.to_s
        @fields = stringify_keys(fields).freeze
        @transports = Array(transports).freeze
        @otel_enabled = !!otel
        @id_factory = id_factory
        @clock = clock
      end

      def set_otel_enabled(enabled)
        @otel_enabled = !!enabled
        self
      end

      def use_otel
        set_otel_enabled(true)
      end

      def not_otel
        set_otel_enabled(false)
      end

      def otel_enabled
        @otel_enabled
      end

      alias otel_enabled? otel_enabled

      def log(level, message, fields = {}, otel: nil)
        pending = event(level, message, fields)
        pending.with_otel(otel) unless otel.nil?
        pending.send
      end

      def event(level, message, fields = {})
        LogEvent.new(self, level, message, fields)
      end

      def emit_event(event)
        level_name = event.level.to_s.upcase
        raise ArgumentError, "unsupported level: #{event.level}" unless LEVELS.include?(level_name)

        context = NextLoggers.current_context
        merged_fields = @fields.merge(context&.fields || {})
        if context
          merged_fields["otel.span_id"] = context.span_id unless blank?(context.span_id)
          merged_fields["otel.trace_flags"] = context.trace_flags
          merged_fields["otel.trace_state"] = context.trace_state unless blank?(context.trace_state)
        end
        merged_fields.merge!(stringify_keys(event.fields))
        merged_fields.freeze

        text = event.message.to_s
        record = {
          "schema" => SCHEMA,
          "id" => @id_factory.call.to_s,
          "timestamp" => @clock.call.to_s,
          "level" => level_name,
          "runtime" => @runtime,
          "appName" => @app_name,
          "message" => text,
          "values" => [text].freeze,
          "fields" => merged_fields
        }
        record["name"] = @name unless blank?(@name)
        unless context.nil? || blank?(context.trace_id)
          record["traceId"] = context.trace_id.to_s
          record["traceIds"] = [context.trace_id.to_s].freeze
        end
        record["tags"] = context.tags unless context.nil? || context.tags.empty?
        record.freeze

        @transports.each do |transport|
          next if transport.respond_to?(:open_telemetry?) && transport.open_telemetry? && !event.otel_enabled?(@otel_enabled)

          if transport.respond_to?(:write)
            transport.write(record)
          elsif transport.respond_to?(:call)
            transport.call(record)
          else
            raise ArgumentError, "transport must respond to write or call"
          end
        end
        record
      end

      LEVELS.each do |level|
        define_method(level.downcase) do |message, fields = {}, otel: nil, **field_keywords|
          merged_fields = fields.merge(field_keywords)
          log(level, message, merged_fields, otel: otel)
        end
      end

      private

      def stringify_keys(value)
        raise ArgumentError, "fields must be a Hash" unless value.is_a?(Hash)

        value.each_with_object({}) { |(key, item), out| out[key.to_s] = item }
      end

      def blank?(value)
        value.nil? || value.to_s.strip.empty?
      end
    end
  end
end
