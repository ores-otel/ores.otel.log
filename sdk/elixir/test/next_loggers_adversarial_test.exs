defmodule ORESoftware.NextLoggersAdversarialTest do
  use ExUnit.Case, async: true

  alias ORESoftware.NextLoggers

  test "nested contexts restore the parent" do
    assert NextLoggers.current_context() == %{}

    NextLoggers.with_context(%{trace_id: "parent", span_id: "span-parent"}, fn ->
      assert NextLoggers.current_context().trace_id == "parent"

      NextLoggers.with_context(%{trace_id: "child", span_id: "span-child"}, fn ->
        assert NextLoggers.current_context().trace_id == "child"
      end)

      assert NextLoggers.current_context().trace_id == "parent"
    end)

    assert NextLoggers.current_context() == %{}
  end

  test "context restores after a raised exception" do
    assert_raise RuntimeError, "context failure", fn ->
      NextLoggers.with_context(%{trace_id: "error"}, fn ->
        raise "context failure"
      end)
    end

    assert NextLoggers.current_context() == %{}
  end

  test "context restores after throw" do
    token = make_ref()

    assert catch_throw(
             NextLoggers.with_context(%{trace_id: "throw"}, fn ->
               throw(token)
             end)
           ) == token

    assert NextLoggers.current_context() == %{}
  end

  test "context restores after exit" do
    token = {:shutdown, make_ref()}

    assert catch_exit(
             NextLoggers.with_context(%{trace_id: "exit"}, fn ->
               exit(token)
             end)
           ) == token

    assert NextLoggers.current_context() == %{}
  end

  test "100 BEAM processes never cross-contaminate context" do
    logger = NextLoggers.new("concurrency")

    records =
      0..99
      |> Task.async_stream(
        fn index ->
          suffix = index |> Integer.to_string() |> String.pad_leading(3, "0")
          trace = "trace-#{suffix}"
          span = "span-#{suffix}"
          message = "message-#{suffix}"

          record =
            NextLoggers.with_context(%{trace_id: trace, span_id: span, trace_flags: 1}, fn ->
              Process.sleep(rem(index, 7))
              NextLoggers.info(logger, message)
            end)

          assert NextLoggers.current_context() == %{}
          {message, record}
        end,
        max_concurrency: 100,
        ordered: false,
        timeout: 5_000
      )
      |> Enum.map(fn {:ok, value} -> value end)

    assert length(records) == 100

    Enum.each(records, fn {message, record} ->
      suffix = String.replace_prefix(message, "message-", "")
      assert record["traceId"] == "trace-#{suffix}"
      assert record["fields"]["otel.span_id"] == "span-#{suffix}"
    end)
  end

  test "field precedence is logger then context then event" do
    logger =
      NextLoggers.new("precedence",
        fields: %{"source" => "logger", "loggerOnly" => true}
      )

    record =
      NextLoggers.with_context(
        %{fields: %{"source" => "context", "contextOnly" => true}},
        fn ->
          NextLoggers.info(logger, "inside", %{"source" => "event", "eventOnly" => true})
        end
      )

    assert record["fields"]["source"] == "event"
    assert record["fields"]["loggerOnly"] == true
    assert record["fields"]["contextOnly"] == true
    assert record["fields"]["eventOnly"] == true
  end

  test "records without context omit correlation optionals" do
    record = NextLoggers.info(NextLoggers.new("plain"), "plain")
    refute Map.has_key?(record, "traceId")
    refute Map.has_key?(record, "traceIds")
    refute Map.has_key?(record, "tags")
    refute Map.has_key?(record["fields"], "otel.span_id")
    assert record["fields"]["otel.trace_flags"] == 0
  end

  test "empty trace and tags are omitted" do
    record =
      NextLoggers.with_context(%{trace_id: "", span_id: "", tags: []}, fn ->
        NextLoggers.info(NextLoggers.new("empty"), "inside")
      end)

    refute Map.has_key?(record, "traceId")
    refute Map.has_key?(record, "traceIds")
    refute Map.has_key?(record, "tags")
    refute Map.has_key?(record["fields"], "otel.span_id")
  end

  test "all OTEL severity mappings are stable" do
    owner = self()

    logger =
      NextLoggers.new("severity",
        transports: [NextLoggers.otel_transport(fn value -> send(owner, {:otel, value}) end)]
      )

    expected = [
      {"TRACE", 1},
      {"DEBUG", 5},
      {"INFO", 9},
      {"WARN", 13},
      {"ERROR", 17},
      {"FATAL", 21}
    ]

    Enum.each(expected, fn {level, _number} ->
      NextLoggers.log(logger, level, String.downcase(level), %{})
    end)

    actual =
      Enum.map(expected, fn _ ->
        assert_receive {:otel, value}
        {value["severityText"], value["severityNumber"]}
      end)

    assert actual == expected
  end

  test "OTEL copies trace and structured fields" do
    owner = self()

    logger =
      NextLoggers.new("otel",
        transports: [NextLoggers.otel_transport(fn value -> send(owner, {:otel, value}) end)]
      )

    NextLoggers.with_context(
      %{
        trace_id: "trace-otel",
        span_id: "span-otel",
        trace_flags: 1,
        fields: %{"requestId" => "request-1"}
      },
      fn -> NextLoggers.error(logger, "failed", %{"orderId" => "order-42"}) end
    )

    assert_receive {:otel, value}
    assert value["body"] == "failed"
    assert value["severityNumber"] == 17
    assert value["attributes"]["trace.id"] == "trace-otel"
    assert value["attributes"]["next_logger.field.otel.span_id"] == "span-otel"
    assert value["attributes"]["next_logger.field.orderId"] == "order-42"
  end

  test "Supabase receives the canonical wire record" do
    owner = self()

    logger =
      NextLoggers.new("supabase",
        transports: [NextLoggers.supabase_transport(fn value -> send(owner, {:supabase, value}) end)]
      )

    record = NextLoggers.info(logger, "client", %{"safe" => true})
    assert_receive {:supabase, captured}
    assert captured == record
  end

  test "transports run in configured order" do
    owner = self()

    transport = fn index ->
      fn _record ->
        send(owner, {:transport_order, index})
        :ok
      end
    end

    logger =
      NextLoggers.new("order",
        transports: [transport.(1), transport.(2), transport.(3)]
      )

    NextLoggers.info(logger, "ordered")
    assert_receive {:transport_order, 1}
    assert_receive {:transport_order, 2}
    assert_receive {:transport_order, 3}
  end

  test "invalid transport return is rejected with context" do
    logger = NextLoggers.new("failure", transports: [fn _record -> {:error, :sink} end])

    error =
      assert_raise RuntimeError, fn ->
        NextLoggers.error(logger, "failed")
      end

    assert error.message =~ "transport returned"
    assert error.message =~ "{:error, :sink}"
  end

  test "transport exceptions preserve their identity" do
    token = make_ref()
    logger = NextLoggers.new("throwing", transports: [fn _record -> throw(token) end])

    assert catch_throw(NextLoggers.error(logger, "failed")) == token
  end

  test "invalid application names are rejected" do
    assert_raise ArgumentError, "app_name must not be empty", fn ->
      NextLoggers.new(" ")
    end
  end

  test "generated IDs are unique" do
    logger = NextLoggers.new("ids")

    ids =
      for index <- 1..1_000 do
        NextLoggers.info(logger, "id-#{index}")["id"]
      end

    assert length(Enum.uniq(ids)) == length(ids)
  end

  test "deterministic ID and clock hooks are honored" do
    logger =
      NextLoggers.new("deterministic",
        id_factory: fn -> "fixed-id" end,
        clock: fn -> "2026-01-02T03:04:05.000Z" end
      )

    record = NextLoggers.info(logger, "fixed")
    assert record["id"] == "fixed-id"
    assert record["timestamp"] == "2026-01-02T03:04:05.000Z"
  end

  test "runtime and logger name are preserved" do
    logger = NextLoggers.new("named", name: "audit", runtime: "beam-native")
    record = NextLoggers.info(logger, "named")
    assert record["name"] == "audit"
    assert record["runtime"] == "beam-native"
  end

  test "context tags are deduplicated in first-seen order" do
    record =
      NextLoggers.with_context(
        %{trace_id: "trace", tags: ["otel", "beam", "otel", "request"]},
        fn -> NextLoggers.info(NextLoggers.new("tags"), "tagged") end
      )

    assert record["tags"] == ["otel", "beam", "request"]
  end

  test "wire schema values and nested fields stay stable" do
    record =
      NextLoggers.info(
        NextLoggers.new("wire", fields: %{"environment" => "test"}),
        "hello",
        %{"nested" => %{"safe" => true}}
      )

    assert record["schema"] == NextLoggers.schema()
    assert record["values"] == ["hello"]
    assert record["fields"]["environment"] == "test"
    assert record["fields"]["nested"] == %{"safe" => true}
  end

  test "trace flags and trace state are copied exactly" do
    record =
      NextLoggers.with_context(
        %{
          trace_id: "trace",
          span_id: "span",
          trace_flags: 3,
          trace_state: "vendor=value"
        },
        fn -> NextLoggers.info(NextLoggers.new("trace-state"), "inside") end
      )

    assert record["fields"]["otel.trace_flags"] == 3
    assert record["fields"]["otel.trace_state"] == "vendor=value"
  end

  test "process context remains empty after repeated scopes" do
    Enum.each(1..100, fn index ->
      NextLoggers.with_context(%{trace_id: "trace-#{index}"}, fn ->
        assert NextLoggers.current_context().trace_id == "trace-#{index}"
      end)

      assert NextLoggers.current_context() == %{}
    end)
  end
end
