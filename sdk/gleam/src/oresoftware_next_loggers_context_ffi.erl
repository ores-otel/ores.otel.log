-module(oresoftware_next_loggers_context_ffi).
-export([current/0, set_current/1, clear_current/0, with_context/2]).

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
    erlang:put(?KEY, Context),
    try Callback()
    after
        case Previous of
            undefined -> erlang:erase(?KEY);
            Value -> erlang:put(?KEY, Value)
        end
    end.
