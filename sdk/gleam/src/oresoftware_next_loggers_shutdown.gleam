/// Framework-neutral shutdown transitions for OTP/Wisp/Mist applications.
///
/// Map `BeginGraceful` to withdrawing readiness and stopping the supervised
/// listener. Map `Force` to terminating the server process/session owners. The
/// BEAM already maps SIGTERM to a normal `init:stop/0`; interactive launchers can
/// feed a first SIGINT and a second SIGINT or stdin EOF into this state machine.
/// Stdin EOF is dormant until the first interactive SIGINT.
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

/// Closed external event alphabet shared with the TLA+ transition vectors.
pub type StateEvent {
  Trigger
  ForceNow
  MarkClosed
}

/// Side effects named by the pure formal relation. These are separate from the
/// runtime `Action` type because only the formal relation can request `Close`.
pub type ModelAction {
  ModelBeginGraceful
  ModelForce
  ModelClose
  ModelIgnore
}

pub type Transition {
  Transition(phase: Phase, action: ModelAction)
}

/// Total pair-pattern transition relation refined from the shared TLA+ model.
pub fn transition(phase: Phase, event: StateEvent) -> Transition {
  case phase, event {
    Running, Trigger -> Transition(Draining, ModelBeginGraceful)
    Draining, Trigger | Running, ForceNow | Draining, ForceNow ->
      Transition(Forced, ModelForce)
    Draining, MarkClosed -> Transition(Closed, ModelClose)
    _, _ -> Transition(phase, ModelIgnore)
  }
}

pub type State {
  State(phase: Phase, interactive: Bool, signal_count: Int, eof_armed: Bool)
}

pub fn new(interactive: Bool) -> State {
  State(phase: Running, interactive:, signal_count: 0, eof_armed: False)
}

pub fn phase(state: State) -> Phase {
  state.phase
}

pub fn interactive(state: State) -> Bool {
  state.interactive
}

/// Counts operating-system SIGINT/SIGTERM events only.
pub fn signal_count(state: State) -> Int {
  state.signal_count
}

/// True only after the first interactive SIGINT starts draining.
pub fn eof_armed(state: State) -> Bool {
  state.eof_armed
}

pub fn trigger(state: State, cause: Cause) -> #(State, Action) {
  case state.phase, cause {
    Running, Sigint -> #(
      State(
        ..state,
        phase: Draining,
        signal_count: state.signal_count + 1,
        eof_armed: state.interactive,
      ),
      BeginGraceful,
    )
    Running, Sigterm -> #(
      State(
        ..state,
        phase: Draining,
        signal_count: state.signal_count + 1,
        eof_armed: False,
      ),
      BeginGraceful,
    )
    Running, Programmatic -> #(
      State(..state, phase: Draining, eof_armed: False),
      BeginGraceful,
    )
    Running, StdinEof | Running, Timeout -> #(state, Ignore)

    Draining, Sigint | Draining, Sigterm -> #(
      State(
        ..state,
        phase: Forced,
        signal_count: state.signal_count + 1,
        eof_armed: False,
      ),
      Force,
    )
    Draining, StdinEof ->
      case state.interactive && state.eof_armed {
        True -> #(State(..state, phase: Forced, eof_armed: False), Force)
        False -> #(state, Ignore)
      }
    Draining, Timeout | Draining, Programmatic -> #(
      State(..state, phase: Forced, eof_armed: False),
      Force,
    )

    Forced, _ | Closed, _ -> #(state, Ignore)
  }
}

pub fn mark_closed(state: State) -> #(State, Bool) {
  case state.phase {
    Draining -> #(State(..state, phase: Closed, eof_armed: False), True)
    _ -> #(state, False)
  }
}

pub fn timeout(state: State) -> #(State, Action) {
  trigger(state, Timeout)
}

@external(erlang, "oresoftware_next_loggers_shutdown_ffi", "graceful_stop")
pub fn graceful_stop() -> Nil

@external(erlang, "oresoftware_next_loggers_shutdown_ffi", "force_stop")
pub fn force_stop(status: Int) -> Nil
