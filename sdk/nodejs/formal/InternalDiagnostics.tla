------------------------- MODULE InternalDiagnostics -------------------------
EXTENDS Naturals, TLC

(***************************************************************************
The internal-diagnostic reporter is deliberately independent of the primary
telemetry path. It admits at most one report delivery, suppresses recursive or
concurrent reports into a bounded pending counter with an explicit saturation
bit, advances through one to MaxSinks fallbacks without throwing into
application behavior, and closes terminally after any in-flight delivery
completes.

The model tracks total report outcomes separately from the bounded fields that
are carried by the next record. Provider networks and SDK retry policies are
outside this model; each sink attempt is abstracted as success or failure.
***************************************************************************)

CONSTANTS MaxReports, MaxSuppressed, MaxSinks

Phases == {"idle", "reporting", "closing", "closed"}

VARIABLES phase,
          reports,
          delivered,
          failed,
          suppressed,
          pendingSuppressed,
          pendingSaturated,
          inFlightSuppressed,
          inFlightSaturated,
          closedRejected,
          inFlight,
          sinkIndex,
          sinkCount

vars == <<phase,
          reports,
          delivered,
          failed,
          suppressed,
          pendingSuppressed,
          pendingSaturated,
          inFlightSuppressed,
          inFlightSaturated,
          closedRejected,
          inFlight,
          sinkIndex,
          sinkCount>>

Init ==
    /\ phase = "idle"
    /\ reports = 0
    /\ delivered = 0
    /\ failed = 0
    /\ suppressed = 0
    /\ pendingSuppressed = 0
    /\ pendingSaturated = FALSE
    /\ inFlightSuppressed = 0
    /\ inFlightSaturated = FALSE
    /\ closedRejected = 0
    /\ inFlight = 0
    /\ sinkIndex = 0
    /\ sinkCount = 0

BeginReport ==
    \E count \in 1..MaxSinks:
        /\ phase = "idle"
        /\ reports < MaxReports
        /\ phase' = "reporting"
        /\ reports' = reports + 1
        /\ inFlight' = 1
        /\ inFlightSuppressed' = pendingSuppressed
        /\ inFlightSaturated' = pendingSaturated
        /\ pendingSuppressed' = 0
        /\ pendingSaturated' = FALSE
        /\ sinkIndex' = 1
        /\ sinkCount' = count
        /\ UNCHANGED <<delivered, failed, suppressed, closedRejected>>

SuppressReport ==
    /\ phase \in {"reporting", "closing"}
    /\ reports < MaxReports
    /\ pendingSuppressed < MaxSuppressed
    /\ reports' = reports + 1
    /\ suppressed' = suppressed + 1
    /\ pendingSuppressed' = pendingSuppressed + 1
    /\ UNCHANGED <<phase,
                    delivered,
                    failed,
                    pendingSaturated,
                    inFlightSuppressed,
                    inFlightSaturated,
                    closedRejected,
                    inFlight,
                    sinkIndex,
                    sinkCount>>

SuppressAtCapacity ==
    /\ phase \in {"reporting", "closing"}
    /\ reports < MaxReports
    /\ pendingSuppressed = MaxSuppressed
    /\ reports' = reports + 1
    /\ suppressed' = suppressed + 1
    /\ pendingSaturated' = TRUE
    /\ UNCHANGED <<phase,
                    delivered,
                    failed,
                    pendingSuppressed,
                    inFlightSuppressed,
                    inFlightSaturated,
                    closedRejected,
                    inFlight,
                    sinkIndex,
                    sinkCount>>

RejectClosed ==
    /\ phase = "closed"
    /\ reports < MaxReports
    /\ reports' = reports + 1
    /\ closedRejected' = closedRejected + 1
    /\ UNCHANGED <<phase,
                    delivered,
                    failed,
                    suppressed,
                    pendingSuppressed,
                    pendingSaturated,
                    inFlightSuppressed,
                    inFlightSaturated,
                    inFlight,
                    sinkIndex,
                    sinkCount>>

CloseIdle ==
    /\ phase = "idle"
    /\ phase' = "closed"
    /\ UNCHANGED <<reports,
                    delivered,
                    failed,
                    suppressed,
                    pendingSuppressed,
                    pendingSaturated,
                    inFlightSuppressed,
                    inFlightSaturated,
                    closedRejected,
                    inFlight,
                    sinkIndex,
                    sinkCount>>

