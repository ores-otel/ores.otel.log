-module(next_loggers_adversarial_tests).
-include_lib("eunit/include/eunit.hrl").

nested_context_restoration_test() ->
    ?assertEqual(undefined, next_loggers:current_context()),
    Parent = #{trace_id => <<"parent">>},
    Child = #{trace_id => <<"child">>},
    next_loggers:with_context(Parent, fun() ->
        ?assertEqual(Parent, next_loggers:current_context()),
        next_loggers:with_context(Child, fun() ->
            ?assertEqual(Child, next_loggers:current_context())
        end),
        ?assertEqual(Parent, next_loggers:current_context())
    end),
    ?assertEqual(undefined, next_loggers:current_context()).

context_restores_after_exception_test() ->
    Token = make_ref(),
    Result = try next_loggers:with_context(
        #{trace_id => <<"panic">>},
        fun() -> throw(Token) end
    ) catch
        throw:Caught -> Caught
    end,
    ?assertEqual(Token, Result),
    ?assertEqual(undefined, next_loggers:current_context()).

process_context_isolation_stress_test() ->
    Parent = self(),
    Count = 100,
    Pids = [spawn(fun() ->
        Trace = iolist_to_binary(io_lib:format("trace-~3..0B", [Index])),
        next_loggers:with_context(#{trace_id => Trace}, fun() ->
            timer:sleep(Index rem 5),
            Parent ! {context_result, Trace, next_loggers:current_context()}
        end),
        Parent ! {context_cleared, self(), next_loggers:current_context()}
    end) || Index <- lists:seq(1, Count)],
    Results = collect_context_results(Count, []),
    Clears = collect_context_clears(Count, []),
    ?assertEqual(Count, length(Pids)),
    ?assert(lists:all(fun({Trace, Context}) ->
        maps:get(trace_id, Context) =:= Trace
    end, Results)),
    ?assert(lists:all(fun({_Pid, Value}) -> Value =:= undefined end, Clears)),
    ?assertEqual(undefined, next_loggers:current_context()).

explicit_trace_remains_primary_test() ->
    Logger = logger(info),
    next_loggers:with_context(
        #{trace_id => <<"ambient">>, span_id => <<"ambient-span">>},
        fun() ->
            Event = next_loggers:add_trace(
                next_loggers:info(Logger, [<<"inside">>]),
                <<"explicit">>
            ),
            {ok, _} = next_loggers:send(Event)
        end
    ),
    Record = receive_record(),
    ?assertEqual(<<"explicit">>, maps:get(traceId, Record)),
    ?assertEqual([<<"explicit">>, <<"ambient">>], maps:get(traceIds, Record)),
    ?assertEqual(
        <<"ambient-span">>,
        maps:get(<<"otel.span_id">>, maps:get(fields, Record))
    ).

context_merges_all_correlation_fields_test() ->
    Logger = logger(info),
    Context = #{
        trace_id => <<"trace-1">>,
        span_id => <<"span-1">>,
        trace_flags => 1,
        trace_state => <<"vendor=value">>,
        baggage => #{tenant => <<"acme">>},
        fields => #{route => <<"/pay">>},
        tags => [<<"request">>]
    },
    next_loggers:with_context(Context, fun() ->
        Event = next_loggers:add_fields(
            next_loggers:info(Logger, [<<"inside">>]),
            #{event => true}
        ),
        {ok, _} = next_loggers:send(Event)
    end),
    Record = receive_record(),
    Fields = maps:get(fields, Record),
    ?assertEqual(<<"trace-1">>, maps:get(traceId, Record)),
    ?assertEqual(<<"span-1">>, maps:get(<<"otel.span_id">>, Fields)),
    ?assertEqual(1, maps:get(<<"otel.trace_flags">>, Fields)),
    ?assertEqual(<<"vendor=value">>, maps:get(<<"otel.trace_state">>, Fields)),
    ?assertEqual(<<"/pay">>, maps:get(<<"route">>, Fields)),
    ?assertEqual(true, maps:get(<<"event">>, Fields)),
    ?assert(lists:member(<<"otel">>, maps:get(tags, Record))),
    ?assert(lists:member(<<"request">>, maps:get(tags, Record))).

