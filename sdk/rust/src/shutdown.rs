//! Runtime-neutral graceful/forceful shutdown state machine.
//!
//! Runtime adapters translate SIGINT, SIGTERM, stdin EOF, cancellation tokens,
//! or supervisor messages into `request`/`force`. This crate intentionally does
//! not install a global signal handler or OpenTelemetry provider.

use crate::{JsonObject, Logger, Value};
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ShutdownPhase {
    Running = 0,
    Draining = 1,
    Forcing = 2,
    Stopped = 3,
}

impl Display for ShutdownPhase {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Running => "running",
            Self::Draining => "draining",
            Self::Forcing => "forcing",
            Self::Stopped => "stopped",
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShutdownTrigger {
    SigInt,
    SigTerm,
    StdinEof,
    Timeout,
    Programmatic,
    ServerError,
    Custom(String),
}

impl Display for ShutdownTrigger {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SigInt => formatter.write_str("SIGINT"),
            Self::SigTerm => formatter.write_str("SIGTERM"),
            Self::StdinEof => formatter.write_str("stdin-eof"),
            Self::Timeout => formatter.write_str("timeout"),
            Self::Programmatic => formatter.write_str("programmatic"),
            Self::ServerError => formatter.write_str("server-error"),
            Self::Custom(value) => formatter.write_str(value),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownDecision {
    Drain,
    Force,
    Ignore,
}

#[derive(Clone, Debug)]
pub struct ShutdownEvent {
    pub phase: ShutdownPhase,
    pub previous_phase: ShutdownPhase,
    pub trigger: ShutdownTrigger,
    pub interactive: bool,
    pub attempt: usize,
    pub elapsed: Duration,
    pub message: String,
    pub error: Option<String>,
}

pub type ShutdownObserver = Arc<dyn Fn(&ShutdownEvent) + Send + Sync + 'static>;

/// Creates a structured next-loggers observer. If the logger has an injected
/// OpenTelemetry transport, the same lifecycle records are exported there.
pub fn logger_shutdown_observer(logger: Logger) -> ShutdownObserver {
    Arc::new(move |event: &ShutdownEvent| {
        let mut fields = JsonObject::new();
        fields.insert(
            "shutdown.phase".into(),
            Value::String(event.phase.to_string()),
        );
        fields.insert(
            "shutdown.previous_phase".into(),
            Value::String(event.previous_phase.to_string()),
        );
        fields.insert(
            "shutdown.trigger".into(),
            Value::String(event.trigger.to_string()),
        );
        fields.insert(
            "shutdown.interactive".into(),
            Value::Bool(event.interactive),
        );
        fields.insert("shutdown.attempt".into(), Value::from(event.attempt as u64));
        fields.insert(
            "shutdown.elapsed_ms".into(),
            Value::from(event.elapsed.as_millis() as u64),
        );
        let mut log_event = match event.phase {
            ShutdownPhase::Forcing => logger.warn(vec![Value::String(event.message.clone())]),
            _ => logger.info(vec![Value::String(event.message.clone())]),
        }
        .add_fields(fields);
        if let Some(error) = &event.error {
            log_event = log_event.add_error(Value::String(error.clone()));
        }
        let _ = log_event.send();
    })
}

pub struct ShutdownCoordinator {
    phase: AtomicU8,
    attempts: AtomicUsize,
    started_at: Instant,
    observer: Option<ShutdownObserver>,
    errors: Mutex<Vec<String>>,
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new(None)
    }
}

impl ShutdownCoordinator {
    pub fn new(observer: Option<ShutdownObserver>) -> Self {
        Self {
            phase: AtomicU8::new(ShutdownPhase::Running as u8),
            attempts: AtomicUsize::new(0),
            started_at: Instant::now(),
            observer,
            errors: Mutex::new(Vec::new()),
        }
    }

    pub fn phase(&self) -> ShutdownPhase {
        match self.phase.load(Ordering::Acquire) {
            0 => ShutdownPhase::Running,
            1 => ShutdownPhase::Draining,
            2 => ShutdownPhase::Forcing,
            _ => ShutdownPhase::Stopped,
        }
    }

    pub fn attempts(&self) -> usize {
        self.attempts.load(Ordering::Acquire)
    }

    pub fn errors(&self) -> Vec<String> {
        self.errors
            .lock()
            .expect("shutdown error registry poisoned")
            .clone()
    }

    /// The first request drains. A second request forces.
    pub fn request(&self, trigger: ShutdownTrigger, interactive: bool) -> ShutdownDecision {
        let attempt = self.attempts.fetch_add(1, Ordering::AcqRel) + 1;
        loop {
            let previous = self.phase();
            let (next, decision) = match previous {
                ShutdownPhase::Running => (ShutdownPhase::Draining, ShutdownDecision::Drain),
                ShutdownPhase::Draining => (ShutdownPhase::Forcing, ShutdownDecision::Force),
                ShutdownPhase::Forcing | ShutdownPhase::Stopped => return ShutdownDecision::Ignore,
            };
            if self
                .phase
                .compare_exchange(
                    previous as u8,
                    next as u8,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                self.emit(previous, next, trigger, interactive, attempt, None);
                return decision;
            }
        }
    }

    /// Timeout/error escalation that does not require an artificial second signal.
    pub fn force(&self, trigger: ShutdownTrigger, interactive: bool) -> ShutdownDecision {
        let attempt = self.attempts.fetch_add(1, Ordering::AcqRel) + 1;
        loop {
            let previous = self.phase();
            match previous {
                ShutdownPhase::Forcing | ShutdownPhase::Stopped => return ShutdownDecision::Ignore,
                ShutdownPhase::Running | ShutdownPhase::Draining => {
                    if self
                        .phase
                        .compare_exchange(
                            previous as u8,
                            ShutdownPhase::Forcing as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        self.emit(
                            previous,
                            ShutdownPhase::Forcing,
                            trigger,
                            interactive,
                            attempt,
                            None,
                        );
                        return ShutdownDecision::Force;
                    }
                }
            }
        }
    }

    pub fn record_error(&self, error: impl Display) {
        self.errors
            .lock()
            .expect("shutdown error registry poisoned")
            .push(error.to_string());
    }

    pub fn mark_stopped(&self, trigger: ShutdownTrigger, interactive: bool) {
        let previous = self.phase();
        if previous == ShutdownPhase::Stopped {
            return;
        }
        self.phase
            .store(ShutdownPhase::Stopped as u8, Ordering::Release);
        self.emit(
            previous,
            ShutdownPhase::Stopped,
            trigger,
            interactive,
            self.attempts(),
            self.errors().last().cloned(),
        );
    }

    fn emit(
        &self,
        previous_phase: ShutdownPhase,
        phase: ShutdownPhase,
        trigger: ShutdownTrigger,
        interactive: bool,
        attempt: usize,
        error: Option<String>,
    ) {
        let message = match phase {
            ShutdownPhase::Draining => "graceful shutdown started; no new work will be accepted",
            ShutdownPhase::Forcing => "forced shutdown started; remaining work will be terminated",
            ShutdownPhase::Stopped => "shutdown complete",
            ShutdownPhase::Running => "shutdown coordinator running",
        }
        .to_string();
        if let Some(observer) = &self.observer {
            observer(&ShutdownEvent {
                phase,
                previous_phase,
                trigger,
                interactive,
                attempt,
                elapsed: self.started_at.elapsed(),
                message,
                error,
            });
        }
    }
}
