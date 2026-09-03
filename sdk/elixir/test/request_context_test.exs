defmodule ORESoftware.NextLoggers.RequestContextTest do
  use ExUnit.Case, async: true

  alias ORESoftware.NextLoggers.RequestContext

  test "request context is scoped, queryable, and restored" do
    assert RequestContext.current() == nil

    captured =
      RequestContext.with_context(
        %{
          request_id: "request-elixir",
          logged_in_user_id: "user-elixir",
          tenant_id: "tenant-elixir",
          session_id: "session-elixir",
          correlation_id: "correlation-elixir"
        },
        fn ->
          assert RequestContext.request_id() == "request-elixir"
          assert RequestContext.logged_in_user_id() == "user-elixir"
          assert RequestContext.tenant_id() == "tenant-elixir"
          assert RequestContext.session_id() == "session-elixir"
          assert RequestContext.correlation_id() == "correlation-elixir"
          RequestContext.capture()
        end
      )

    assert captured.schema == RequestContext.schema()
    assert captured.fields["request.id"] == "request-elixir"
    assert captured.fields["user.id"] == "user-elixir"
    assert RequestContext.current() == nil
  end

  test "nested scopes merge and restore their parent" do
    RequestContext.with_context(
      %{request_id: "request-parent", tenant_id: "tenant-parent"},
      fn ->
        RequestContext.with_context(
          %{request_id: "request-child", session_id: "session-child"},
          fn ->
            assert RequestContext.request_id() == "request-child"
            assert RequestContext.tenant_id() == "tenant-parent"
            assert RequestContext.session_id() == "session-child"
          end
        )

        assert RequestContext.request_id() == "request-parent"
        assert RequestContext.session_id() == nil
      end
    )
  end

  test "spawned processes receive context only through explicit snapshot re-entry" do
    parent = self()

    RequestContext.with_context(
      %{request_id: "request-spawn", logged_in_user_id: "user-spawn"},
      fn ->
        _pid =
          RequestContext.spawn_with_current(fn ->
            send(
              parent,
              {:request_context, RequestContext.request_id(),
               RequestContext.logged_in_user_id()}
            )
          end)

        assert_receive {:request_context, "request-spawn", "user-spawn"}, 1_000
      end
    )
  end

  test "tasks receive an immutable captured snapshot" do
    result =
      RequestContext.with_context(%{request_id: "request-task"}, fn ->
        RequestContext.task_with_current(fn -> RequestContext.request_id() end)
        |> Task.await(1_000)
      end)

    assert result == "request-task"
  end
end
