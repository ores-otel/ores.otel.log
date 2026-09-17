//! Runtime-neutral HTTP/HTTPS graceful-shutdown policy.
//!
//! This module deliberately owns policy, not a particular server runtime. Axum,
//! Hyper, Actix, Warp, custom TLS listeners, reverse proxies, and other adapters
//! can share the same semantics:
//!
//! - the first SIGINT/SIGTERM flips admission to draining immediately;
//! - new HTTP requests receive an explicit 429 response contract;
//! - already-admitted work gets a bounded grace period (five seconds by default);
//! - an expired grace period escalates to force-close/cancellation;
//! - interactive SIGINT prints a Ctrl-D hint and repeated SIGINT does not skip the
//!   grace window; stdin EOF / Ctrl-D may force immediately;
//! - logger/OpenTelemetry finalization can be claimed exactly once after runtime
//!   connection/task cleanup.
//!
//! The application still owns signal installation, readiness/listener shutdown,
//! protocol-specific force-close, task cancellation, and the actual flush calls.

use crate::shutdown::{ShutdownAction, ShutdownPhase, ShutdownStateMachine};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default time allowed for already-admitted work to finish.
pub const DEFAULT_HTTP_GRACE_PERIOD: Duration = Duration::from_secs(5);
/// Deliberate 4xx admission response while this process is draining.
pub const SHUTDOWN_HTTP_STATUS: u16 = 429;
pub const SHUTDOWN_HTTP_BODY: &str = "server is shutting down; retry shortly";

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ShutdownTrigger {
    SigInt,
    SigTerm,
    StdinEof,
    Deadline,
    GracefulComplete,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ShutdownDecision {
    Drain,
    Force,
    Complete,
    Ignore,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpShutdownRejection {
    pub status_code: u16,
    /// Whole seconds suitable for the HTTP `Retry-After` header.
    pub retry_after_seconds: u64,
    /// HTTP/1.x adapters should emit `Connection: close` when true.
    pub connection_close: bool,
    pub body: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HttpAdmission {
    Accept,
    Reject(HttpShutdownRejection),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownSignalOutcome {
    pub decision: ShutdownDecision,
    /// Interactive adapters may print this to stderr/console.
    pub terminal_warning: Option<String>,
}

/// Atomic HTTP admission gate plus monotonic drain deadline.
pub struct HttpShutdownGate {
    accepting_new_requests: AtomicBool,
    drain_started_at: Mutex<Option<Instant>>,
    grace_period: Duration,
}

impl Default for HttpShutdownGate {
    fn default() -> Self {
        Self::new(DEFAULT_HTTP_GRACE_PERIOD)
    }
}

impl HttpShutdownGate {
    #[must_use]
    pub const fn new(grace_period: Duration) -> Self {
        Self {
            accepting_new_requests: AtomicBool::new(true),
            drain_started_at: Mutex::new(None),
            grace_period,
        }
    }

    #[must_use]
    pub const fn grace_period(&self) -> Duration {
        self.grace_period
    }

    #[must_use]
    pub fn accepting_new_requests(&self) -> bool {
        self.accepting_new_requests.load(Ordering::Acquire)
    }

    /// Stop admitting new requests and start the grace clock exactly once.
    /// Returns true only for the call that performs the transition.
    pub fn begin_drain(&self) -> bool {
        if self
            .accepting_new_requests
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }

        let mut started = self
            .drain_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *started = Some(Instant::now());
        true
    }

    /// Permanently close admission without changing an already-started deadline.
    pub fn stop_accepting(&self) {
        self.accepting_new_requests.store(false, Ordering::Release);
    }

    #[must_use]
    pub fn drain_started(&self) -> bool {
        self.drain_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    #[must_use]
    pub fn remaining_grace(&self) -> Option<Duration> {
        let started_at = *self
            .drain_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        started_at.map(|started| self.grace_period.saturating_sub(started.elapsed()))
    }

    #[must_use]
    pub fn deadline_expired(&self) -> bool {
        matches!(self.remaining_grace(), Some(remaining) if remaining.is_zero())
    }

    #[must_use]
    pub fn admission(&self) -> HttpAdmission {
        if self.accepting_new_requests() {
            return HttpAdmission::Accept;
        }

        let retry_after_seconds = self
            .remaining_grace()
            .unwrap_or(self.grace_period)
            .as_millis()
            .saturating_add(999)
            / 1_000;

        HttpAdmission::Reject(HttpShutdownRejection {
            status_code: SHUTDOWN_HTTP_STATUS,
            retry_after_seconds: retry_after_seconds as u64,
            connection_close: true,
            body: SHUTDOWN_HTTP_BODY,
        })
    }
}

/// Shared lifecycle controller for HTTP/HTTPS servers.
pub struct HttpShutdownController {
    lifecycle: Mutex<ShutdownStateMachine>,
    gate: HttpShutdownGate,
    finalization_claimed: AtomicBool,
}

impl Default for HttpShutdownController {
    fn default() -> Self {
        Self::new(DEFAULT_HTTP_GRACE_PERIOD)
    }
}

impl HttpShutdownController {
    #[must_use]
    pub fn new(grace_period: Duration) -> Self {
        Self {
            lifecycle: Mutex::new(ShutdownStateMachine::default()),
            gate: HttpShutdownGate::new(grace_period),
            finalization_claimed: AtomicBool::new(false),
        }
    }

    #[must_use]
    pub fn phase(&self) -> ShutdownPhase {
        self.lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .phase()
    }

    #[must_use]
    pub const fn gate(&self) -> &HttpShutdownGate {
        &self.gate
    }

    #[must_use]
    pub fn admission(&self) -> HttpAdmission {
        self.gate.admission()
    }

    #[must_use]
    pub fn remaining_grace(&self) -> Option<Duration> {
        self.gate.remaining_grace()
    }

    #[must_use]
    pub fn deadline_expired(&self) -> bool {
        self.gate.deadline_expired()
    }

    /// Apply a signal/lifecycle event to the shared policy.
    ///
    /// In an interactive terminal, first SIGINT starts draining and repeated
    /// SIGINT is intentionally ignored; Ctrl-D/stdin EOF is the explicit force
    /// gesture. In unattended service mode, a second SIGINT/SIGTERM may force.
    #[must_use]
    pub fn handle_trigger(
        &self,
        trigger: ShutdownTrigger,
        interactive: bool,
    ) -> ShutdownSignalOutcome {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let phase = lifecycle.phase();

        let decision = match (phase, trigger, interactive) {
            (ShutdownPhase::Running, ShutdownTrigger::SigInt | ShutdownTrigger::SigTerm, _) => {
                match lifecycle.trigger() {
                    ShutdownAction::BeginGraceful => ShutdownDecision::Drain,
                    _ => ShutdownDecision::Ignore,
                }
            }
            (ShutdownPhase::Draining, ShutdownTrigger::GracefulComplete, _) => {
                if lifecycle.mark_closed() {
                    ShutdownDecision::Complete
                } else {
                    ShutdownDecision::Ignore
                }
            }
            (ShutdownPhase::Draining, ShutdownTrigger::Deadline, _) => {
                match lifecycle.force_now() {
                    ShutdownAction::Force => ShutdownDecision::Force,
                    _ => ShutdownDecision::Ignore,
                }
            }
            (ShutdownPhase::Draining, ShutdownTrigger::StdinEof, true) => {
                match lifecycle.force_now() {
                    ShutdownAction::Force => ShutdownDecision::Force,
                    _ => ShutdownDecision::Ignore,
                }
            }
            (ShutdownPhase::Draining, ShutdownTrigger::SigInt, true) => ShutdownDecision::Ignore,
            (ShutdownPhase::Draining, ShutdownTrigger::SigInt, false)
            | (ShutdownPhase::Draining, ShutdownTrigger::SigTerm, _) => {
                match lifecycle.trigger() {
                    ShutdownAction::Force => ShutdownDecision::Force,
                    _ => ShutdownDecision::Ignore,
                }
            }
            _ => ShutdownDecision::Ignore,
        };
        drop(lifecycle);

        match decision {
            ShutdownDecision::Drain => {
                self.gate.begin_drain();
            }
            ShutdownDecision::Force | ShutdownDecision::Complete => {
                self.gate.stop_accepting();
            }
            ShutdownDecision::Ignore => {}
        }

        let terminal_warning = if interactive
            && trigger == ShutdownTrigger::SigInt
            && decision == ShutdownDecision::Drain
        {
            Some(format!(
                "graceful shutdown started: new HTTP requests are rejected; in-flight requests have at most {} ms; press Ctrl-D to force shutdown now",
                self.gate.grace_period().as_millis()
            ))
        } else {
            None
        };

        ShutdownSignalOutcome {
            decision,
            terminal_warning,
        }
    }

    /// Escalate when the bounded grace window has expired. Runtime adapters
    /// should then cancel tasks and force-close protocol sessions/connections.
    #[must_use]
    pub fn force_if_deadline_expired(&self) -> ShutdownDecision {
        if self.deadline_expired() {
            self.handle_trigger(ShutdownTrigger::Deadline, false).decision
        } else {
            ShutdownDecision::Ignore
        }
    }

    /// Claim responsibility for final logger/OpenTelemetry flushing exactly once.
    /// The winner should execute its bounded flush after connection/task cleanup.
    #[must_use]
    pub fn claim_finalization(&self) -> bool {
        self.finalization_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn first_signal_rejects_new_requests_immediately() {
        let controller = HttpShutdownController::default();
        assert_eq!(controller.admission(), HttpAdmission::Accept);

        let outcome = controller.handle_trigger(ShutdownTrigger::SigInt, false);
        assert_eq!(outcome.decision, ShutdownDecision::Drain);
        assert_eq!(controller.phase(), ShutdownPhase::Draining);

        match controller.admission() {
            HttpAdmission::Reject(rejection) => {
                assert_eq!(rejection.status_code, 429);
                assert!(rejection.retry_after_seconds <= 5);
                assert!(rejection.connection_close);
            }
            HttpAdmission::Accept => panic!("draining server accepted a new request"),
        }
    }

    #[test]
    fn interactive_sigint_waits_for_ctrl_d_or_deadline() {
        let controller = HttpShutdownController::default();
        let first = controller.handle_trigger(ShutdownTrigger::SigInt, true);
        assert_eq!(first.decision, ShutdownDecision::Drain);
        assert!(first.terminal_warning.is_some());

        let second = controller.handle_trigger(ShutdownTrigger::SigInt, true);
        assert_eq!(second.decision, ShutdownDecision::Ignore);
        assert_eq!(controller.phase(), ShutdownPhase::Draining);

        let eof = controller.handle_trigger(ShutdownTrigger::StdinEof, true);
        assert_eq!(eof.decision, ShutdownDecision::Force);
        assert_eq!(controller.phase(), ShutdownPhase::Forced);
    }

    #[test]
    fn noninteractive_second_signal_forces() {
        let controller = HttpShutdownController::default();
        assert_eq!(
            controller
                .handle_trigger(ShutdownTrigger::SigTerm, false)
                .decision,
            ShutdownDecision::Drain
        );
        assert_eq!(
            controller
                .handle_trigger(ShutdownTrigger::SigTerm, false)
                .decision,
            ShutdownDecision::Force
        );
    }

    #[test]
    fn interactive_second_sigterm_still_forces() {
        let controller = HttpShutdownController::default();
        assert_eq!(
            controller
                .handle_trigger(ShutdownTrigger::SigInt, true)
                .decision,
            ShutdownDecision::Drain
        );
        assert_eq!(
            controller
                .handle_trigger(ShutdownTrigger::SigTerm, true)
                .decision,
            ShutdownDecision::Force
        );
    }

    #[test]
    fn grace_deadline_escalates_without_second_signal() {
        let controller = HttpShutdownController::new(Duration::from_millis(2));
        controller.handle_trigger(ShutdownTrigger::SigTerm, false);
        thread::sleep(Duration::from_millis(4));
        assert!(controller.deadline_expired());
        assert_eq!(controller.force_if_deadline_expired(), ShutdownDecision::Force);
        assert_eq!(controller.phase(), ShutdownPhase::Forced);
    }

    #[test]
    fn finalization_can_be_claimed_exactly_once() {
        let controller = HttpShutdownController::default();
        assert!(controller.claim_finalization());
        assert!(!controller.claim_finalization());
    }

    #[test]
    fn graceful_completion_closes_without_forcing() {
        let controller = HttpShutdownController::default();
        controller.handle_trigger(ShutdownTrigger::SigTerm, false);
        assert_eq!(
            controller
                .handle_trigger(ShutdownTrigger::GracefulComplete, false)
                .decision,
            ShutdownDecision::Complete
        );
        assert_eq!(controller.phase(), ShutdownPhase::Closed);
    }
}