minimum_level_filters_before_transport_test() ->
    Logger = logger(warn),
    Events = [
        next_loggers:trace(Logger, [<<"trace">>]),
        next_loggers:debug(Logger, [<<"debug">>]),
        next_loggers:info(Logger, [<<"info">>]),
        next_loggers:warn(Logger, [<<"warn">>]),
        next_loggers:error(Logger, [<<"error">>]),
        next_loggers:fatal(Logger, [<<"fatal">>])
    ],
    lists:foreach(fun(Event) -> {ok, _} = next_loggers:send(Event) end, Events),
    Records = collect_records(3, []),
    ?assertEqual(
        [<<"WARN">>, <<"ERROR">>, <<"FATAL">>],
        [maps:get(level, Record) || Record <- Records]
    ),
    receive
        {next_loggers_record, Unexpected} ->
            ?assertEqual(no_extra_records_expected, Unexpected)
    after 25 -> ok
    end.

sent_event_is_idempotent_test() ->
    Logger = logger(info),
    {ok, Sent} = next_loggers:send(next_loggers:info(Logger, [<<"once">>])),
    {ok, SentAgain} = next_loggers:send(Sent),
    ?assertEqual(Sent, SentAgain),
    Record = receive_record(),
    ?assertEqual(<<"once">>, maps:get(message, Record)),
    receive
        {next_loggers_record, Unexpected} ->
            ?assertEqual(no_duplicate_expected, Unexpected)
    after 25 -> ok
    end.

transport_failure_is_returned_without_corrupting_record_test() ->
    Parent = self(),
    Logger = next_loggers:new(#{
        app_name => <<"transport-failure">>,
        transport => fun(Record) ->
            Parent ! {attempted_record, Record},
            {error, sink_unavailable}
        end
    }),
    ?assertEqual(
        {error, sink_unavailable},
        next_loggers:send(next_loggers:error(Logger, [<<"failed">>]))
    ),
    receive
        {attempted_record, Record} ->
            ?assertEqual(<<"next-loggers/v1">>, maps:get(schema, Record)),
            ?assertEqual(<<"failed">>, maps:get(message, Record)),
            ?assertEqual(<<"ERROR">>, maps:get(level, Record))
    after 1000 -> ?assert(false)
    end.

callback_throw_identity_and_span_cleanup_test() ->
    Parent = self(),
    Logger = logger(debug),
    Token = make_ref(),
    Tracer = stable_tracer(Parent),
    Result = try
        next_loggers:with_span(
            Logger,
            Tracer,
            <<"throwing">>,
            #{},
            fun(_Span) -> throw(Token) end
        )
    catch
        throw:Caught -> {caught, Caught}
    end,
    ?assertEqual({caught, Token}, Result),
    receive {recorded, throw, Token} -> ok after 1000 -> ?assert(false) end,
    receive {status, 2, _Description} -> ok after 1000 -> ?assert(false) end,
    receive ended -> ok after 1000 -> ?assert(false) end.

callback_error_identity_and_span_cleanup_test() ->
    Parent = self(),
    Logger = logger(debug),
    Tracer = stable_tracer(Parent),
    Result = try
        next_loggers:with_span(
            Logger,
            Tracer,
            <<"erroring">>,
            #{},
            fun(_Span) -> erlang:error(declined) end
        )
    catch
        error:Reason -> {caught, Reason}
    end,
    ?assertEqual({caught, declined}, Result),
    receive {recorded, error, declined} -> ok after 1000 -> ?assert(false) end,
    receive {status, 2, _Description} -> ok after 1000 -> ?assert(false) end,
    receive ended -> ok after 1000 -> ?assert(false) end.

start_failure_and_invalid_result_use_noop_span_test() ->
    Logger = logger(debug),
    Failing = (stable_tracer(self()))#{
        start := fun(_Name, _Attributes) -> erlang:error(sdk_unavailable) end
    },
    Invalid = (stable_tracer(self()))#{
        start := fun(_Name, _Attributes) -> invalid_result end
    },
    ?assertEqual(
        71,
        next_loggers:with_span(
            Logger, Failing, <<"failure">>, #{}, fun(Span) ->
                ?assert(Span =:= noop_span),
                71
            end
        )
    ),
    ?assertEqual(
        73,
        next_loggers:with_span(
            Logger, Invalid, <<"invalid">>, #{}, fun(Span) ->
                ?assert(Span =:= noop_span),
                73
            end
        )
    ),
    ?assert(receive_bridge_operation(<<"start span">>)),
    ?assert(receive_bridge_operation(<<"start span">>)).

