//! Explicit execution context and graceful-shutdown primitives for
//! `next_loggers`.
//!
//! The synchronous scope is a real thread-local stack and its guard is neither
//! `Send` nor `Sync`. With the `tokio` feature, task-local context is available
//! for futures that can migrate between executor threads. No runtime, global
//! OpenTelemetry provider, or framework is installed or patched.

use next_loggers::{json, Event, JsonObject, Logger, Value};
use std::cell::{Cell, RefCell};
#[cfg(feature = "tokio")]
use std::future::Future;
use std::marker::PhantomData;
use std::rc::Rc;
use std::thread::ThreadId;

#[derive(Clone, Debug)]
struct ThreadContextFrame {
    id: u64,
    context: LogContext,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LogContext {
    pub logged_in_user: JsonObject,
    pub users: Vec<JsonObject>,
    pub fields: JsonObject,
    pub trace_id: Option<String>,
    pub trace_ids: Vec<String>,
    pub span_id: Option<String>,
    pub trace_flags: Option<u8>,
    pub trace_state: Option<String>,
    pub baggage: JsonObject,
    pub routine_id: Option<String>,
    pub tags: Vec<String>,
    pub context: Vec<Value>,
    pub meta: Vec<Value>,
}

fn push_unique(values: &mut Vec<String>, candidate: String) {
    let candidate = candidate.trim().to_string();
    if !candidate.is_empty() && !values.contains(&candidate) {
        values.push(candidate);
    }
}

impl LogContext {
    /// Merge semantics match the TypeScript async-local store: objects merge,
    /// lists append, trace/tag identifiers are de-duplicated, and present
    /// scalar values replace their parent value.
    pub fn merged(mut self, patch: Self) -> Self {
        if let Some(trace_id) = self.trace_id.clone() {
            push_unique(&mut self.trace_ids, trace_id);
        }
        self.logged_in_user.extend(patch.logged_in_user);
        self.users.extend(patch.users);
        self.fields.extend(patch.fields);
        if let Some(trace_id) = patch.trace_id {
            push_unique(&mut self.trace_ids, trace_id.clone());
            self.trace_id = Some(trace_id);
        }
        for trace_id in patch.trace_ids {
            push_unique(&mut self.trace_ids, trace_id);
        }
        if self.trace_id.is_none() {
            self.trace_id = self.trace_ids.first().cloned();
        }
        if patch.span_id.is_some() {
            self.span_id = patch.span_id;
        }
        if patch.trace_flags.is_some() {
            self.trace_flags = patch.trace_flags;
        }
        if patch.trace_state.is_some() {
            self.trace_state = patch.trace_state;
        }
        self.baggage.extend(patch.baggage);
        if patch.routine_id.is_some() {
            self.routine_id = patch.routine_id;
        }
        for tag in patch.tags {
            push_unique(&mut self.tags, tag);
        }
        self.context.extend(patch.context);
        self.meta.extend(patch.meta);
        self
    }
}

thread_local! {
    static THREAD_CONTEXT: RefCell<Vec<ThreadContextFrame>> = const { RefCell::new(Vec::new()) };
    static NEXT_THREAD_CONTEXT_ID: Cell<u64> = const { Cell::new(1) };
}

/// RAII scope for synchronous/thread-bound work. The `Rc` marker intentionally
/// prevents moving a guard to another thread, where popping the stack would be
/// unsound.
pub struct ThreadContextGuard {
    owner: ThreadId,
    frame_id: u64,
    active: bool,
    _not_send_or_sync: PhantomData<Rc<()>>,
}

impl ThreadContextGuard {
    pub fn enter(context: LogContext) -> Self {
        let frame_id = NEXT_THREAD_CONTEXT_ID.with(|next| {
            let id = next.get();
            next.set(id.saturating_add(1).max(1));
            id
        });
        THREAD_CONTEXT.with(|stack| {
            stack.borrow_mut().push(ThreadContextFrame {
                id: frame_id,
                context,
            });
        });
        Self {
            owner: std::thread::current().id(),
            frame_id,
            active: true,
            _not_send_or_sync: PhantomData,
        }
    }

    pub fn close(mut self) {
        self.pop();
    }

