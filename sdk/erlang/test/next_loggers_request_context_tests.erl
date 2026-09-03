-module(next_loggers_request_context_tests).

-include_lib("eunit/include/eunit.hrl").

context_is_scoped_and_restored_test() ->
    ?assertEqual(undefined, next_loggers_request_context:current()),
    Result = next_loggers_request_context:with_context(
        #{
            request_id => <<"request-erlang">>,
            logged_in_user_id => <<"user-erlang">>,
            tenant_id => <<"tenant-erlang">>,
            session_id => <<"session-erlang">>,
            correlation_id => <<"correlation-erlang">>
        },
        fun() ->
            ?assertEqual(<<"request-erlang">>, next_loggers_request_context:request_id()),
            ?assertEqual(
                <<"user-erlang">>,
                next_loggers_request_context:logged_in_user_id()
            ),
            ?assertEqual(<<"tenant-erlang">>, next_loggers_request_context:tenant_id()),
            ?assertEqual(<<"session-erlang">>, next_loggers_request_context:session_id()),
            ?assertEqual(
                <<"correlation-erlang">>,
                next_loggers_request_context:correlation_id()
            ),
            next_loggers_request_context:capture()
        end
    ),
    ?assertEqual(<<"ores.request-context.v1">>, maps:get(schema, Result)),
    ?assertEqual(undefined, next_loggers_request_context:current()).

nested_context_merges_and_restores_test() ->
    next_loggers_request_context:with_context(
        #{request_id => <<"request-parent">>, tenant_id => <<"tenant-parent">>},
        fun() ->
            next_loggers_request_context:with_context(
                #{request_id => <<"request-child">>, session_id => <<"session-child">>},
                fun() ->
                    ?assertEqual(
                        <<"request-child">>,
                        next_loggers_request_context:request_id()
                    ),
                    ?assertEqual(
                        <<"tenant-parent">>,
                        next_loggers_request_context:tenant_id()
                    )
                end
            ),
            ?assertEqual(
                <<"request-parent">>,
                next_loggers_request_context:request_id()
            ),
            ?assertEqual(undefined, next_loggers_request_context:session_id())
        end
    ).

spawn_requires_explicit_snapshot_reentry_test() ->
    Parent = self(),
    next_loggers_request_context:with_context(
        #{request_id => <<"request-spawn">>, logged_in_user_id => <<"user-spawn">>},
        fun() ->
            _Pid = next_loggers_request_context:spawn_with_current(fun() ->
                Parent ! {
                    request_context,
                    next_loggers_request_context:request_id(),
                    next_loggers_request_context:logged_in_user_id()
                }
            end),
            receive
                {request_context, RequestId, UserId} ->
                    ?assertEqual(<<"request-spawn">>, RequestId),
                    ?assertEqual(<<"user-spawn">>, UserId)
            after 1000 ->
                ?assert(false)
            end
        end
    ).
