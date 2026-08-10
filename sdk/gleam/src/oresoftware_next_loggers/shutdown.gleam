//// Runtime-neutral BEAM shutdown coordination.
////
//// OTP applications translate supervisor/application-stop events, OS signal
//// bridge messages, and stdin EOF into `request` or `force`. The first request
//// drains; a second request or explicit timeout forces.

import gleam/erlang/process.{type Subject}
import gleam/json
import gleam/otp/actor
import oresoftware_next_loggers as logging

pub type Phase {
  Running
  Draining
  Forcing
  Stopped
}

pub type Trigger {
  Sigint
  Sigterm
  StdinEof
  Timeout
  Programmatic
  ServerError
  Custom(String)
}

pub type Decision {
  Drain
  Force
  Ignore
}

pub type ShutdownEvent {
  ShutdownEvent(
    phase: Phase,
    previous_phase: Phase,
    trigger: Trigger,
    interactive: Bool,
    attempt: Int,
    elapsed_milliseconds: Int,
    message: String,
  )
}

pub opaque type Coordinator {
  Coordinator(subject: Subject(Message))
}

type State {
  State(
    phase: Phase,
    attempts: Int,
    started_at_milliseconds: Int,
    observer: fn(ShutdownEvent) -> Nil,
  )
}

type Message {
  Request(Trigger, Bool, Subject(Decision))
  ForceNow(Trigger, Bool, Subject(Decision))
  MarkStopped(Trigger, Bool, Subject(Nil))
  ReadPhase(Subject(Phase))
}

@external(erlang, "next_loggers_shutdown_ffi", "monotonic_milliseconds")
fn monotonic_milliseconds() -> Int

pub fn new(observer: fn(ShutdownEvent) -> Nil) -> Coordinator {
  let assert Ok(started) =
    actor.new(State(
      phase: Running,
      attempts: 0,
      started_at_milliseconds: monotonic_milliseconds(),
      observer:,
    ))
    |> actor.on_message(handle_message)
    |> actor.start
  Coordinator(started.data)
}

pub fn noop_observer(_event: ShutdownEvent) -> Nil {
  Nil
}

pub fn request(
  coordinator: Coordinator,
  trigger: Trigger,
  interactive: Bool,
) -> Decision {
  let Coordinator(subject:) = coordinator
  actor.call(subject, 5000, Request(trigger, interactive, _))
}

pub fn force(
  coordinator: Coordinator,
  trigger: Trigger,
  interactive: Bool,
) -> Decision {
  let Coordinator(subject:) = coordinator
  actor.call(subject, 5000, ForceNow(trigger, interactive, _))
}

pub fn mark_stopped(
  coordinator: Coordinator,
  trigger: Trigger,
  interactive: Bool,
) -> Nil {
  let Coordinator(subject:) = coordinator
  actor.call(subject, 5000, MarkStopped(trigger, interactive, _))
}

pub fn phase(coordinator: Coordinator) -> Phase {
  let Coordinator(subject:) = coordinator
  actor.call(subject, 5000, ReadPhase)
}

/// Emits structured lifecycle records through next-loggers. Configure the
/// logger with an application-owned OTEL transport to export the same records.
pub fn logger_observer(logger: logging.Logger) -> fn(ShutdownEvent) -> Nil {
  fn(event) {
    let ShutdownEvent(
      phase:,
      previous_phase:,
      trigger:,
      interactive:,
      attempt:,
      elapsed_milliseconds:,
      message:,
    ) = event
    let fields = [
      #("shutdown.phase", json.string(phase_name(phase))),
      #("shutdown.previous_phase", json.string(phase_name(previous_phase))),
      #("shutdown.trigger", json.string(trigger_name(trigger))),
      #("shutdown.interactive", json.bool(interactive)),
      #("shutdown.attempt", json.int(attempt)),
      #("shutdown.elapsed_ms", json.int(elapsed_milliseconds)),
    ]
    let log_event = case phase {
      Forcing -> logging.warn(logger, message, [json.string(message)])
      _ -> logging.info(logger, message, [json.string(message)])
    }
    let _ = log_event |> logging.add_fields(fields) |> logging.send
    Nil
  }
}

pub fn phase_name(phase: Phase) -> String {
  case phase {
    Running -> "running"
    Draining -> "draining"
    Forcing -> "forcing"
    Stopped -> "stopped"
  }
}

pub fn trigger_name(trigger: Trigger) -> String {
  case trigger {
    Sigint -> "SIGINT"
    Sigterm -> "SIGTERM"
    StdinEof -> "stdin-eof"
    Timeout -> "timeout"
    Programmatic -> "programmatic"
    ServerError -> "server-error"
    Custom(value) -> value
  }
}

fn handle_message(
  state: State,
  message: Message,
) -> actor.Next(State, Message) {
  let State(
    phase: current_phase,
    attempts:,
    started_at_milliseconds:,
    observer:,
  ) = state
  case message {
    Request(trigger, interactive, reply) -> {
      let next_attempt = attempts + 1
      case current_phase {
        Running -> {
          let event =
            event(
              Draining,
              Running,
              trigger,
              interactive,
              next_attempt,
              started_at_milliseconds,
            )
          observer(event)
          process.send(reply, Drain)
          actor.continue(
            State(..state, phase: Draining, attempts: next_attempt),
          )
        }
        Draining -> {
          let event =
            event(
              Forcing,
              Draining,
              trigger,
              interactive,
              next_attempt,
              started_at_milliseconds,
            )
          observer(event)
          process.send(reply, Force)
          actor.continue(State(..state, phase: Forcing, attempts: next_attempt))
        }
        Forcing | Stopped -> {
          process.send(reply, Ignore)
          actor.continue(State(..state, attempts: next_attempt))
        }
      }
    }
    ForceNow(trigger, interactive, reply) -> {
      let next_attempt = attempts + 1
      case current_phase {
        Forcing | Stopped -> {
          process.send(reply, Ignore)
          actor.continue(State(..state, attempts: next_attempt))
        }
        Running | Draining -> {
          let event =
            event(
              Forcing,
              current_phase,
              trigger,
              interactive,
              next_attempt,
              started_at_milliseconds,
            )
          observer(event)
          process.send(reply, Force)
          actor.continue(State(..state, phase: Forcing, attempts: next_attempt))
        }
      }
    }
    MarkStopped(trigger, interactive, reply) -> {
      case current_phase {
        Stopped -> Nil
        _ ->
          observer(event(
            Stopped,
            current_phase,
            trigger,
            interactive,
            attempts,
            started_at_milliseconds,
          ))
      }
      process.send(reply, Nil)
      actor.continue(State(..state, phase: Stopped))
    }
    ReadPhase(reply) -> {
      process.send(reply, current_phase)
      actor.continue(state)
    }
  }
}

fn event(
  phase: Phase,
  previous_phase: Phase,
  trigger: Trigger,
  interactive: Bool,
  attempt: Int,
  started_at_milliseconds: Int,
) -> ShutdownEvent {
  ShutdownEvent(
    phase:,
    previous_phase:,
    trigger:,
    interactive:,
    attempt:,
    elapsed_milliseconds: monotonic_milliseconds() - started_at_milliseconds,
    message: case phase {
      Draining -> "graceful shutdown started; no new work will be accepted"
      Forcing -> "forced shutdown started; remaining work will be terminated"
      Stopped -> "shutdown complete"
      Running -> "shutdown coordinator running"
    },
  )
}
