-module(oresoftware_next_loggers_shutdown_ffi).
-export([graceful_stop/0, force_stop/1]).

graceful_stop() ->
    init:stop(),
    nil.

force_stop(Status) ->
    erlang:halt(Status).
