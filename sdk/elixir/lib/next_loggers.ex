defmodule NextLoggers do
  @moduledoc """
  Dependency-free next-loggers/v1 logger with BEAM process-local context and
  explicit OpenTelemetry adapter callbacks. It does not patch Logger, OTP, or
  OpenTelemetry modules.
  """

  @schema "next-loggers/v1"
  @context_key {__MODULE__, :context}
  @level_index %{trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5}

  defmodule Logger do
    @enforce_keys [:transport, :id_factory, :clock]
    defstruct app_name: "app",
              name: nil,
              runtime: "elixir",
              minimum_level: :info,
              fields: %{},
              logged_in_user: %{},
              transport: nil,
              id_factory: nil,
              clock: nil,
              console: false,
              otel: true
  end

  defmodule Event do
    @enforce_keys [:logger, :level, :values]
    defstruct logger: nil,
              level: :info,
              values: [],
              fields: %{},
              trace_id: nil,
              trace_ids: [],
              routine_id: nil,
              tags: [],
              context: [],
              meta: [],
              sent: false,
              record: nil,
              otel: nil
  end

  def new(options \\ []) do
    options = Map.new(options)

    %Logger{
      app_name: Map.get(options, :app_name, "app"),
      name: Map.get(options, :name),
      runtime: Map.get(options, :runtime, "elixir"),
      minimum_level: Map.get(options, :minimum_level, :info),
      fields: Map.get(options, :fields, %{}),
      logged_in_user: Map.get(options, :logged_in_user, %{}),
      transport: Map.get(options, :transport, fn _record -> :ok end),
      id_factory:
        Map.get(options, :id_factory, fn ->
          Integer.to_string(System.unique_integer([:positive, :monotonic]))
        end),
      clock:
        Map.get(options, :clock, fn ->
          DateTime.utc_now() |> DateTime.to_iso8601()
        end),
      console: Map.get(options, :console, false),
      otel: Map.get(options, :otel, true)
    }
  end

  def trace(logger, values), do: event(logger, :trace, values)
  def debug(logger, values), do: event(logger, :debug, values)
  def info(logger, values), do: event(logger, :info, values)
  def warn(logger, values), do: event(logger, :warn, values)
  def error(logger, values), do: event(logger, :error, values)
  def fatal(logger, values), do: event(logger, :fatal, values)

  defp event(logger, level, values) do
    %Event{logger: logger, level: level, values: List.wrap(values)}
  end

  def add_fields(%Event{} = event, fields) when is_map(fields) do
    %{event | fields: Map.merge(event.fields, fields)}
  end

  def use_otel(%Event{} = event), do: %{event | otel: true}
  def not_otel(%Event{} = event), do: %{event | otel: false}
  def with_otel(%Event{} = event, enabled) when is_boolean(enabled), do: %{event | otel: enabled}
  def reset_otel(%Event{} = event), do: %{event | otel: nil}
  def is_otel_enabled(%Event{otel: nil} = event), do: event.logger.otel
  def is_otel_enabled(%Event{} = event), do: event.otel

  def add_trace(%Event{} = event, trace_id) do
    trace_id = to_string(trace_id)

    if trace_id == "" do
      event
    else
      %{
        event
        | trace_id: event.trace_id || trace_id,
          trace_ids: append_unique(event.trace_ids, trace_id)
      }
    end
  end

  def add_tags(%Event{} = event, tags) do
    normalized =
      tags
      |> List.wrap()
      |> Enum.map(&to_string/1)
      |> Enum.reject(&(&1 == ""))

    %{event | tags: Enum.reduce(normalized, event.tags, &append_unique(&2, &1))}
  end

  def add_routine_id(%Event{} = event, routine_id) do
    %{event | routine_id: to_string(routine_id)}
  end

  def add_context(%Event{} = event, value) do
    %{event | context: event.context ++ [value]}
  end

  def add_meta(%Event{} = event, value) do
    %{event | meta: event.meta ++ [value]}
  end

  # BEAM context is naturally process-local. Nested scopes restore the prior
  # value and no OTP process, Logger module, or OTel module is patched.
  def with_context(context, fun) when is_map(context) and is_function(fun, 0) do
    old = Process.get(@context_key, :__next_loggers_missing__)
    Process.put(@context_key, context)

    try do
      fun.()
    after
      case old do
        :__next_loggers_missing__ -> Process.delete(@context_key)
        value -> Process.put(@context_key, value)
      end
    end
  end

  def current_context, do: Process.get(@context_key)

  def apply_context(%Event{} = event) do
    case current_context() do
      context when is_map(context) ->
        fields =
          context
          |> Map.get(:fields, %{})
          |> Map.put("otel.trace_flags", Map.get(context, :trace_flags, 0))
          |> maybe_put("otel.span_id", Map.get(context, :span_id))
          |> maybe_put("otel.trace_state", Map.get(context, :trace_state))
          |> maybe_put_map("otel.baggage", Map.get(context, :baggage, %{}))

        event
        |> add_fields(fields)
        |> add_trace(Map.get(context, :trace_id, ""))
        |> add_tags(["otel" | Map.get(context, :tags, [])])

      _ ->
        event
    end
  end

  def to_record(%Event{record: record}) when is_map(record), do: record

  def to_record(%Event{} = event) do
    event = apply_context(event)
    logger = event.logger
    values = Enum.map(event.values, &normalize/1)

    %{
      schema: @schema,
      id: logger.id_factory.(),
      timestamp: logger.clock.(),
      level: event.level |> Atom.to_string() |> String.upcase(),
      runtime: logger.runtime,
      appName: logger.app_name,
      message: Enum.map_join(event.values, " ", &message_part/1),
      values: values,
      fields: logger.fields |> Map.merge(event.fields) |> normalize()
    }
    |> maybe_put(:name, logger.name)
    |> maybe_put_map(:loggedInUser, logger.logged_in_user)
    |> maybe_put(:traceId, event.trace_id)
    |> maybe_put_list(:traceIds, event.trace_ids)
    |> maybe_put(:routineId, event.routine_id)
    |> maybe_put_list(:tags, event.tags)
    |> maybe_put_list(:context, Enum.map(event.context, &normalize/1))
    |> maybe_put_list(:meta, Enum.map(event.meta, &normalize/1))
  end

  def send(%Event{sent: true} = event), do: {:ok, event}

  def send(%Event{} = event) do
    applied = apply_context(event)
    record = to_record(applied)

    if enabled?(applied.level, applied.logger.minimum_level) do
      if applied.logger.console do
        IO.puts(
          "[#{record.timestamp}] [#{record.level}] " <>
            "[#{record.appName}] #{record.message}"
        )
      end

      case deliver_transport(applied.logger.transport, record, is_otel_enabled(applied)) do
        :ok -> {:ok, %{applied | sent: true, record: record}}
        {:error, reason} -> {:error, reason}
        other -> {:error, {:invalid_transport_result, other}}
      end
    else
      {:ok, %{applied | sent: true, record: record}}
    end
  rescue
    exception -> {:error, exception}
  end

  defp deliver_transport({:otel, _transport}, _record, false), do: :ok
  defp deliver_transport({:otel, transport}, record, true), do: transport.(record)
  defp deliver_transport(transport, record, _otel), do: transport.(record)

  def otel_transport(sink) when is_function(sink, 1) do
    {:otel,
     fn record ->
       attributes =
         %{
           "service.name" => record.appName,
           "next_logger.schema" => record.schema,
           "next_logger.runtime" => record.runtime,
           "log.record.uid" => record.id
         }
         |> maybe_put("trace.id", Map.get(record, :traceId))
         |> Map.merge(
           Map.new(record.fields, fn {key, value} ->
             {"next_logger.field.#{key}", value}
           end)
         )

       sink.(%{
         "body" => record.message,
         "severityText" => record.level,
         "severityNumber" => severity_number(record.level),
         "timestamp" => record.timestamp,
         "attributes" => attributes
       })

       :ok
     end}
  end

  @doc "Delegate records to an application-owned authenticated Supabase sender."
  def supabase_transport(sender) when is_function(sender, 1) do
    fn record ->
      sender.(record)
      :ok
    end
  end

  # Tracer is a structural map wrapping the application's installed OTel SDK.
  # OTel failures fail open; callback results/exceptions remain authoritative.
  def with_span(logger, tracer, name, attributes, fun)
      when is_map(tracer) and is_function(fun, 1) do
    case start_span(logger, tracer, name, attributes) do
      {:fallback, noop_span} ->
        fun.(noop_span)

      {:ok, span, context} ->
        started = System.monotonic_time(:microsecond)
        recording? = span_recording?(logger, tracer, span, name)

        with_context(context, fn ->
          safe_send(
            logger
            |> debug(["span started:", name])
            |> add_fields(%{"otel.span_name" => name, "otel.span_phase" => "start"})
            |> add_tags(["otel-span"])
          )

          try do
            result = fun.(span)

            if recording? do
              safe_otel_call(logger, name, "set success status", fn ->
                tracer.set_status.(span, 1, "")
              end)
            end

            safe_send(
              logger
              |> debug(["span completed:", name])
              |> add_fields(%{
                "otel.span_name" => name,
                "otel.span_phase" => "end",
                "otel.duration_ms" => elapsed_ms(started)
              })
              |> add_tags(["otel-span"])
            )

            result
          rescue
            exception ->
              stacktrace = __STACKTRACE__

              if recording? do
                safe_otel_call(logger, name, "record exception", fn ->
                  tracer.record_exception.(span, :error, exception, stacktrace)
                end)

                safe_otel_call(logger, name, "set error status", fn ->
                  tracer.set_status.(span, 2, Exception.message(exception))
                end)
              end

              safe_send(
                logger
                |> error(["span failed:", name, exception])
                |> add_fields(%{
                  "otel.span_name" => name,
                  "otel.span_phase" => "error",
                  "otel.duration_ms" => elapsed_ms(started)
                })
                |> add_tags(["otel-span"])
              )

              reraise exception, stacktrace
          catch
            kind, reason ->
              stacktrace = __STACKTRACE__

              if recording? do
                safe_otel_call(logger, name, "record exception", fn ->
                  tracer.record_exception.(span, kind, reason, stacktrace)
                end)

                safe_otel_call(logger, name, "set error status", fn ->
                  tracer.set_status.(span, 2, inspect(reason))
                end)
              end

              :erlang.raise(kind, reason, stacktrace)
          after
            safe_otel_call(logger, name, "end span", fn -> tracer.end.(span) end)
          end
        end)
    end
  end

  defp span_recording?(logger, tracer, span, name) do
    case Map.get(tracer, :is_recording) do
      callback when is_function(callback, 1) ->
        try do
          callback.(span) == true
        rescue
          exception ->
            report_otel_failure(logger, name, "read recording state", exception)
            false
        catch
          kind, reason ->
            report_otel_failure(logger, name, "read recording state", {kind, reason})
            false
        end

      _ ->
        true
    end
  end

  defp start_span(logger, tracer, name, attributes) do
    try do
      case tracer.start.(name, attributes) do
        {span, context} when is_map(context) ->
          {:ok, span, context}

        other ->
          report_otel_failure(
            logger,
            name,
            "start span",
            {:invalid_start_result, other}
          )

          {:fallback, :noop_span}
      end
    rescue
      exception ->
        report_otel_failure(logger, name, "start span", exception)
        {:fallback, :noop_span}
    catch
      kind, reason ->
        report_otel_failure(logger, name, "start span", {kind, reason})
        {:fallback, :noop_span}
    end
  end

  defp safe_otel_call(logger, name, operation, fun) do
    try do
      fun.()
      :ok
    rescue
      exception ->
        report_otel_failure(logger, name, operation, exception)
        :ok
    catch
      kind, reason ->
        report_otel_failure(logger, name, operation, {kind, reason})
        :ok
    end
  end

  defp report_otel_failure(logger, name, operation, failure) do
    logger
    |> warn(["OpenTelemetry", operation, "failed:", failure])
    |> add_fields(%{
      "otel.bridge_operation" => operation,
      "otel.span_name" => name
    })
    |> add_tags(["otel-span", "otel-bridge-error"])
    |> safe_send()
  end

  def memory_transport(owner \\ self()) do
    fn record ->
      send(owner, {:next_loggers_record, record})
      :ok
    end
  end

  defp safe_send(event) do
    case send(event) do
      {:ok, _} -> :ok
      {:error, _} -> :ok
    end
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp enabled?(level, minimum) do
    Map.fetch!(@level_index, level) >= Map.fetch!(@level_index, minimum)
  end

  defp severity_number("TRACE"), do: 1
  defp severity_number("DEBUG"), do: 5
  defp severity_number("INFO"), do: 9
  defp severity_number("WARN"), do: 13
  defp severity_number("ERROR"), do: 17
  defp severity_number("FATAL"), do: 21

  defp append_unique(values, value) do
    if value in values, do: values, else: values ++ [value]
  end

  defp elapsed_ms(started) do
    (System.monotonic_time(:microsecond) - started) / 1000
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, ""), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, normalize(value))

  defp maybe_put_map(map, _key, value)
       when is_map(value) and map_size(value) == 0,
       do: map

  defp maybe_put_map(map, key, value) when is_map(value) do
    Map.put(map, key, normalize(value))
  end

  defp maybe_put_list(map, _key, []), do: map

  defp maybe_put_list(map, key, value) when is_list(value) do
    Map.put(map, key, normalize(value))
  end

  defp normalize(value)
       when is_nil(value) or is_binary(value) or is_number(value) or is_boolean(value),
       do: value

  defp normalize(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize(%_{} = value), do: inspect(value)

  defp normalize(value) when is_map(value) do
    Map.new(value, fn {key, entry} -> {to_string(key), normalize(entry)} end)
  end

  defp normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)
  defp normalize(value) when is_tuple(value), do: value |> Tuple.to_list() |> normalize()
  defp normalize(value), do: inspect(value)

  defp message_part(value) when is_binary(value), do: value
  defp message_part(value), do: inspect(value)
end