BeginClose ==
    /\ phase = "reporting"
    /\ phase' = "closing"
    /\ UNCHANGED <<reports,
                    delivered,
                    failed,
                    suppressed,
                    pendingSuppressed,
                    pendingSaturated,
                    inFlightSuppressed,
                    inFlightSaturated,
                    closedRejected,
                    inFlight,
                    sinkIndex,
                    sinkCount>>

SinkSuccess ==
    /\ phase \in {"reporting", "closing"}
    /\ phase' = IF phase = "closing" THEN "closed" ELSE "idle"
    /\ delivered' = delivered + 1
    /\ inFlight' = 0
    /\ inFlightSuppressed' = 0
    /\ inFlightSaturated' = FALSE
    /\ sinkIndex' = 0
    /\ sinkCount' = 0
    /\ UNCHANGED <<reports,
                    failed,
                    suppressed,
                    pendingSuppressed,
                    pendingSaturated,
                    closedRejected>>

SinkFailureNext ==
    /\ phase \in {"reporting", "closing"}
    /\ sinkIndex < sinkCount
    /\ sinkIndex' = sinkIndex + 1
    /\ UNCHANGED <<phase,
                    reports,
                    delivered,
                    failed,
                    suppressed,
                    pendingSuppressed,
                    pendingSaturated,
                    inFlightSuppressed,
                    inFlightSaturated,
                    closedRejected,
                    inFlight,
                    sinkCount>>

SinksFailed ==
    /\ phase \in {"reporting", "closing"}
    /\ sinkIndex = sinkCount
    /\ phase' = IF phase = "closing" THEN "closed" ELSE "idle"
    /\ failed' = failed + 1
    /\ inFlight' = 0
    /\ inFlightSuppressed' = 0
    /\ inFlightSaturated' = FALSE
    /\ sinkIndex' = 0
    /\ sinkCount' = 0
    /\ UNCHANGED <<reports,
                    delivered,
                    suppressed,
                    pendingSuppressed,
                    pendingSaturated,
                    closedRejected>>

FinishSink == SinkSuccess \/ SinkFailureNext \/ SinksFailed

Next ==
    \/ BeginReport
    \/ SuppressReport
    \/ SuppressAtCapacity
    \/ RejectClosed
    \/ CloseIdle
    \/ BeginClose
    \/ FinishSink

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(FinishSink)

TypeOK ==
    /\ phase \in Phases
    /\ reports \in 0..MaxReports
    /\ delivered \in 0..MaxReports
    /\ failed \in 0..MaxReports
    /\ suppressed \in 0..MaxReports
    /\ pendingSuppressed \in 0..MaxSuppressed
    /\ pendingSaturated \in BOOLEAN
    /\ inFlightSuppressed \in 0..MaxSuppressed
    /\ inFlightSaturated \in BOOLEAN
    /\ closedRejected \in 0..MaxReports
    /\ inFlight \in 0..1
    /\ sinkCount \in 0..MaxSinks
    /\ sinkIndex \in 0..MaxSinks

Conservation ==
    reports = delivered + failed + suppressed + closedRejected + inFlight

InFlightAgreesWithPhase ==
    inFlight = IF phase \in {"reporting", "closing"} THEN 1 ELSE 0

SinkPositionAgreesWithFlight ==
    /\ inFlight = 1 =>
        /\ 1 <= sinkIndex
        /\ sinkIndex <= sinkCount
        /\ sinkCount <= MaxSinks
    /\ inFlight = 0 => sinkIndex = 0 /\ sinkCount = 0

PendingCountersAreBounded ==
    /\ pendingSuppressed <= suppressed
    /\ inFlightSuppressed <= suppressed

ClosedHasNoDelivery ==
    phase = "closed" => inFlight = 0

ClosedNeverReopens ==
    phase = "closed" =>
        ~ENABLED (BeginReport \/ SuppressReport \/ SuppressAtCapacity \/
                  CloseIdle \/ BeginClose \/ FinishSink)

InFlightEventuallyCompletes == inFlight = 1 ~> inFlight = 0

ClosingEventuallyCloses == phase = "closing" ~> phase = "closed"

=============================================================================
