-module(next_loggers_shutdown_ffi).
-export([monotonic_milliseconds/0]).

monotonic_milliseconds() ->
    erlang:monotonic_time(millisecond).
