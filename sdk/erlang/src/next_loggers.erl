-module(next_loggers).

-compile({no_auto_import, [error/2]}).

-export([
    new/1,
    new/3,
    new/4,
    trace/2,
    debug/2,
    info/2,
    warn/2,
    error/2,
    info/3,
    error/3,
    log/4,
    log/5,
    event/4,
    fatal/2,
    add_fields/2,
    add_trace/2,
    add_tags/2,
    add_routine_id/2,
    add_context/2,
    add_meta/2,
    record/1,
    send/1,
    with_context/2,
    current_context/0,
    apply_context/1,
    with_span/5,
    memory_transport/0,
    otel_transport/1,
    supabase_transport/1,
    use_otel/1,
    not_otel/1,
    with_otel/2,
    reset_otel/1,
    is_otel_enabled/1,
    is_otel_enabled/2
]).

-define(SCHEMA, <<"next-loggers/v1">>).
-define(CONTEXT_KEY, '$next_loggers_context').

new(Options) when is_map(Options) ->
    #{
        app_name => maps:get(app_name, Options, <<"app">>),
        name => maps:get(name, Options, undefined),
        runtime => maps:get(runtime, Options, <<"erlang">>),
        minimum_level => maps:get(minimum_level, Options, info),
        fields => maps:get(fields, Options, #{}),
        logged_in_user => maps:get(logged_in_user, Options, #{}),
        transport => maps:get(transport, Options, fun default_transport/1),
        id_factory => maps:get(id_factory, Options, fun default_id/0),
        clock => maps:get(clock, Options, fun default_clock/0),
        console => maps:get(console, Options, false),
        otel => maps:get(otel, Options, true)
    }.

new(AppName, Runtime, Transports) -> new(AppName, Runtime, #{}, Transports).

new(AppName, Runtime, Fields, Transports)
        when is_binary(AppName), is_binary(Runtime), is_map(Fields), is_list(Transports) ->
    case byte_size(AppName) of
        0 -> erlang:error({invalid_app_name, AppName});
        _ -> #{
            direct => true,
            app_name => AppName,
            runtime => Runtime,
            name => undefined,
            fields => Fields,
            transports => Transports,
            otel => true,
            id_factory => fun default_id/0,
            clock => fun default_clock/0
        }
    end.

trace(Logger, Values) -> event(Logger, trace, Values).
debug(Logger, Values) -> event(Logger, debug, Values).
info(Logger, Values) -> event(Logger, info, Values).
warn(Logger, Values) -> event(Logger, warn, Values).
error(Logger, Values) -> event(Logger, error, Values).
fatal(Logger, Values) -> event(Logger, fatal, Values).

event(Logger, Level, Values) ->
    #{
        logger => Logger,
        level => Level,
        values => ensure_list(Values),
        fields => #{},
        trace_id => undefined,
        trace_ids => [],
        routine_id => undefined,
        tags => [],
        context => [],
        meta => [],
        sent => false,
        cached_record => undefined,
        otel => undefined
    }.

%% Compatibility event constructor for the direct/polyglot API.  It returns
%% the same fluent event value as the native Erlang API, so context, delivery,
%% idempotence, and per-event OpenTelemetry routing all share one code path.
event(Logger, Level, Message, EventFields)
        when is_map(Logger), is_binary(Level), is_binary(Message), is_map(EventFields) ->
    CompatLogger = Logger#{
        minimum_level => maps:get(minimum_level, Logger, trace),
        logged_in_user => maps:get(logged_in_user, Logger, #{}),
        transport => {multiplex, maps:get(transports, Logger, [])},
        console => maps:get(console, Logger, false)
    },
    add_fields(event(CompatLogger, level_atom(Level), Message), EventFields).

