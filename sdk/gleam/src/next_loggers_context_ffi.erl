-module(next_loggers_context_ffi).
-export([get/0, with_context/2]).

-define(KEY, '$oresoftware_next_loggers_context').

get() ->
    case erlang:get(?KEY) of
        undefined -> none;
        Value -> {some, Value}
    end.

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
