ExUnit.start()

defmodule ORESoftware.NextLoggersTest do
  use ExUnit.Case, async: true

  alias ORESoftware.NextLoggers

  test "process context flows to OTEL and Supabase transports" do
    parent = self()

    logger =
      NextLoggers.new("payments",
        name: "audit",
        fields: %{"environment" => "test"},
        id_factory: fn -> "elixir-record-1" end,
        clock: fn -> "2026-01-02T03:04:05.000Z" end,
        transports: [
          NextLoggers.otel_transport(fn value -> send(parent, {:otel, value}) end),
          NextLoggers.supabase_transport(fn value -> send(parent, {:supabase, value}) end)
        ]
      )

    record =
      NextLoggers.with_context(
        %{
          trace_id: "0123456789abcdef0123456789abcdef",
          span_id: "0123456789abcdef",
          trace_flags: 1,
          trace_state: "vendor=value",
          fields: %{"requestId" => "request-1"},
          tags: ["otel", "beam"]
        },
        fn -> NextLoggers.error(logger, "payment failed", %{"orderId" => "order-42"}) end
      )

    assert record["schema"] == "next-loggers/v1"
    assert record["level"] == "ERROR"
    assert record["traceId"] == "0123456789abcdef0123456789abcdef"
    assert record["fields"]["otel.span_id"] == "0123456789abcdef"
    assert record["fields"]["requestId"] == "request-1"
    assert record["fields"]["orderId"] == "order-42"
    assert_receive {:otel, %{"severityNumber" => 17}}
    assert_receive {:supabase, ^record}
    assert NextLoggers.current_context() == %{}
  end

  test "persistent middleware context restores the exact prior process value" do
    outer = %{trace_id: "outer", fields: %{"request.id" => "request-outer"}}
    inner = %{trace_id: "inner", fields: %{"request.id" => "request-inner"}}

    missing = NextLoggers.put_context(outer)
    assert NextLoggers.current_context() == outer

    previous = NextLoggers.put_context(inner)
    assert NextLoggers.current_context() == inner

    assert :ok == NextLoggers.restore_context(previous)
    assert NextLoggers.current_context() == outer

    assert :ok == NextLoggers.restore_context(missing)
    assert NextLoggers.current_context() == %{}
  end

  test "concurrent tasks keep process-local trace context isolated" do
    logger = NextLoggers.new("app", transports: [])

    traces =
      [a: "trace-a", b: "trace-b"]
      |> Task.async_stream(
        fn {name, trace_id} ->
          NextLoggers.with_context(%{trace_id: trace_id, span_id: "#{name}-span"}, fn ->
            NextLoggers.info(logger, Atom.to_string(name))["traceId"]
          end)
        end,
        ordered: true
      )
      |> Enum.map(fn {:ok, trace_id} -> trace_id end)

    assert traces == ["trace-a", "trace-b"]
  end

  test "per-event OTEL routing preserves ordinary transports" do
    parent = self()

    logger =
      NextLoggers.new("routing",
        transports: [
          fn record ->
            send(parent, {:ordinary, record["message"]})
            :ok
          end,
          NextLoggers.otel_transport(fn record -> send(parent, {:otel, record["body"]}) end)
        ]
      )

    NextLoggers.log(logger, "INFO", "default", %{})
    NextLoggers.log(logger, "INFO", "ordinary-only", %{}, otel: false)
    assert NextLoggers.use_otel(logger).otel
    refute NextLoggers.not_otel(logger).otel

    assert_receive {:ordinary, "default"}
    assert_receive {:otel, "default"}
    assert_receive {:ordinary, "ordinary-only"}
    refute_receive {:otel, "ordinary-only"}, 20
  end
end
