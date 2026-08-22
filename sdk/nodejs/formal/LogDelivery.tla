----------------------------- MODULE LogDelivery -----------------------------
EXTENDS Naturals, TLC

(***************************************************************************
Abstract bounded model of the OTEL/Supabase delivery path. It distinguishes
records rejected at admission from accepted records that are acknowledged or
explicitly dropped. This lets TLC detect silent loss, queue overflow, runaway
retries, post-close acceptance, and a close that completes without flushing.
***************************************************************************)

CONSTANTS MaxQueue, MaxAttempts, MaxRetries

Phases == {"open", "closing", "closed"}

VARIABLES phase,
          attempted,
          accepted,
          acknowledged,
          queued,
          inFlight,
          overflowDropped,
          transportDropped,
          shutdownDropped,
          retries,
          flushRequested,
          flushed

vars == <<phase, attempted, accepted, acknowledged, queued, inFlight,
          overflowDropped, transportDropped, shutdownDropped, retries,
          flushRequested, flushed>>

Init ==
    /\ phase = "open"
    /\ attempted = 0
    /\ accepted = 0
    /\ acknowledged = 0
    /\ queued = 0
    /\ inFlight = 0
    /\ overflowDropped = 0
    /\ transportDropped = 0
    /\ shutdownDropped = 0
    /\ retries = 0
    /\ flushRequested = FALSE
    /\ flushed = FALSE

EnqueueAccepted ==
    /\ phase = "open"
    /\ attempted < MaxAttempts
    /\ queued < MaxQueue
    /\ attempted' = attempted + 1
    /\ accepted' = accepted + 1
    /\ queued' = queued + 1
    /\ UNCHANGED <<phase, acknowledged, inFlight, overflowDropped,
                    transportDropped, shutdownDropped, retries,
                    flushRequested, flushed>>

EnqueueOverflow ==
    /\ phase = "open"
    /\ attempted < MaxAttempts
    /\ queued = MaxQueue
    /\ attempted' = attempted + 1
    /\ accepted' = accepted + 1
    /\ overflowDropped' = overflowDropped + 1
    /\ UNCHANGED <<phase, acknowledged, queued, inFlight,
                    transportDropped, shutdownDropped, retries,
                    flushRequested, flushed>>

StartSend ==
    /\ phase \in {"open", "closing"}
    /\ queued > 0
    /\ inFlight = 0
    /\ queued' = queued - 1
    /\ inFlight' = 1
    /\ UNCHANGED <<phase, attempted, accepted, acknowledged,
                    overflowDropped, transportDropped, shutdownDropped,
                    retries, flushRequested, flushed>>

Acknowledge ==
    /\ phase \in {"open", "closing"}
    /\ inFlight = 1
    /\ acknowledged' = acknowledged + 1
    /\ inFlight' = 0
    /\ retries' = 0
    /\ UNCHANGED <<phase, attempted, accepted, queued, overflowDropped,
                    transportDropped, shutdownDropped, flushRequested, flushed>>

RetryWithCapacity ==
    /\ phase \in {"open", "closing"}
    /\ inFlight = 1
    /\ retries < MaxRetries
    /\ queued < MaxQueue
    /\ queued' = queued + 1
    /\ inFlight' = 0
    /\ retries' = retries + 1
    /\ UNCHANGED <<phase, attempted, accepted, acknowledged, overflowDropped,
                    transportDropped, shutdownDropped, flushRequested, flushed>>

RetryAtCapacity ==
    /\ phase \in {"open", "closing"}
    /\ inFlight = 1
    /\ retries < MaxRetries
    /\ queued = MaxQueue
    /\ inFlight' = 0
    /\ overflowDropped' = overflowDropped + 1
    /\ retries' = retries + 1
    /\ UNCHANGED <<phase, attempted, accepted, acknowledged, queued,
                    transportDropped, shutdownDropped, flushRequested, flushed>>

DropTransport ==
    /\ phase \in {"open", "closing"}
    /\ inFlight = 1
    /\ retries = MaxRetries
    /\ transportDropped' = transportDropped + 1
    /\ inFlight' = 0
    /\ retries' = 0
    /\ UNCHANGED <<phase, attempted, accepted, acknowledged, queued,
                    overflowDropped, shutdownDropped, flushRequested, flushed>>

BeginClose ==
    /\ phase = "open"
    /\ phase' = "closing"
    /\ flushRequested' = TRUE
    /\ UNCHANGED <<attempted, accepted, acknowledged, queued, inFlight,
                    overflowDropped, transportDropped, shutdownDropped,
                    retries, flushed>>

FinishClose ==
    /\ phase = "closing"
    /\ queued = 0
    /\ inFlight = 0
    /\ phase' = "closed"
    /\ flushed' = TRUE
    /\ UNCHANGED <<attempted, accepted, acknowledged, queued, inFlight,
                    overflowDropped, transportDropped, shutdownDropped,
                    retries, flushRequested>>

ForceClose ==
    /\ phase = "closing"
    /\ queued + inFlight > 0
    /\ phase' = "closed"
    /\ shutdownDropped' = shutdownDropped + queued + inFlight
    /\ queued' = 0
    /\ inFlight' = 0
    /\ retries' = 0
    /\ flushed' = TRUE
    /\ UNCHANGED <<attempted, accepted, acknowledged, overflowDropped,
                    transportDropped, flushRequested>>

Next ==
    \/ EnqueueAccepted
    \/ EnqueueOverflow
    \/ StartSend
    \/ Acknowledge
    \/ RetryWithCapacity
    \/ RetryAtCapacity
    \/ DropTransport
    \/ BeginClose
    \/ FinishClose
    \/ ForceClose

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(BeginClose)
    /\ WF_vars(StartSend)
    /\ WF_vars(Acknowledge \/ RetryWithCapacity \/ RetryAtCapacity \/ DropTransport)
    /\ WF_vars(FinishClose \/ ForceClose)

TypeOK ==
    /\ phase \in Phases
    /\ attempted \in Nat
    /\ accepted \in Nat
    /\ acknowledged \in Nat
    /\ queued \in Nat
    /\ inFlight \in {0, 1}
    /\ overflowDropped \in Nat
    /\ transportDropped \in Nat
    /\ shutdownDropped \in Nat
    /\ retries \in Nat
    /\ flushRequested \in BOOLEAN
    /\ flushed \in BOOLEAN

QueueIsBounded == queued <= MaxQueue

RetriesAreBounded == retries <= MaxRetries

AttemptedAccounting == attempted = accepted

AcceptedAccounting ==
    accepted = acknowledged + queued + inFlight + overflowDropped
               + transportDropped + shutdownDropped

ClosedIsDrainedAndFlushed ==
    phase = "closed" =>
        queued = 0 /\ inFlight = 0 /\ flushRequested /\ flushed

FlushRequiresCloseRequest == flushed => flushRequested

NoAdmissionAfterCloseRequest ==
    phase # "open" => ~ENABLED (EnqueueAccepted \/ EnqueueOverflow)

ClosedIsTerminal == phase = "closed" => ~ENABLED Next

EventuallyClosed == <> (phase = "closed")

=============================================================================