    fn pop(&mut self) {
        if !self.active {
            return;
        }
        // Disable Drop re-entry before assertions so misuse cannot cause a
        // double panic while unwinding.
        self.active = false;
        assert_eq!(
            self.owner,
            std::thread::current().id(),
            "next-loggers context guard closed on another thread"
        );
        THREAD_CONTEXT.with(|stack| {
            let mut stack = stack.borrow_mut();
            let current = stack
                .last()
                .expect("next-loggers thread-context stack underflow");
            assert_eq!(
                current.id, self.frame_id,
                "next-loggers thread-context guards must close in LIFO order"
            );
            stack.pop();
        });
    }
}

impl Drop for ThreadContextGuard {
    fn drop(&mut self) {
        self.pop();
    }
}

pub fn current_thread_context() -> Option<LogContext> {
    THREAD_CONTEXT.with(|stack| stack.borrow().last().map(|frame| frame.context.clone()))
}

/// Run synchronous work with a child context merged over the current thread
/// frame. Use `ThreadContextGuard::enter` directly when replacement rather than
/// inheritance is required.
pub fn with_thread_context<T>(context: LogContext, callback: impl FnOnce() -> T) -> T {
    let inherited = current_thread_context().unwrap_or_default().merged(context);
    let _guard = ThreadContextGuard::enter(inherited);
    callback()
}

#[cfg(feature = "tokio")]
tokio::task_local! {
    static TASK_CONTEXT: LogContext;
}

/// Scope a future with task-local context. This is the preferred ambient API
/// for Tokio because a future may move between worker threads.
#[cfg(feature = "tokio")]
pub async fn with_task_context<F>(context: LogContext, future: F) -> F::Output
where
    F: Future,
{
    let inherited = current_context().unwrap_or_default().merged(context);
    TASK_CONTEXT.scope(inherited, future).await
}

#[cfg(feature = "tokio")]
pub fn current_task_context() -> Option<LogContext> {
    TASK_CONTEXT.try_with(Clone::clone).ok()
}

/// Spawn a Tokio task with a snapshot of the current task/thread context. Tokio
/// task-local values are scoped, not implicitly inherited by `tokio::spawn`.
#[cfg(feature = "tokio")]
pub fn spawn_with_current_context<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let context = current_context();
    tokio::spawn(async move {
        match context {
            Some(context) => TASK_CONTEXT.scope(context, future).await,
            None => future.await,
        }
    })
}

/// Detects whether stdin is an interactive terminal (Rust 1.70+).
pub fn stdin_is_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal()
}

/// Returns task-local context first, then a synchronous thread-local scope.
pub fn current_context() -> Option<LogContext> {
    #[cfg(feature = "tokio")]
    if let Some(context) = current_task_context() {
        return Some(context);
    }
    current_thread_context()
}

/// Returns the current authenticated user without exposing mutable shared state.
pub fn current_logged_in_user() -> Option<JsonObject> {
    current_context()
        .and_then(|context| (!context.logged_in_user.is_empty()).then_some(context.logged_in_user))
}

pub fn apply_context(event: Event, context: &LogContext) -> Event {
    let mut fields = context.fields.clone();
    if let Some(span_id) = &context.span_id {
        fields.insert("otel.span_id".into(), Value::String(span_id.clone()));
    }
    if let Some(trace_flags) = context.trace_flags {
        fields.insert("otel.trace_flags".into(), json!(trace_flags));
    }
    if let Some(trace_state) = &context.trace_state {
        fields.insert(
            "otel.trace_state".into(),
            Value::String(trace_state.clone()),
        );
    }
    if !context.baggage.is_empty() {
        fields.insert(
            "otel.baggage".into(),
            Value::Object(context.baggage.clone()),
        );
    }

    let mut event = event.add_fields(fields);
    if !context.logged_in_user.is_empty() {
        event = event.add_logged_in_user_info(context.logged_in_user.clone());
    }
    for user in &context.users {
        event = event.add_user_info(user.clone());
    }
    if let Some(trace_id) = &context.trace_id {
        event = event.add_trace(trace_id.clone(), true);
    }
    for trace_id in &context.trace_ids {
        event = event.add_trace(trace_id.clone(), false);
    }
    if let Some(routine_id) = &context.routine_id {
        event = event.add_routine_id(routine_id.clone());
    }
    event = event.add_tags(context.tags.clone());
    for value in &context.context {
        event = event.add_context(value.clone());
    }
    for value in &context.meta {
        event = event.add_meta(value.clone());
    }
    event
}

pub trait LoggerContextExt {
    fn trace_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event;
    fn debug_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event;
    fn info_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event;
    fn warn_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event;
    fn error_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event;
    fn fatal_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event;

    fn trace_ambient(&self, values: Vec<Value>) -> Event;
    fn debug_ambient(&self, values: Vec<Value>) -> Event;
    fn info_ambient(&self, values: Vec<Value>) -> Event;
    fn warn_ambient(&self, values: Vec<Value>) -> Event;
    fn error_ambient(&self, values: Vec<Value>) -> Event;
    fn fatal_ambient(&self, values: Vec<Value>) -> Event;
}

fn ambient(event: Event) -> Event {
    match current_context() {
        Some(context) => apply_context(event, &context),
        None => event,
    }
}

impl LoggerContextExt for Logger {
    fn trace_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event {
        apply_context(self.trace(values), context)
    }
    fn debug_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event {
        apply_context(self.debug(values), context)
    }
    fn info_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event {
        apply_context(self.info(values), context)
    }
    fn warn_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event {
        apply_context(self.warn(values), context)
    }
    fn error_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event {
        apply_context(self.error(values), context)
    }
    fn fatal_with_context(&self, context: &LogContext, values: Vec<Value>) -> Event {
        apply_context(self.fatal(values), context)
    }