sampled_out_spans_correlate_without_recording_mutations_test() ->
    Parent = self(),
    Logger = logger(debug),
    Tracer = (stable_tracer(Parent))#{
        is_recording => fun(_Span) -> false end
    },
    ?assertEqual(
        77,
        next_loggers:with_span(
            Logger,
            Tracer,
            <<"sampled-out">>,
            #{},
            fun(_Span) ->
                ?assert(maps:get(trace_id, next_loggers:current_context()) =:= <<"trace-span">>),
                {ok, _} = next_loggers:send(next_loggers:info(Logger, [<<"inside sampled-out">>])),
                77
            end
        )
    ),
    receive {status, _, _} -> ?assert(false) after 25 -> ok end,
    receive {recorded, _, _} -> ?assert(false) after 25 -> ok end,
    receive ended -> ok after 1000 -> ?assert(false) end.

lifecycle_failures_never_replace_success_test() ->
    Logger = logger(debug),
    Broken = #{
        start => fun(_Name, _Attributes) ->
            {span, #{trace_id => <<"trace-resilient">>}}
        end,
        set_status => fun(_Span, _Code, _Description) ->
            erlang:error(status_unavailable)
        end,
        record_exception => fun(_Span, _Class, _Reason, _Stack) ->
            erlang:error(record_unavailable)
        end,
        'end' => fun(_Span) -> erlang:error(end_unavailable) end
    },
    ?assertEqual(
        79,
        next_loggers:with_span(
            Logger, Broken, <<"resilient">>, #{}, fun(_Span) -> 79 end
        )
    ),
    ?assert(receive_bridge_operation(<<"set success status">>)),
    ?assert(receive_bridge_operation(<<"end span">>)).

logger(Level) ->
    next_loggers:new(#{
        app_name => <<"erlang-adversarial">>,
        minimum_level => Level,
        transport => next_loggers:memory_transport(),
        console => false
    }).

stable_tracer(Parent) ->
    #{
        start => fun(_Name, _Attributes) ->
            {span, #{
                trace_id => <<"trace-span">>,
                span_id => <<"span-span">>,
                trace_flags => 1
            }}
        end,
        set_status => fun(_Span, Code, Description) ->
            Parent ! {status, Code, Description},
            ok
        end,
        record_exception => fun(_Span, Class, Reason, _Stack) ->
            Parent ! {recorded, Class, Reason},
            ok
        end,
        'end' => fun(_Span) -> Parent ! ended, ok end
    }.

receive_record() ->
    receive
        {next_loggers_record, Record} -> Record
    after 1000 ->
        ?assert(false)
    end.

collect_records(0, Acc) -> lists:reverse(Acc);
collect_records(Count, Acc) ->
    receive
        {next_loggers_record, Record} -> collect_records(Count - 1, [Record | Acc])
    after 1000 ->
        ?assert(false)
    end.

collect_context_results(0, Acc) -> Acc;
collect_context_results(Count, Acc) ->
    receive
        {context_result, Trace, Context} ->
            collect_context_results(Count - 1, [{Trace, Context} | Acc])
    after 5000 ->
        ?assert(false)
    end.

collect_context_clears(0, Acc) -> Acc;
collect_context_clears(Count, Acc) ->
    receive
        {context_cleared, Pid, Value} ->
            collect_context_clears(Count - 1, [{Pid, Value} | Acc])
    after 5000 ->
        ?assert(false)
    end.

receive_bridge_operation(Operation) ->
    receive
        {next_loggers_record, Record} ->
            Fields = maps:get(fields, Record, #{}),
            case maps:get(<<"otel.bridge_operation">>, Fields, undefined) of
                Operation -> true;
                _ -> receive_bridge_operation(Operation)
            end
    after 1000 -> false
    end.
