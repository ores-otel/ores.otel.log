defmodule ORESoftware.NextLoggers.RequestContext do
  @moduledoc """
  Typed `ores.request-context.v1` helpers over the process-local carrier owned by
  `ORESoftware.NextLoggers`.

  This module never creates a second process key. BEAM child processes do not
  inherit context, so use `spawn_with_current/1`, `task_with_current/1`, or
  `run_captured/2` at process boundaries.
  """

  alias ORESoftware.NextLoggers

  @schema "ores.request-context.v1"

  def schema, do: @schema

  @doc "Build an allowlisted request context; never include credentials or raw tokens."
  def new(values \\ %{})

  def new(values) when is_list(values), do: values |> Map.new() |> new()

  def new(values) when is_map(values) do
    request_id = string_value(get_any(values, [:request_id, :requestId, "requestId"])) || ""

    user_id =
      string_value(
        get_any(values, [
          :logged_in_user_id,
          :loggedInUserId,
          :user_id,
          :userId,
          "loggedInUserId",
          "userId"
        ])
      )

    tenant_id = string_value(get_any(values, [:tenant_id, :tenantId, "tenantId"]))
    session_id = string_value(get_any(values, [:session_id, :sessionId, "sessionId"]))

    correlation_id =
      string_value(get_any(values, [:correlation_id, :correlationId, "correlationId"]))

    parent_request_id =
      string_value(
        get_any(values, [:parent_request_id, :parentRequestId, "parentRequestId"])
      )

    trace_id = string_value(get_any(values, [:trace_id, :traceId, "traceId"]))
    span_id = string_value(get_any(values, [:span_id, :spanId, "spanId"]))
    operation = string_value(get_any(values, [:operation, "operation"]))
    service_name = string_value(get_any(values, [:service_name, :serviceName, "serviceName"]))
    locale = string_value(get_any(values, [:locale, "locale"]))

    started_at_unix_ms =
      number_value(get_any(values, [:started_at_unix_ms, :startedAtUnixMs, "startedAtUnixMs"]))

    deadline_unix_ms =
      number_value(get_any(values, [:deadline_unix_ms, :deadlineUnixMs, "deadlineUnixMs"]))

    baggage = map_value(get_any(values, [:baggage, "baggage"], %{}))
    input_fields = map_value(get_any(values, [:fields, "fields"], %{}))

    fields =
      input_fields
      |> Map.put("request.context.schema", @schema)
      |> put_string("request.id", request_id)
      |> put_string("user.id", user_id)
      |> put_string("tenant.id", tenant_id)
      |> put_string("session.id", session_id)
      |> put_string("correlation.id", correlation_id)
      |> put_string("request.parent_id", parent_request_id)
      |> put_string("operation.name", operation)
      |> put_string("service.name", service_name)
      |> put_string("request.locale", locale)
      |> put_number("request.started_at_unix_ms", started_at_unix_ms)
      |> put_number("request.deadline_unix_ms", deadline_unix_ms)

    %{
      schema: @schema,
      request_id: request_id,
      fields: fields,
      baggage: baggage,
      tags: ["ores-request-context"],
      routine_id: request_id
    }
    |> put_optional(:logged_in_user_id, user_id)
    |> put_logged_in_user(user_id)
    |> put_optional(:tenant_id, tenant_id)
    |> put_optional(:session_id, session_id)
    |> put_optional(:correlation_id, correlation_id)
    |> put_optional(:parent_request_id, parent_request_id)
    |> put_optional(:trace_id, trace_id)
    |> put_optional(:span_id, span_id)
    |> put_optional(:operation, operation)
    |> put_optional(:service_name, service_name)
    |> put_optional(:locale, locale)
    |> put_optional_number(:started_at_unix_ms, started_at_unix_ms)
    |> put_optional_number(:deadline_unix_ms, deadline_unix_ms)
  end

  def merge(base, patch) when is_map(base) and is_map(patch) do
    base
    |> Map.merge(patch)
    |> Map.put(:fields, Map.merge(Map.get(base, :fields, %{}), Map.get(patch, :fields, %{})))
    |> Map.put(
      :baggage,
      Map.merge(Map.get(base, :baggage, %{}), Map.get(patch, :baggage, %{}))
    )
    |> Map.put(
      :logged_in_user,
      Map.merge(Map.get(base, :logged_in_user, %{}), Map.get(patch, :logged_in_user, %{}))
    )
    |> Map.put(:tags, Enum.uniq(Map.get(base, :tags, []) ++ Map.get(patch, :tags, [])))
  end

  @doc "Run inside the one process-local context owned by ORESoftware.NextLoggers."
  def with_context(values, callback) when is_function(callback, 0) do
    patch = normalize_context(values)

    context =
      case current() do
        nil -> patch
        parent -> merge(parent, patch)
      end

    NextLoggers.with_context(context, callback)
  end

  def current do
    case NextLoggers.current_context() do
      context when is_map(context) and map_size(context) > 0 -> context
      _ -> nil
    end
  end

  def capture, do: current()

  def run_captured(nil, callback) when is_function(callback, 0), do: callback.()

  def run_captured(context, callback) when is_map(context) and is_function(callback, 0) do
    NextLoggers.with_context(context, callback)
  end

  def request_id, do: context_value(:request_id, "request.id")

  def logged_in_user_id do
    context_value(:logged_in_user_id, "user.id") ||
      get_in(current() || %{}, [:logged_in_user, :id])
  end

  def tenant_id, do: context_value(:tenant_id, "tenant.id")
  def session_id, do: context_value(:session_id, "session.id")
  def correlation_id, do: context_value(:correlation_id, "correlation.id")

  @doc "Spawn a BEAM process with an explicit snapshot of the current context."
  def spawn_with_current(callback) when is_function(callback, 0) do
    snapshot = capture()
    Kernel.spawn(fn -> run_captured(snapshot, callback) end)
  end

  @doc "Start a linked Task with an explicit snapshot of the current context."
  def task_with_current(callback) when is_function(callback, 0) do
    snapshot = capture()
    Task.async(fn -> run_captured(snapshot, callback) end)
  end

  defp normalize_context(%{schema: @schema} = context), do: context
  defp normalize_context(values), do: new(values)

  defp context_value(key, field_key) do
    case current() do
      nil -> nil
      context -> Map.get(context, key) || get_in(context, [:fields, field_key])
    end
  end

  defp get_any(values, keys, default \\ nil) do
    Enum.reduce_while(keys, default, fn key, _acc ->
      case Map.fetch(values, key) do
        {:ok, value} -> {:halt, value}
        :error -> {:cont, default}
      end
    end)
  end

  defp string_value(nil), do: nil
  defp string_value(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      normalized -> normalized
    end
  end

  defp string_value(value) when is_atom(value), do: value |> Atom.to_string() |> string_value()
  defp string_value(value) when is_integer(value), do: Integer.to_string(value)
  defp string_value(_value), do: nil

  defp number_value(value) when is_integer(value) and value >= 0, do: value
  defp number_value(_value), do: nil

  defp map_value(value) when is_map(value), do: value
  defp map_value(_value), do: %{}

  defp put_string(map, _key, value) when value in [nil, ""], do: map
  defp put_string(map, key, value), do: Map.put(map, key, value)
  defp put_number(map, _key, nil), do: map
  defp put_number(map, key, value), do: Map.put(map, key, value)
  defp put_optional(map, _key, value) when value in [nil, ""], do: map
  defp put_optional(map, key, value), do: Map.put(map, key, value)
  defp put_optional_number(map, _key, nil), do: map
  defp put_optional_number(map, key, value), do: Map.put(map, key, value)
  defp put_logged_in_user(map, nil), do: map
  defp put_logged_in_user(map, user_id), do: Map.put(map, :logged_in_user, %{id: user_id})
end
