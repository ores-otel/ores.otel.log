-module(next_loggers_tests).

-include_lib("eunit/include/eunit.hrl").

process_context_and_transports_test() ->
    Parent = self(),
    Logger = next_loggers:new(
        <<"payments">>,
        <<"erlang">>,
        #{<<"environment">> => <<"test">>},
        [
            next_loggers:otel_transport(fun(Value) -> Parent ! {otel, Value} end),
            next_loggers:supabase_transport(fun(Value) -> Parent ! {supabase, Value} end)
        ]
    ),
    Record = next_loggers:with_context(
        #{
            trace_id => <<"0123456789abcdef0123456789abcdef">>,
            span_id => <<"0123456789abcdef">>,
            trace_flags => 1,
            trace_state => <<"vendor=value">>,
            fields => #{<<"requestId">> => <<"request-1">>},
            tags => [<<"otel">>, <<"beam">>]
        },
        fun() ->
            next_loggers:error(Logger, <<"payment failed">>, #{<<"orderId">> => <<"order-42">>})
        end
    ),
    ?assertEqual(<<"next-loggers/v1">>, maps:get(schema, Record)),
    ?assertEqual(<<"ERROR">>, maps:get(level, Record)),
    ?assertEqual(<<"0123456789abcdef0123456789abcdef">>, maps:get(traceId, Record)),
    Fields = maps:get(fields, Record),
    ?assertEqual(<<"0123456789abcdef">>, maps:get(<<"otel.span_id">>, Fields)),
    ?assertEqual(<<"request-1">>, maps:get(<<"requestId">>, Fields)),
    ?assertEqual(<<"order-42">>, maps:get(<<"orderId">>, Fields)),
    receive
        {otel, Otel} -> ?assertEqual(17, maps:get(severityNumber, Otel))
    after 1000 ->
        ?assert(false)
    end,
    receive
        {supabase, Supabase} -> ?assertEqual(Record, Supabase)
    after 1000 ->
        ?assert(false)
    end,
    ?assertEqual(undefined, next_loggers:current_context()).

concurrent_processes_keep_context_isolated_test() ->
    Parent = self(),
    Logger = next_loggers:new(<<"app">>, <<"erlang">>, []),
    Spawn = fun(Name, TraceId) ->
        spawn(fun() ->
            next_loggers:with_context(
                #{trace_id => TraceId, span_id => <<Name/binary, "-span">>},
                fun() ->
                    Record = next_loggers:info(Logger, Name, #{}),
                    Parent ! {Name, maps:get(traceId, Record)}
                end
            )
        end)
    end,
    _ = Spawn(<<"a">>, <<"trace-a">>),
    _ = Spawn(<<"b">>, <<"trace-b">>),
    Values = collect(2, #{}),
    ?assertEqual(<<"trace-a">>, maps:get(<<"a">>, Values)),
    ?assertEqual(<<"trace-b">>, maps:get(<<"b">>, Values)).

per_event_otel_routing_test() ->
    Parent = self(),
    Logger0 = next_loggers:new(
        <<"routing">>,
        <<"erlang">>,
        [
            next_loggers:otel_transport(fun(Value) -> Parent ! {routed_otel, Value} end),
            next_loggers:supabase_transport(fun(Value) -> Parent ! {regular, Value} end)
        ]
    ),
    Logger = next_loggers:not_otel(Logger0),
    DefaultOff = next_loggers:event(Logger, <<"INFO">>, <<"default-off">>, #{}),
    ?assertNot(next_loggers:is_otel_enabled(DefaultOff, maps:get(otel, Logger))),
    _ = next_loggers:send(DefaultOff),
    receive {regular, #{message := <<"default-off">>}} -> ok after 1000 -> error(timeout) end,
    receive {routed_otel, _} -> ?assert(false) after 10 -> ok end,

    Forced = next_loggers:use_otel(next_loggers:event(Logger, <<"INFO">>, <<"forced-on">>, #{})),
    _ = next_loggers:send(Forced),
    receive {routed_otel, #{body := <<"forced-on">>}} -> ok after 1000 -> error(timeout) end,
    receive {regular, #{message := <<"forced-on">>}} -> ok after 1000 -> error(timeout) end,

    LoggerOn = next_loggers:use_otel(Logger),
    ForcedOff = next_loggers:not_otel(next_loggers:event(LoggerOn, <<"WARN">>, <<"forced-off">>, #{})),
    _ = next_loggers:send(ForcedOff),
    receive {regular, #{message := <<"forced-off">>}} -> ok after 1000 -> error(timeout) end,
    receive {routed_otel, _} -> ?assert(false) after 10 -> ok end.

collect(0, Values) -> Values;
collect(Remaining, Values) ->
    receive
        {Name, TraceId} -> collect(Remaining - 1, maps:put(Name, TraceId, Values))
    after 1000 ->
        error(timeout)
    end.
