defmodule ORESoftware.NextLoggers do
  @moduledoc """
  Compatibility facade for the direct-record Elixir API. Context is process
  local and OTEL is an explicit tagged transport, never a global provider.

  Middleware that spans the remainder of a Plug/Phoenix pipeline may install a
  process-local context with `put_context/1` and restore its exact prior value
  with `restore_context/1`. Prefer `with_context/2` whenever callback scoping is
  possible.
  """

  @schema "next-loggers/v1"
  @context_key {__MODULE__, :context}
  @missing_context {__MODULE__, :missing_context}

  def schema, do: @schema

  def new(app_name, opts \\ []) when is_binary(app_name) and is_list(opts) do
    if String.trim(app_name) == "", do: raise(ArgumentError, "app_name must not be empty")

    %{
      app_name: app_name,
      name: Keyword.get(opts, :name),
      runtime: Keyword.get(opts, :runtime, "elixir"),
      fields: Map.new(Keyword.get(opts, :fields, %{})),
      transports: List.wrap(Keyword.get(opts, :transports, [])),
      otel: Keyword.get(opts, :otel, true),
      id_factory: Keyword.get(opts, :id_factory, &default_id/0),
      clock: Keyword.get(opts, :clock, &default_clock/0)
    }
  end

  def use_otel(logger), do: %{logger | otel: true}
  def not_otel(logger), do: %{logger | otel: false}
  def with_otel(logger, enabled) when is_boolean(enabled), do: %{logger | otel: enabled}

  def current_context, do: Process.get(@context_key, %{})

  @doc """
  Installs a process-local logging context and returns an opaque restore token.

  This lower-level primitive exists for middleware APIs such as `Plug.call/2`
  that cannot wrap the rest of the request pipeline in a callback. Callers must
  restore the token in an `after` or before-send cleanup path.
  """
  def put_context(context) when is_map(context) do
    previous = Process.get(@context_key, @missing_context)
    Process.put(@context_key, context)
    previous
  end

  @doc "Clears the process-local logging context and returns a restore token."
  def clear_context do
    previous = Process.get(@context_key, @missing_context)
    Process.delete(@context_key)
    previous
  end

  @doc "Restores a token returned by `put_context/1` or `clear_context/0`."
  def restore_context(@missing_context) do
    Process.delete(@context_key)
    :ok
  end

  def restore_context(context) when is_map(context) do
    Process.put(@context_key, context)
    :ok
  end

  def with_context(context, callback) when is_map(context) and is_function(callback, 0) do
    previous = put_context(context)

    try do
      callback.()
    after
      restore_context(previous)
    end
  end

  def info(logger, message, fields \\ %{}), do: log(logger, "INFO", message, fields)
  def error(logger, message, fields \\ %{}), do: log(logger, "ERROR", message, fields)

  def log(logger, level, message, event_fields), do: log(logger, level, message, event_fields, [])

  def log(logger, level, message, event_fields, opts)
      when is_map(logger) and is_binary(level) and is_binary(message) and
             is_map(event_fields) and is_list(opts) do
    context = current_context()

    fields =
      logger.fields
      |> Map.merge(Map.get(context, :fields, %{}))
      |> put_optional("otel.span_id", Map.get(context, :span_id))
      |> Map.put("otel.trace_flags", Map.get(context, :trace_flags, 0))
      |> put_optional("otel.trace_state", Map.get(context, :trace_state))
      |> Map.merge(event_fields)

    trace_id = Map.get(context, :trace_id)

    record =
      %{
        "schema" => @schema,
        "id" => logger.id_factory.(),
        "timestamp" => logger.clock.(),
        "level" => level,
        "runtime" => logger.runtime,
        "appName" => logger.app_name,
        "message" => message,
        "values" => [message],
        "fields" => fields
      }
      |> put_optional("name", logger.name)
      |> put_optional("traceId", trace_id)
      |> maybe_put_trace_ids(trace_id)
      |> maybe_put_tags(Map.get(context, :tags, []))

    event_otel = Keyword.get(opts, :otel, logger.otel)

    Enum.each(logger.transports, fn
      {:otel, transport} when event_otel -> deliver(transport, record)
      {:otel, _transport} -> :ok
      transport -> deliver(transport, record)
    end)

    record
  end

  defp deliver(transport, record) do
    case transport.(record) do
      :ok -> :ok
      other -> raise "transport returned #{inspect(other)}"
    end
  end

  def otel_transport(sink) when is_function(sink, 1) do
    {:otel,
     fn record ->
       attributes =
         %{
           "service.name" => record["appName"],
           "next_logger.schema" => record["schema"],
           "next_logger.runtime" => record["runtime"],
           "log.record.uid" => record["id"]
         }
         |> put_optional("trace.id", record["traceId"])
         |> Map.merge(
           Map.new(record["fields"], fn {key, value} ->
             {"next_logger.field.#{key}", value}
           end)
         )

       sink.(%{
         "body" => record["message"],
         "severityText" => record["level"],
         "severityNumber" => severity_number(record["level"]),
         "timestamp" => record["timestamp"],
         "attributes" => attributes
       })

       :ok
     end}
  end

  def supabase_transport(sender) when is_function(sender, 1) do
    fn record ->
      sender.(record)
      :ok
    end
  end

  defp maybe_put_trace_ids(map, value) when value in [nil, ""], do: map
  defp maybe_put_trace_ids(map, trace_id), do: Map.put(map, "traceIds", [trace_id])
  defp maybe_put_tags(map, []), do: map
  defp maybe_put_tags(map, tags), do: Map.put(map, "tags", Enum.uniq(tags))
  defp put_optional(map, _key, value) when value in [nil, ""], do: map
  defp put_optional(map, key, value), do: Map.put(map, key, value)
  defp severity_number("TRACE"), do: 1
  defp severity_number("DEBUG"), do: 5
  defp severity_number("INFO"), do: 9
  defp severity_number("WARN"), do: 13
  defp severity_number("ERROR"), do: 17
  defp severity_number("FATAL"), do: 21
  defp default_id, do: "elixir-#{System.unique_integer([:monotonic, :positive])}"
  defp default_clock, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
