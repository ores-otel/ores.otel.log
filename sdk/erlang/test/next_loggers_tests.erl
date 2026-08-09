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
    ?assertEqual(#{}, next_loggers:current_context()).

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

collect(0, Values) -> Values;
collect(Remaining, Values) ->
    receive
        {Name, TraceId} -> collect(Remaining - 1, maps:put(Name, TraceId, Values))
    after 1000 ->
        error(timeout)
    end.