    fn trace_ambient(&self, values: Vec<Value>) -> Event {
        ambient(self.trace(values))
    }
    fn debug_ambient(&self, values: Vec<Value>) -> Event {
        ambient(self.debug(values))
    }
    fn info_ambient(&self, values: Vec<Value>) -> Event {
        ambient(self.info(values))
    }
    fn warn_ambient(&self, values: Vec<Value>) -> Event {
        ambient(self.warn(values))
    }
    fn error_ambient(&self, values: Vec<Value>) -> Event {
        ambient(self.error(values))
    }
    fn fatal_ambient(&self, values: Vec<Value>) -> Event {
        ambient(self.fatal(values))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownCause {
    Sigint,
    Sigterm,
    StdinEof,
    Timeout,
    Programmatic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownPhase {
    Running,
    Draining,
    Forced,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownAction {
    BeginGraceful,
    Force,
    Ignore,
}

/// Framework-neutral state machine shared by Axum, Hyper, tonic, and custom
/// servers. Applications map `BeginGraceful` to cancellation/listener closure,
/// and `Force` to task abortion plus connection/session destruction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShutdownState {
    phase: ShutdownPhase,
    interactive: bool,
    signal_count: u32,
}

impl ShutdownState {
    pub fn new(interactive: bool) -> Self {
        Self {
            phase: ShutdownPhase::Running,
            interactive,
            signal_count: 0,
        }
    }

    pub fn phase(&self) -> ShutdownPhase {
        self.phase
    }

    pub fn interactive(&self) -> bool {
        self.interactive
    }

    pub fn signal_count(&self) -> u32 {
        self.signal_count
    }

    pub fn trigger(&mut self, _cause: ShutdownCause) -> ShutdownAction {
        self.signal_count = self.signal_count.saturating_add(1);
        match self.phase {
            ShutdownPhase::Running => {
                self.phase = ShutdownPhase::Draining;
                ShutdownAction::BeginGraceful
            }
            ShutdownPhase::Draining => {
                self.phase = ShutdownPhase::Forced;
                ShutdownAction::Force
            }
            ShutdownPhase::Forced | ShutdownPhase::Closed => ShutdownAction::Ignore,
        }
    }

    pub fn mark_closed(&mut self) -> bool {
        if self.phase != ShutdownPhase::Draining {
            return false;
        }
        self.phase = ShutdownPhase::Closed;
        true
    }

    pub fn force_timeout(&mut self) -> ShutdownAction {
        if self.phase == ShutdownPhase::Draining {
            self.phase = ShutdownPhase::Forced;
            ShutdownAction::Force
        } else {
            ShutdownAction::Ignore
        }
    }
}

#[cfg(feature = "tokio")]
pub mod tokio_support {
    use super::ShutdownCause;
    use std::future::{pending, Future};
    use std::io;
    use tokio::io::AsyncReadExt;

    async fn stdin_eof(enabled: bool) -> io::Result<()> {
        if !enabled {
            return pending::<io::Result<()>>().await;
        }
        let mut stdin = tokio::io::stdin();
        let mut buffer = [0_u8; 256];
        while stdin.read(&mut buffer).await? != 0 {}
        Ok(())
    }

    /// Wait for one SIGINT/SIGTERM or optional stdin EOF event. Call this again
    /// while draining so a second Ctrl-C/Ctrl-D can map to `ShutdownAction::Force`.
    /// Watching stdin consumes it and should be disabled for interactive apps
    /// that already own stdin.
    #[cfg(unix)]
    pub async fn next_shutdown_cause(watch_stdin_eof: bool) -> io::Result<ShutdownCause> {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigint = signal(SignalKind::interrupt())?;
        let mut sigterm = signal(SignalKind::terminate())?;
        tokio::select! {
            value = sigint.recv() => value.map(|_| ShutdownCause::Sigint).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "SIGINT stream closed")),
            value = sigterm.recv() => value.map(|_| ShutdownCause::Sigterm).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "SIGTERM stream closed")),
            result = stdin_eof(watch_stdin_eof) => result.map(|_| ShutdownCause::StdinEof),
        }
    }

    #[cfg(not(unix))]
    pub async fn next_shutdown_cause(watch_stdin_eof: bool) -> io::Result<ShutdownCause> {
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map(|_| ShutdownCause::Sigint),
            result = stdin_eof(watch_stdin_eof) => result.map(|_| ShutdownCause::StdinEof),
        }
    }

    /// Utility for callers that want a typed pending EOF future in their own
    /// `tokio::select!` orchestration.
    pub fn never() -> impl Future<Output = ()> {
        pending()
    }
}
