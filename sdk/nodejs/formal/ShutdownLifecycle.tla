-------------------------- MODULE ShutdownLifecycle --------------------------
EXTENDS Naturals, TLC

(***************************************************************************
This model specifies the shared TypeScript, Dart, Rust, Go, and Gleam two-phase shutdown
lifecycle. Runtime callbacks are deliberately abstracted: the safety contract
is that shutdown never returns to running, telemetry is flushed at most once,
and completion is terminal only after that flush completes.
***************************************************************************)

CONSTANT MaxSignals

Phases == {"running", "draining", "forced", "closed"}

VARIABLES phase,
          previousPhase,
          done,
          flushStarted,
          flushCompleted,
          flushCount,
          signalCount

vars == <<phase, previousPhase, done, flushStarted, flushCompleted, flushCount, signalCount>>

PhaseRank == [running |-> 0, draining |-> 1, forced |-> 2, closed |-> 3]

Init ==
    /\ phase = "running"
    /\ previousPhase = "running"
    /\ done = FALSE
    /\ flushStarted = FALSE
    /\ flushCompleted = FALSE
    /\ flushCount = 0
    /\ signalCount = 0

BeginGraceful ==
    /\ phase = "running"
    /\ ~done
    /\ signalCount < MaxSignals
    /\ phase' = "draining"
    /\ previousPhase' = phase
    /\ signalCount' = signalCount + 1
    /\ UNCHANGED <<done, flushStarted, flushCompleted, flushCount>>

Escalate ==
    /\ phase = "draining"
    /\ ~done
    /\ signalCount < MaxSignals
    /\ phase' = "forced"
    /\ previousPhase' = phase
    /\ signalCount' = signalCount + 1
    /\ UNCHANGED <<done, flushStarted, flushCompleted, flushCount>>

ForceNow ==
    /\ phase \in {"running", "draining"}
    /\ ~done
    /\ phase' = "forced"
    /\ previousPhase' = phase
    /\ UNCHANGED <<done, flushStarted, flushCompleted, flushCount, signalCount>>

CompleteFlush ==
    /\ phase \in {"draining", "forced"}
    /\ ~done
    /\ ~flushCompleted
    /\ flushStarted' = TRUE
    /\ flushCompleted' = TRUE
    /\ flushCount' = flushCount + 1
    /\ previousPhase' = phase
    /\ UNCHANGED <<phase, done, signalCount>>

FinishGraceful ==
    /\ phase = "draining"
    /\ ~done
    /\ flushCompleted
    /\ phase' = "closed"
    /\ previousPhase' = phase
    /\ done' = TRUE
    /\ UNCHANGED <<flushStarted, flushCompleted, flushCount, signalCount>>

FinishForced ==
    /\ phase = "forced"
    /\ ~done
    /\ flushCompleted
    /\ done' = TRUE
    /\ previousPhase' = phase
    /\ UNCHANGED <<phase, flushStarted, flushCompleted, flushCount, signalCount>>

Next ==
    \/ BeginGraceful
    \/ Escalate
    \/ ForceNow
    \/ CompleteFlush
    \/ FinishGraceful
    \/ FinishForced

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(BeginGraceful \/ ForceNow)
    /\ WF_vars(CompleteFlush)
    /\ WF_vars(FinishGraceful \/ FinishForced)

TypeOK ==
    /\ phase \in Phases
    /\ previousPhase \in Phases
    /\ done \in BOOLEAN
    /\ flushStarted \in BOOLEAN
    /\ flushCompleted \in BOOLEAN
    /\ flushCount \in Nat
    /\ signalCount \in 0..MaxSignals

FlushProgressIsOrdered == flushCompleted => flushStarted

PhaseNeverRegresses == PhaseRank[phase] >= PhaseRank[previousPhase]

FlushAtMostOnce == flushCount <= 1

CompletionRequiresFlush ==
    done => flushStarted /\ flushCompleted /\ flushCount = 1

CompletionIsTerminal == done => ~ENABLED Next

ClosedMeansGracefulCompletion ==
    phase = "closed" => done /\ flushCompleted

DoneHasTerminalPhase == done => phase \in {"forced", "closed"}

ShutdownEventuallyCompletes == phase # "running" ~> done

=============================================================================
