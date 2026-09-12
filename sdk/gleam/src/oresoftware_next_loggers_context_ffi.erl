-module(oresoftware_next_loggers_context_ffi).
-export([
    current/0,
    set_current/1,
    clear_current/0,
    with_context/2,
    run_protected/8
]).

-define(KEY, '$oresoftware_next_loggers_context').

current() ->
    case erlang:get(?KEY) of
        undefined -> {error, nil};
        Value -> {ok, Value}
    end.

set_current(Context) ->
    erlang:put(?KEY, Context),
    nil.

clear_current() ->
    erlang:erase(?KEY),
    nil.

with_context(Context, Callback) ->
    Previous = erlang:get(?KEY),
    PreviousLoggerMetadata = logger:get_process_metadata(),
    erlang:put(?KEY, Context),
    install_logger_metadata(Context, #{}),
    try Callback()
    after
        restore_context(Previous),
        restore_logger_metadata(PreviousLoggerMetadata)
    end.

%% Runs one BEAM operation under both the canonical context carrier and fixed
%% OTP Logger process metadata. It catches ordinary error/throw/exit classes,
%% but intentionally cannot and does not mask untrappable kill/OOM failures.
%% No raw reason, payload, or stacktrace is logged by this boundary.
run_protected(Context, Transport, Scope, Phase, ConnectionId, MessageId, Operation, Callback) ->
    Previous = erlang:get(?KEY),
    PreviousLoggerMetadata = logger:get_process_metadata(),
    erlang:put(?KEY, Context),
    BoundaryMetadata = boundary_logger_metadata(
        Transport,
        Scope,
        Phase,
        ConnectionId,
        MessageId,
        Operation
    ),
    install_logger_metadata(Context, BoundaryMetadata),
    try
        {ok, Callback()}
    catch
        Class:Reason:_Stacktrace ->
            Kind = classify_failure(Class, Reason),
            safe_log_failure(Kind),
            {error, atom_to_binary(Kind, utf8)}
    after
        restore_context(Previous),
        restore_logger_metadata(PreviousLoggerMetadata)
    end.

restore_context(undefined) -> erlang:erase(?KEY);
restore_context(Value) -> erlang:put(?KEY, Value).

restore_logger_metadata(undefined) -> logger:unset_process_metadata();
restore_logger_metadata(Metadata) -> logger:set_process_metadata(Metadata).

install_logger_metadata(Context, BoundaryMetadata) ->
    Previous = case logger:get_process_metadata() of
        undefined -> #{};
        Metadata -> Metadata
    end,
    ContextMetadata = context_logger_metadata(Context),
    logger:set_process_metadata(
        maps:merge(maps:merge(Previous, ContextMetadata), BoundaryMetadata)
    ).

%% Gleam constructors are represented as tagged tuples on the BEAM. Matching
%% this closed shape is fail-closed: unknown versions simply contribute no
%% metadata rather than guessing field positions.
context_logger_metadata({
    log_context,
    _LoggedInUser,
    _Users,
    _Fields,
    TraceId,
    _TraceIds,
    SpanId,
    _TraceFlags,
    _TraceState,
    _Baggage,
    RoutineId,
    Tags,
    _Context,
    _Meta
}) ->
    Metadata0 = put_option(#{}, ores_request_id, RoutineId),
    Metadata1 = put_option(Metadata0, ores_trace_id, TraceId),
    Metadata2 = put_option(Metadata1, ores_span_id, SpanId),
    Metadata3 = put_binary(
        Metadata2,
        ores_logged_in_user_id,
        find_identity_tag(Tags, <<"ores.logged_in_user_id=">>)
    ),
    Metadata4 = put_binary(
        Metadata3,
        ores_tenant_id,
        find_identity_tag(Tags, <<"ores.tenant_id=">>)
    ),
    Metadata5 = put_binary(
        Metadata4,
        ores_session_id,
        find_identity_tag(Tags, <<"ores.session_id=">>)
    ),
    put_binary(
        Metadata5,
        ores_correlation_id,
        find_identity_tag(Tags, <<"ores.correlation_id=">>)
    );
context_logger_metadata(_) -> #{}.

boundary_logger_metadata(Transport, Scope, Phase, ConnectionId, MessageId, Operation) ->
    Metadata0 = put_binary(#{}, ores_transport, Transport),
    Metadata1 = put_binary(Metadata0, ores_scope, Scope),
    Metadata2 = put_binary(Metadata1, ores_phase, Phase),
    Metadata3 = put_binary(Metadata2, ores_connection_id, ConnectionId),
    Metadata4 = put_binary(Metadata3, ores_message_id, MessageId),
    put_binary(Metadata4, ores_operation, Operation).

put_option(Metadata, Key, {some, Value}) -> put_binary(Metadata, Key, Value);
put_option(Metadata, _Key, none) -> Metadata;
put_option(Metadata, _Key, _) -> Metadata.

put_binary(Metadata, _Key, undefined) -> Metadata;
put_binary(Metadata, _Key, <<>>) -> Metadata;
put_binary(Metadata, Key, Value) when is_binary(Value) -> Metadata#{Key => Value};
put_binary(Metadata, _Key, _) -> Metadata.

find_identity_tag(Tags, Prefix) when is_list(Tags) ->
    find_identity_tag_list(Tags, Prefix);
find_identity_tag(_, _) -> undefined.

find_identity_tag_list([], _Prefix) -> undefined;
find_identity_tag_list([Tag | Rest], Prefix) when is_binary(Tag) ->
    PrefixSize = byte_size(Prefix),
    case Tag of
        <<Prefix:PrefixSize/binary, Value/binary>> when Value =/= <<>> -> Value;
        _ -> find_identity_tag_list(Rest, Prefix)
    end;
find_identity_tag_list([_ | Rest], Prefix) -> find_identity_tag_list(Rest, Prefix).

classify_failure(error, closed) -> disconnect;
classify_failure(exit, closed) -> disconnect;
classify_failure(exit, timeout) -> timeout;
classify_failure(exit, {timeout, _}) -> timeout;
classify_failure(exit, normal) -> cancelled;
classify_failure(exit, shutdown) -> cancelled;
classify_failure(exit, {shutdown, _}) -> cancelled;
classify_failure(throw, _) -> exception;
classify_failure(error, _) -> panic;
classify_failure(exit, _) -> cancelled;
classify_failure(_, _) -> exception.

safe_log_failure(Kind) ->
    try logger:error(
        <<"request boundary failed">>,
        #{ores_failure_kind => Kind}
    )
    catch
        _:_ -> ok
    end.
