defmodule NextLoggersAdversarialTest do
  use ExUnit.Case, async: true

  defmodule CallbackFailure do
    defexception [:id, message: "callback failed"]
  end

  test "nested process contexts restore the parent" do
    assert NextLoggers.current_context() == nil

    NextLoggers.with_context(%{trace_id: "parent"}, fn ->
      assert NextLoggers.current_context().trace_id == "parent"

      NextLoggers.with_context(%{trace_id: "child"}, fn ->
        assert NextLoggers.current_context().trace_id == "child"
      end)

      assert NextLoggers.current_context().trace_id == "parent"
    end)

    assert NextLoggers.current_context() == nil
  end

  test "context is restored after an exception" do
    assert_raise RuntimeError, "inside context", fn ->
      NextLoggers.with_context(%{trace_id: "failure"}, fn ->
        assert NextLoggers.current_context().trace_id == "failure"
        raise "inside context"
      end)
    end

    assert NextLoggers.current_context() == nil
  end

  test "100 BEAM processes never cross-contaminate context" do
    parent = self()
    count = 100

    pids =
      for index <- 1..count do
        spawn(fn ->
          trace = "trace-#{String.pad_leading(Integer.to_string(index), 3, "0")}" 

          NextLoggers.with_context(%{trace_id: trace}, fn ->
            Process.sleep(rem(index, 5))
            send(parent, {:context_result, trace, NextLoggers.current_context()})
          end)

          send(parent, {:context_cleared, self(), NextLoggers.current_context()})
        end)
      end

    results = collect_context_results(count, [])
    clears = collect_context_clears(count, [])

    assert length(pids) == count
    assert Enum.all?(results, fn {trace, context} -> context.trace_id == trace end)
    assert Enum.all?(clears, fn {_pid, context} -> context == nil end)
    assert NextLoggers.current_context() == nil
  end

  test "explicit trace remains primary while ambient correlation is retained" do
    logger = logger(:info)

    NextLoggers.with_context(
      %{trace_id: "ambient", span_id: "ambient-span", trace_flags: 1},
      fn ->
        assert {:ok, _} =
                 logger
                 |> NextLoggers.info(["inside"])
                 |> NextLoggers.add_trace("explicit")
                 |> NextLoggers.send()
      end
    )

    assert_receive {:next_loggers_record, record}
    assert record.traceId == "explicit"
    assert record.traceIds == ["explicit", "ambient"]
    assert record.fields["otel.span_id"] == "ambient-span"
  end

  test "all correlation fields merge into the stable wire record" do
    logger = logger(:info)

    NextLoggers.with_context(
      %{
        trace_id: "trace-1",
        span_id: "span-1",
        trace_flags: 1,
        trace_state: "vendor=value",
        baggage: %{tenant: "acme"},
        fields: %{route: "/pay"},
        tags: ["request"]
      },
      fn ->
        assert {:ok, _} =
                 logger
                 |> NextLoggers.info(["inside"])
                 |> NextLoggers.add_fields(%{event: true})
                 |> NextLoggers.send()
      end
    )

    assert_receive {:next_loggers_record, record}
    assert record.schema == "next-loggers/v1"
    assert record.traceId == "trace-1"
    assert record.fields["otel.span_id"] == "span-1"
    assert record.fields["otel.trace_flags"] == 1
    assert record.fields["otel.trace_state"] == "vendor=value"
    assert record.fields["route"] == "/pay"
    assert record.fields["event"] == true
    assert "otel" in record.tags
    assert "request" in record.tags
  end

  test "minimum level filters before the transport" do
    logger = logger(:warn)

    for event <- [
          NextLoggers.trace(logger, ["trace"]),
          NextLoggers.debug(logger, ["debug"]),
          NextLoggers.info(logger, ["info"]),
          NextLoggers.warn(logger, ["warn"]),
          NextLoggers.error(logger, ["error"]),
          NextLoggers.fatal(logger, ["fatal"])
        ] do
      assert {:ok, _} = NextLoggers.send(event)
    end

    records = collect_records(3, [])
    assert Enum.map(records, & &1.level) == ["WARN", "ERROR", "FATAL"]
    refute_receive {:next_loggers_record, _}, 25
  end

  test "sending the returned event is idempotent" do
    logger = logger(:info)
    assert {:ok, sent} = NextLoggers.send(NextLoggers.info(logger, ["once"]))
    assert {:ok, sent_again} = NextLoggers.send(sent)
    assert sent_again == sent
    assert_receive {:next_loggers_record, %{message: "once"}}
    refute_receive {:next_loggers_record, _}, 25
  end

  test "transport errors are returned after receiving the complete record" do
    owner = self()

    logger =
      NextLoggers.new(
        app_name: "transport-failure",
        transport: fn record ->
          send(owner, {:attempted_record, record})
          {:error, :sink_unavailable}
        end
      )

    assert {:error, :sink_unavailable} =
             logger
             |> NextLoggers.error(["failed"])
             |> NextLoggers.send()

    assert_receive {:attempted_record, record}
    assert record.schema == "next-loggers/v1"
    assert record.level == "ERROR"
    assert record.message == "failed"
  end

  test "callback exception identity and stack are preserved" do
    logger = logger(:debug)
    expected = %CallbackFailure{id: make_ref(), message: "declined"}
    tracer = stable_tracer(self())

    caught =
      try do
        NextLoggers.with_span(logger, tracer, "failure", %{}, fn _span ->
          raise expected
        end)
      rescue
        error in CallbackFailure -> {error, __STACKTRACE__}
      end

    assert {actual, stacktrace} = caught
    assert actual.id == expected.id
    assert actual.message == "declined"
    assert Enum.any?(stacktrace, fn {module, _function, _arity, _metadata} ->
             module == __MODULE__
           end)

    assert_receive {:recorded, :error, %CallbackFailure{id: id}}
    assert id == expected.id
    assert_receive {:status, 2, "declined"}
    assert_receive :ended
  end

  test "callback throw identity and cleanup are preserved" do
    logger = logger(:debug)
    tracer = stable_tracer(self())
    token = make_ref()

    assert catch_throw(
             NextLoggers.with_span(logger, tracer, "throwing", %{}, fn _span ->
               throw(token)
             end)
           ) == token

    assert_receive {:recorded, :throw, ^token}
    assert_receive {:status, 2, _description}
    assert_receive :ended
  end

  test "callback exit identity and cleanup are preserved" do
    logger = logger(:debug)
    tracer = stable_tracer(self())
    token = {:shutdown, make_ref()}

    assert catch_exit(
             NextLoggers.with_span(logger, tracer, "exiting", %{}, fn _span ->
               exit(token)
             end)
           ) == token

    assert_receive {:recorded, :exit, ^token}
    assert_receive {:status, 2, _description}
    assert_receive :ended
  end

  test "start failure and invalid start results use the no-op span" do
    logger = logger(:debug)
    base = stable_tracer(self())

    failing = %{
      base
      | start: fn _name, _attributes -> raise "sdk unavailable" end
    }

    invalid = %{
      base
      | start: fn _name, _attributes -> :invalid_start_result end
    }

    assert 71 ==
             NextLoggers.with_span(logger, failing, "failure", %{}, fn span ->
               assert span == :noop_span
               71
             end)

    assert 73 ==
             NextLoggers.with_span(logger, invalid, "invalid", %{}, fn span ->
               assert span == :noop_span
               73
             end)

    assert bridge_failure?("start span")
    assert bridge_failure?("start span")
  end

  test "status, exception, end, and logger sink failures never replace success" do
    logger = logger(:debug)

    broken = %{
      start: fn _name, _attributes ->
        {:span, %{trace_id: "trace-resilient"}}
      end,
      set_status: fn _span, _code, _description -> raise "status unavailable" end,
      record_exception: fn _span, _kind, _reason, _stack ->
        raise "record unavailable"
      end,
      end: fn _span -> raise "end unavailable" end
    }

    assert 79 ==
             NextLoggers.with_span(logger, broken, "resilient", %{}, fn _span ->
               79
             end)

    assert bridge_failure?("set success status")
    assert bridge_failure?("end span")

    sink_logger =
      NextLoggers.new(
        minimum_level: :debug,
        transport: fn _record -> {:error, :sink_unavailable} end
      )

    assert 83 ==
             NextLoggers.with_span(
               sink_logger,
               broken,
               "sink-failure",
               %{},
               fn _span -> 83 end
             )
  end

  defp logger(level) do
    NextLoggers.new(
      app_name: "elixir-adversarial",
      minimum_level: level,
      transport: NextLoggers.memory_transport(),
      console: false
    )
  end

  defp stable_tracer(owner) do
    %{
      start: fn _name, _attributes ->
        {:span,
         %{
           trace_id: "trace-span",
           span_id: "span-span",
           trace_flags: 1
         }}
      end,
      set_status: fn _span, code, description ->
        send(owner, {:status, code, description})
      end,
      record_exception: fn _span, kind, reason, _stacktrace ->
        send(owner, {:recorded, kind, reason})
      end,
      end: fn _span -> send(owner, :ended) end
    }
  end

  defp collect_records(0, records), do: Enum.reverse(records)

  defp collect_records(count, records) do
    receive do
      {:next_loggers_record, record} ->
        collect_records(count - 1, [record | records])
    after
      1_000 -> flunk("timed out waiting for #{count} records")
    end
  end

  defp collect_context_results(0, results), do: results

  defp collect_context_results(count, results) do
    receive do
      {:context_result, trace, context} ->
        collect_context_results(count - 1, [{trace, context} | results])
    after
      5_000 -> flunk("timed out waiting for #{count} context results")
    end
  end

  defp collect_context_clears(0, results), do: results

  defp collect_context_clears(count, results) do
    receive do
      {:context_cleared, pid, context} ->
        collect_context_clears(count - 1, [{pid, context} | results])
    after
      5_000 -> flunk("timed out waiting for #{count} context clears")
    end
  end

  defp bridge_failure?(operation) do
    receive do
      {:next_loggers_record, record} ->
        if record.fields["otel.bridge_operation"] == operation do
          true
        else
          bridge_failure?(operation)
        end
    after
      1_000 -> false
    end
  end
end
