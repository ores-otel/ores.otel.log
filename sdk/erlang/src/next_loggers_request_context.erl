-module(next_loggers_request_context).

-export([
    schema/0,
    new/1,
    merge/2,
    with_context/2,
    current/0,
    capture/0,
    run_captured/2,
    request_id/0,
    logged_in_user_id/0,
    tenant_id/0,
    session_id/0,
    correlation_id/0,
    spawn_with_current/1,
    spawn_link_with_current/1
]).

-define(SCHEMA, <<"ores.request-context.v1">>).

schema() -> ?SCHEMA.

%% Build the one context map consumed by next_loggers. Values are allowlisted
%% correlation identifiers, never credentials, cookies, authorization headers,
%% raw tokens, or email addresses.
new(Values) when is_map(Values) ->
    RequestId = as_binary(get_any([request_id, requestId, <<"requestId">>], Values, <<>>)),
    UserId = as_binary(get_any([
        logged_in_user_id,
        loggedInUserId,
        user_id,
        userId,
        <<"loggedInUserId">>,
        <<"userId">>
    ], Values, <<>>)),
    TenantId = as_binary(get_any([tenant_id, tenantId, <<"tenantId">>], Values, <<>>)),
    SessionId = as_binary(get_any([session_id, sessionId, <<"sessionId">>], Values, <<>>)),
    CorrelationId = as_binary(get_any([
        correlation_id,
        correlationId,
        <<"correlationId">>
    ], Values, <<>>)),
    ParentRequestId = as_binary(get_any([
        parent_request_id,
        parentRequestId,
        <<"parentRequestId">>
    ], Values, <<>>)),
    TraceId = as_binary(get_any([trace_id, traceId, <<"traceId">>], Values, <<>>)),
    SpanId = as_binary(get_any([span_id, spanId, <<"spanId">>], Values, <<>>)),
    Operation = as_binary(get_any([operation, <<"operation">>], Values, <<>>)),
    ServiceName = as_binary(get_any([service_name, serviceName, <<"serviceName">>], Values, <<>>)),
    Locale = as_binary(get_any([locale, <<"locale">>], Values, <<>>)),
    StartedAt = get_any([started_at_unix_ms, startedAtUnixMs, <<"startedAtUnixMs">>], Values, undefined),
    Deadline = get_any([deadline_unix_ms, deadlineUnixMs, <<"deadlineUnixMs">>], Values, undefined),
    Baggage = ensure_map(get_any([baggage, <<"baggage">>], Values, #{})),
    InputFields = ensure_map(get_any([fields, <<"fields">>], Values, #{})),
    Fields0 = maps:put(<<"request.context.schema">>, ?SCHEMA, InputFields),
    Fields1 = put_nonempty(Fields0, <<"request.id">>, RequestId),
    Fields2 = put_nonempty(Fields1, <<"user.id">>, UserId),
    Fields3 = put_nonempty(Fields2, <<"tenant.id">>, TenantId),
    Fields4 = put_nonempty(Fields3, <<"session.id">>, SessionId),
    Fields5 = put_nonempty(Fields4, <<"correlation.id">>, CorrelationId),
    Fields6 = put_nonempty(Fields5, <<"request.parent_id">>, ParentRequestId),
    Fields7 = put_nonempty(Fields6, <<"operation.name">>, Operation),
    Fields8 = put_nonempty(Fields7, <<"service.name">>, ServiceName),
    Fields9 = put_nonempty(Fields8, <<"request.locale">>, Locale),
    Fields10 = put_number(Fields9, <<"request.started_at_unix_ms">>, StartedAt),
    Fields = put_number(Fields10, <<"request.deadline_unix_ms">>, Deadline),
    Base0 = #{
        schema => ?SCHEMA,
        request_id => RequestId,
        fields => Fields,
        baggage => Baggage,
        tags => [<<"ores-request-context">>],
        routine_id => RequestId
    },
    Base1 = put_context_value(Base0, logged_in_user_id, UserId),
    Base2 = case UserId of
        <<>> -> Base1;
        _ -> Base1#{logged_in_user => #{id => UserId}}
    end,
    Base3 = put_context_value(Base2, tenant_id, TenantId),
    Base4 = put_context_value(Base3, session_id, SessionId),
    Base5 = put_context_value(Base4, correlation_id, CorrelationId),
    Base6 = put_context_value(Base5, parent_request_id, ParentRequestId),
    Base7 = put_context_value(Base6, trace_id, TraceId),
    Base8 = put_context_value(Base7, span_id, SpanId),
    Base9 = put_context_value(Base8, operation, Operation),
    Base10 = put_context_value(Base9, service_name, ServiceName),
    Base11 = put_context_value(Base10, locale, Locale),
    Base12 = put_optional_number(Base11, started_at_unix_ms, StartedAt),
    put_optional_number(Base12, deadline_unix_ms, Deadline).

merge(Base, Patch) when is_map(Base), is_map(Patch) ->
    Merged0 = maps:merge(Base, Patch),
    Merged0#{
        fields => maps:merge(maps:get(fields, Base, #{}), maps:get(fields, Patch, #{})),
        baggage => maps:merge(maps:get(baggage, Base, #{}), maps:get(baggage, Patch, #{})),
        logged_in_user => maps:merge(
            maps:get(logged_in_user, Base, #{}),
            maps:get(logged_in_user, Patch, #{})
        ),
        tags => unique(maps:get(tags, Base, []) ++ maps:get(tags, Patch, []))
    }.

%% The underlying carrier belongs to next_loggers. This module never creates a
%% second process-dictionary key.
with_context(Values, Fun) when is_map(Values), is_function(Fun, 0) ->
    Patch = normalize_context(Values),
    Context = case current() of
        undefined -> Patch;
        Parent -> merge(Parent, Patch)
    end,
    next_loggers:with_context(Context, Fun).

current() ->
    case next_loggers:current_context() of
        Context when is_map(Context) -> Context;
        _ -> undefined
    end.

capture() -> current().

run_captured(undefined, Fun) when is_function(Fun, 0) -> Fun();
run_captured(Context, Fun) when is_map(Context), is_function(Fun, 0) ->
    next_loggers:with_context(Context, Fun).

request_id() -> context_value(request_id, <<"request.id">>).
logged_in_user_id() ->
    case context_value(logged_in_user_id, <<"user.id">>) of
        undefined ->
            case current() of
                #{logged_in_user := User} when is_map(User) -> maps:get(id, User, undefined);
                _ -> undefined
            end;
        Value -> Value
    end.
tenant_id() -> context_value(tenant_id, <<"tenant.id">>).
session_id() -> context_value(session_id, <<"session.id">>).
correlation_id() -> context_value(correlation_id, <<"correlation.id">>).

%% BEAM processes do not inherit process-local context. These helpers snapshot
%% and re-enter it explicitly in the child process.
spawn_with_current(Fun) when is_function(Fun, 0) ->
    Snapshot = capture(),
    erlang:spawn(fun() -> run_captured(Snapshot, Fun) end).

spawn_link_with_current(Fun) when is_function(Fun, 0) ->
    Snapshot = capture(),
    erlang:spawn_link(fun() -> run_captured(Snapshot, Fun) end).

normalize_context(#{schema := ?SCHEMA} = Context) -> Context;
normalize_context(Values) -> new(Values).

context_value(Key, FieldKey) ->
    case current() of
        undefined -> undefined;
        Context ->
            case maps:get(Key, Context, undefined) of
                undefined -> maps:get(FieldKey, maps:get(fields, Context, #{}), undefined);
                Value -> Value
            end
    end.

get_any([], _Values, Default) -> Default;
get_any([Key | Rest], Values, Default) ->
    case maps:find(Key, Values) of
        {ok, Value} -> Value;
        error -> get_any(Rest, Values, Default)
    end.

ensure_map(Value) when is_map(Value) -> Value;
ensure_map(_) -> #{}.

put_nonempty(Map, _Key, <<>>) -> Map;
put_nonempty(Map, Key, Value) -> maps:put(Key, Value, Map).

put_number(Map, Key, Value) when is_integer(Value), Value >= 0 -> maps:put(Key, Value, Map);
put_number(Map, _Key, _Value) -> Map.

put_context_value(Map, _Key, <<>>) -> Map;
put_context_value(Map, Key, Value) -> maps:put(Key, Value, Map).

put_optional_number(Map, Key, Value) when is_integer(Value), Value >= 0 ->
    maps:put(Key, Value, Map);
put_optional_number(Map, _Key, _Value) -> Map.

unique(Values) -> unique(Values, []).
unique([], Result) -> lists:reverse(Result);
unique([Value | Rest], Result) ->
    case lists:member(Value, Result) of
        true -> unique(Rest, Result);
        false -> unique(Rest, [Value | Result])
    end.

as_binary(undefined) -> <<>>;
as_binary(Value) when is_binary(Value) -> Value;
as_binary(Value) when is_atom(Value) -> atom_to_binary(Value, utf8);
as_binary(Value) when is_integer(Value) -> integer_to_binary(Value);
as_binary(Value) when is_list(Value) -> unicode:characters_to_binary(Value);
as_binary(_) -> <<>>.