use_otel(Value) -> with_otel(Value, true).
not_otel(Value) -> with_otel(Value, false).
with_otel(Value, Enabled) when is_boolean(Enabled) -> Value#{otel => Enabled}.
reset_otel(Event = #{logger := _}) -> Event#{otel => undefined};
reset_otel(Logger) -> Logger#{otel => true}.
is_otel_enabled(#{logger := Logger, otel := undefined}) -> maps:get(otel, Logger, true);
is_otel_enabled(#{otel := Enabled}) -> Enabled.
is_otel_enabled(#{otel := undefined}, Fallback) when is_boolean(Fallback) -> Fallback;
is_otel_enabled(#{otel := Enabled}, _Fallback) when is_boolean(Enabled) -> Enabled.

add_fields(Event, Fields) when is_map(Fields) ->
    Event#{fields := maps:merge(maps:get(fields, Event), Fields)}.

add_trace(Event, TraceId) ->
    Value = to_binary(TraceId),
    case Value of
        <<>> -> Event;
        _ ->
            Current = maps:get(trace_id, Event),
            First = case Current of undefined -> Value; _ -> Current end,
            Event#{
                trace_id := First,
                trace_ids := unique_append(maps:get(trace_ids, Event), Value)
            }
    end.

add_tags(Event, Tags) ->
    Values = [to_binary(Tag) || Tag <- ensure_list(Tags), to_binary(Tag) =/= <<>>],
    Event#{tags := lists:foldl(fun unique_append/2, maps:get(tags, Event), Values)}.

add_routine_id(Event, RoutineId) -> Event#{routine_id := to_binary(RoutineId)}.
add_context(Event, Value) -> Event#{context := maps:get(context, Event) ++ [Value]}.
add_meta(Event, Value) -> Event#{meta := maps:get(meta, Event) ++ [Value]}.

%% BEAM context is naturally process-local. The prior value is restored so
%% nested scopes are deterministic; no OTP process or Logger module is patched.
with_context(Context, Fun) when is_map(Context), is_function(Fun, 0) ->
    Old = erlang:get(?CONTEXT_KEY),
    erlang:put(?CONTEXT_KEY, Context),
    try Fun()
    after
        case Old of
            undefined -> erlang:erase(?CONTEXT_KEY);
            _ -> erlang:put(?CONTEXT_KEY, Old)
        end
    end.

current_context() ->
    case erlang:get(?CONTEXT_KEY) of
        Context when is_map(Context) -> Context;
        _ -> undefined
    end.

apply_context(Event) ->
    case current_context() of
        undefined -> Event;
        Context ->
            TraceId = maps:get(trace_id, Context, <<>>),
            SpanId = maps:get(span_id, Context, <<>>),
            TraceFlags = maps:get(trace_flags, Context, 0),
            TraceState = maps:get(trace_state, Context, <<>>),
            Baggage = maps:get(baggage, Context, #{}),
            BaseFields = maps:get(fields, Context, #{}),
            OtelFields0 = BaseFields#{<<"otel.trace_flags">> => TraceFlags},
            OtelFields1 = maybe_put(OtelFields0, <<"otel.span_id">>, SpanId),
            OtelFields2 = maybe_put(OtelFields1, <<"otel.trace_state">>, TraceState),
            OtelFields3 = case map_size(Baggage) of
                0 -> OtelFields2;
                _ -> OtelFields2#{<<"otel.baggage">> => Baggage}
            end,
            Event1 = add_fields(Event, OtelFields3),
            Event2 = add_trace(Event1, TraceId),
            add_tags(Event2, [<<"otel">> | maps:get(tags, Context, [])])
    end.

record(Event) ->
    case maps:get(cached_record, Event) of
        undefined -> build_record(apply_context(Event));
        Cached -> Cached
    end.

build_record(Event) ->
    Logger = maps:get(logger, Event),
    Values = maps:get(values, Event),
    Fields = maps:merge(maps:get(fields, Logger), maps:get(fields, Event)),
    Level = maps:get(level, Event),
    Base = #{
        schema => ?SCHEMA,
        id => (maps:get(id_factory, Logger))(),
        timestamp => (maps:get(clock, Logger))(),
        level => level_binary(Level),
        runtime => maps:get(runtime, Logger),
        appName => maps:get(app_name, Logger),
        message => join_message(Values),
        values => [normalize(Value) || Value <- Values],
        fields => normalize(Fields)
    },
    Optional = [
        {name, maps:get(name, Logger)},
        {loggedInUser, maps:get(logged_in_user, Logger)},
        {traceId, maps:get(trace_id, Event)},
        {traceIds, maps:get(trace_ids, Event)},
        {routineId, maps:get(routine_id, Event)},
        {tags, maps:get(tags, Event)},
        {context, maps:get(context, Event)},
        {meta, maps:get(meta, Event)}
    ],
    lists:foldl(fun maybe_optional/2, Base, Optional).

send(Event) ->
    case maps:get(sent, Event) of
        true -> {ok, Event};
        false ->
            Applied = apply_context(Event),
            Record = build_record(Applied),
            Logger = maps:get(logger, Applied),
            case enabled(maps:get(level, Applied), maps:get(minimum_level, Logger)) of
                false -> {ok, Applied#{sent := true, cached_record := Record}};
                true ->
                    maybe_console(Logger, Record),
                    Transport = maps:get(transport, Logger),
                    try deliver_transport(Transport, Record, is_otel_enabled(Applied)) of
                        ok -> {ok, Applied#{sent := true, cached_record := Record}};
                        {error, Reason} -> {error, Reason};
                        Other -> {error, {invalid_transport_result, Other}}
                    catch
                        Class:Reason:Stacktrace -> {error, {Class, Reason, Stacktrace}}
                    end
            end
    end.

deliver_transport({otel, _Transport}, _Record, false) -> ok;
deliver_transport({otel, Transport}, Record, true) -> Transport(Record);
deliver_transport({multiplex, Transports}, Record, Enabled) ->
    lists:foreach(
        fun(Transport) -> ok = deliver_transport(Transport, Record, Enabled) end,
        Transports
    ),
    ok;
deliver_transport(Transport, Record, _Enabled) -> Transport(Record).

info(Logger = #{direct := true}, Message, Fields) ->
    log(Logger, <<"INFO">>, Message, Fields).

error(Logger = #{direct := true}, Message, Fields) ->
    log(Logger, <<"ERROR">>, Message, Fields).

log(Logger, Level, Message, EventFields) ->
    log(Logger, Level, Message, EventFields, #{}).

log(Logger, Level, Message, EventFields, Options)
        when is_map(Logger), is_binary(Level), is_binary(Message),
             is_map(EventFields), is_map(Options) ->
    Context = case current_context() of undefined -> #{}; Value -> Value end,
    Fields0 = maps:merge(maps:get(fields, Logger, #{}), maps:get(fields, Context, #{})),
    Fields1 = maybe_put(Fields0, <<"otel.span_id">>, maps:get(span_id, Context, undefined)),
    Fields2 = maps:put(<<"otel.trace_flags">>, maps:get(trace_flags, Context, 0), Fields1),
    Fields3 = maybe_put(Fields2, <<"otel.trace_state">>, maps:get(trace_state, Context, undefined)),
    Fields = maps:merge(Fields3, EventFields),
    TraceId = maps:get(trace_id, Context, undefined),
    Base = #{
        schema => ?SCHEMA,
        id => (maps:get(id_factory, Logger))(),
        timestamp => (maps:get(clock, Logger))(),
        level => Level,
        runtime => maps:get(runtime, Logger),
        appName => maps:get(app_name, Logger),
        message => Message,
        values => [Message],
        fields => Fields
    },
    Record0 = maybe_optional({name, maps:get(name, Logger, undefined)}, Base),
    Record1 = maybe_optional({traceId, TraceId}, Record0),
    Record2 = case TraceId of undefined -> Record1; <<>> -> Record1; _ -> Record1#{traceIds => [TraceId]} end,
    Record = maybe_optional({tags, maps:get(tags, Context, [])}, Record2),
    Enabled = maps:get(otel, Options, maps:get(otel, Logger, true)),
    lists:foreach(fun(Transport) -> ok = deliver_transport(Transport, Record, Enabled) end,
                  maps:get(transports, Logger, [])),
    Record.

otel_transport(Sink) when is_function(Sink, 1) ->
    {otel, fun(Record) ->
        Fields = maps:get(fields, Record, #{}),
        Attributes0 = #{
            <<"service.name">> => maps:get(appName, Record),
            <<"next_logger.schema">> => maps:get(schema, Record),
            <<"next_logger.runtime">> => maps:get(runtime, Record),
            <<"log.record.uid">> => maps:get(id, Record)
        },
        Attributes1 = maps:fold(fun(Key, Value, Acc) ->
            maps:put(<<"next_logger.field.", (to_binary(Key))/binary>>, Value, Acc)
        end, Attributes0, Fields),
        Attributes = maybe_put(Attributes1, <<"trace.id">>, maps:get(traceId, Record, undefined)),
        Sink(#{
            body => maps:get(message, Record),
            severityText => maps:get(level, Record),
            severityNumber => severity_number(maps:get(level, Record)),
            timestamp => maps:get(timestamp, Record),
            attributes => Attributes
        }),
        ok
    end}.

supabase_transport(Sender) when is_function(Sender, 1) ->
    fun(Record) -> Sender(Record), ok end.

%% Tracer is a structural map of callbacks wrapping the application's installed
%% OTel SDK. Start/status/exception/end failures are logged through next-loggers
%% and fail open. The application callback's result or exception is preserved.
with_span(Logger, Tracer, Name, Attributes, Fun)
        when is_map(Tracer), is_function(Fun, 1) ->
    case start_span(Logger, Tracer, Name, Attributes) of
        {fallback, NoopSpan} -> Fun(NoopSpan);
        {ok, Span, Context} ->
            Started = erlang:monotonic_time(microsecond),
            Recording = span_recording(Logger, Tracer, Span, Name),
            with_context(Context, fun() ->
                safe_send(add_tags(add_fields(debug(Logger, [<<"span started:">>, Name]), #{
                    <<"otel.span_name">> => Name,
                    <<"otel.span_phase">> => <<"start">>
                }), [<<"otel-span">>])),
                try
                    Result = Fun(Span),
                    case Recording of
                        true ->
                            safe_otel_call(Logger, Name, <<"set success status">>, fun() ->
                                (maps:get(set_status, Tracer))(Span, 1, <<>>)
                            end);
                        false -> ok
                    end,
                    safe_send(add_tags(add_fields(debug(Logger, [<<"span completed:">>, Name]), #{
                        <<"otel.span_name">> => Name,
                        <<"otel.span_phase">> => <<"end">>,
                        <<"otel.duration_ms">> => elapsed_ms(Started)
                    }), [<<"otel-span">>])),
                    Result
                catch
                    Class:Reason:Stacktrace ->
                        case Recording of
                            true ->
                                safe_otel_call(Logger, Name, <<"record exception">>, fun() ->
                                    (maps:get(record_exception, Tracer))(Span, Class, Reason, Stacktrace)
                                end),
                                safe_otel_call(Logger, Name, <<"set error status">>, fun() ->
                                    (maps:get(set_status, Tracer))(Span, 2, to_binary(Reason))
                                end);
                            false -> ok
                        end,
                        safe_send(add_tags(add_fields(error(Logger, [<<"span failed:">>, Name, Reason]), #{
                            <<"otel.span_name">> => Name,
                            <<"otel.span_phase">> => <<"error">>,
                            <<"otel.duration_ms">> => elapsed_ms(Started)
                        }), [<<"otel-span">>])),
                        erlang:raise(Class, Reason, Stacktrace)
                after
                    safe_otel_call(Logger, Name, <<"end span">>, fun() ->
                        (maps:get('end', Tracer))(Span)
                    end)
                end
            end)
    end.

span_recording(Logger, Tracer, Span, Name) ->
    case maps:find(is_recording, Tracer) of
        {ok, Callback} when is_function(Callback, 1) ->
            try Callback(Span) of
                true -> true;
                _ -> false
            catch
                Class:Reason:Stacktrace ->
                    report_otel_failure(
                        Logger,
                        Name,
                        <<"read recording state">>,
                        {Class, Reason, Stacktrace}
                    ),
                    false
            end;
        _ -> true
    end.

start_span(Logger, Tracer, Name, Attributes) ->
    try
        Start = maps:get(start, Tracer),
        case Start(Name, Attributes) of
            {Span, Context} when is_map(Context) -> {ok, Span, Context};
            Other ->
                report_otel_failure(Logger, Name, <<"start span">>, {invalid_start_result, Other}),
                {fallback, noop_span}
        end
    catch
        Class:Reason:Stacktrace ->
            report_otel_failure(Logger, Name, <<"start span">>, {Class, Reason, Stacktrace}),
            {fallback, noop_span}
    end.

safe_otel_call(Logger, Name, Operation, Fun) ->
    try Fun() of
        _ -> ok
    catch
        Class:Reason:Stacktrace ->
            report_otel_failure(Logger, Name, Operation, {Class, Reason, Stacktrace}),
            ok
    end.

report_otel_failure(Logger, Name, Operation, Failure) ->
    safe_send(add_tags(add_fields(warn(Logger, [<<"OpenTelemetry">>, Operation, <<"failed:">>, Failure]), #{
        <<"otel.bridge_operation">> => Operation,
        <<"otel.span_name">> => Name
    }), [<<"otel-span">>, <<"otel-bridge-error">>])).

memory_transport() ->
    Owner = self(),
    fun(Record) -> Owner ! {next_loggers_record, Record}, ok end.

safe_send(Event) ->
    try send(Event) of
        {ok, _} -> ok;
        {error, _} -> ok
    catch
        _:_ -> ok
    end.

maybe_console(Logger, Record) ->
    case maps:get(console, Logger) of
        true -> io:format("[~ts] [~ts] [~ts] ~ts~n", [
            maps:get(timestamp, Record), maps:get(level, Record),
            maps:get(appName, Record), maps:get(message, Record)]);
        false -> ok
    end.

default_transport(_Record) -> ok.
default_id() -> integer_to_binary(erlang:unique_integer([monotonic, positive])).
default_clock() ->
    to_binary(calendar:system_time_to_rfc3339(
        erlang:system_time(second), [{unit, second}, {offset, "Z"}])).

level_index(trace) -> 0;
level_index(debug) -> 1;
level_index(info) -> 2;
level_index(warn) -> 3;
level_index(error) -> 4;
level_index(fatal) -> 5.

level_atom(<<"TRACE">>) -> trace;
level_atom(<<"DEBUG">>) -> debug;
level_atom(<<"INFO">>) -> info;
level_atom(<<"WARN">>) -> warn;
level_atom(<<"ERROR">>) -> error;
level_atom(<<"FATAL">>) -> fatal.

enabled(Level, Minimum) -> level_index(Level) >= level_index(Minimum).
level_binary(Level) -> list_to_binary(string:uppercase(atom_to_list(Level))).

severity_number(<<"TRACE">>) -> 1;
severity_number(<<"DEBUG">>) -> 5;
severity_number(<<"INFO">>) -> 9;
severity_number(<<"WARN">>) -> 13;
severity_number(<<"ERROR">>) -> 17;
severity_number(<<"FATAL">>) -> 21.

ensure_list(Value) when is_list(Value) -> Value;
ensure_list(Value) -> [Value].

unique_append(Value, Values) when is_list(Values) -> unique_append(Values, Value);
unique_append(Values, Value) ->
    case lists:member(Value, Values) of true -> Values; false -> Values ++ [Value] end.

maybe_put(Map, _Key, <<>>) -> Map;
maybe_put(Map, _Key, undefined) -> Map;
maybe_put(Map, Key, Value) -> Map#{Key => Value}.

maybe_optional({_Key, undefined}, Acc) -> Acc;
maybe_optional({_Key, <<>>}, Acc) -> Acc;
maybe_optional({_Key, []}, Acc) -> Acc;
maybe_optional({_Key, Value}, Acc) when is_map(Value), map_size(Value) =:= 0 -> Acc;
maybe_optional({Key, Value}, Acc) -> Acc#{Key => normalize(Value)}.

normalize(Value) when is_binary(Value); is_number(Value); is_boolean(Value); Value =:= null -> Value;
normalize(Value) when is_atom(Value) -> atom_to_binary(Value, utf8);
normalize(Value) when is_map(Value) ->
    maps:from_list([{to_binary(Key), normalize(Entry)} || {Key, Entry} <- maps:to_list(Value)]);
normalize(Value) when is_list(Value) -> [normalize(Entry) || Entry <- Value];
normalize(Value) when is_tuple(Value) -> [normalize(Entry) || Entry <- tuple_to_list(Value)];
normalize(Value) -> to_binary(Value).

join_message(Values) ->
    iolist_to_binary(lists:join(<<" ">>, [message_part(Value) || Value <- Values])).

message_part(Value) when is_binary(Value) -> Value;
message_part(Value) when is_list(Value) ->
    try unicode:characters_to_binary(Value)
    catch _:_ -> iolist_to_binary(io_lib:format("~p", [Value]))
    end;
message_part(Value) -> iolist_to_binary(io_lib:format("~p", [Value])).

to_binary(Value) when is_binary(Value) -> Value;
to_binary(Value) when is_atom(Value) -> atom_to_binary(Value, utf8);
to_binary(Value) when is_list(Value) ->
    try unicode:characters_to_binary(Value)
    catch _:_ -> iolist_to_binary(io_lib:format("~p", [Value]))
    end;
to_binary(Value) when is_integer(Value) -> integer_to_binary(Value);
to_binary(Value) when is_float(Value) -> float_to_binary(Value, [compact]);
to_binary(Value) -> iolist_to_binary(io_lib:format("~p", [Value])).

elapsed_ms(Started) -> (erlang:monotonic_time(microsecond) - Started) / 1000.
