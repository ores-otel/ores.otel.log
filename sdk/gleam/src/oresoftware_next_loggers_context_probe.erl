-module(oresoftware_next_loggers_context_probe).
-export([request_id/0, transport/0, scope/0, phase/0]).

request_id() -> value(ores_request_id).
transport() -> value(ores_transport).
scope() -> value(ores_scope).
phase() -> value(ores_phase).

value(Key) ->
    case logger:get_process_metadata() of
        Metadata when is_map(Metadata) ->
            case maps:find(Key, Metadata) of
                {ok, Value} when is_binary(Value) -> {ok, Value};
                _ -> {error, nil}
            end;
        _ -> {error, nil}
    end.
