/// Framework-neutral shutdown transitions for OTP/Wisp/Mist applications.
///
/// Map `BeginGraceful` to withdrawing readiness and stopping the supervised
/// listener. Map `Force` to terminating the server process/session owners. The
/// BEAM already maps SIGTERM to a normal `init:stop/0`; interactive launchers can
/// feed a first SIGINT and a second SIGINT or stdin EOF into this state machine.
pub type Cause {
  Sigint
  Sigterm
  StdinEof
  Timeout
  Programmatic
}

pub type Phase {
  Running
  Draining
  Forced
  Closed
}

pub type Action {
  BeginGraceful
  Force
  Ignore
}

pub type State {
  State(phase: Phase, interactive: Bool, signal_count: Int)
}

pub fn new(interactive: Bool) -> State {
  State(phase: Running, interactive:, signal_count: 0)
}

pub fn phase(state: State) -> Phase {
  state.phase
}

pub fn interactive(state: State) -> Bool {
  state.interactive
}

pub fn signal_count(state: State) -> Int {
  state.signal_count
}

pub fn trigger(state: State, _cause: Cause) -> #(State, Action) {
  case state.phase {
    Running -> #(
      State(..state, phase: Draining, signal_count: state.signal_count + 1),
      BeginGraceful,
    )
    Draining -> #(
      State(..state, phase: Forced, signal_count: state.signal_count + 1),
      Force,
    )
    Forced | Closed -> #(
      State(..state, signal_count: state.signal_count + 1),
      Ignore,
    )
  }
}

pub fn mark_closed(state: State) -> #(State, Bool) {
  case state.phase {
    Draining -> #(State(..state, phase: Closed), True)
    _ -> #(state, False)
  }
}

pub fn timeout(state: State) -> #(State, Action) {
  case state.phase {
    Draining -> #(State(..state, phase: Forced), Force)
    _ -> #(state, Ignore)
  }
}

@external(erlang, "oresoftware_next_loggers_shutdown_ffi", "graceful_stop")
pub fn graceful_stop() -> Nil

@external(erlang, "oresoftware_next_loggers_shutdown_ffi", "force_stop")
pub fn force_stop(status: Int) -> Nil
