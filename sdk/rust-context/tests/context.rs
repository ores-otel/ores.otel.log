use next_loggers::{json, JsonObject, Logger, Options, Value};
use oresoftware_next_loggers_context::{
    current_thread_context, with_thread_context, LogContext, LoggerContextExt, ShutdownAction,
    ShutdownCause, ShutdownPhase, ShutdownState, ThreadContextGuard,
};

fn user(id: &str) -> JsonObject {
    let mut value = JsonObject::new();
    value.insert("id".into(), Value::String(id.into()));
    value
}

#[test]
fn nested_thread_context_restores_after_scope_and_unwind() {
    let outer = LogContext {
        logged_in_user: user("outer"),
        ..LogContext::default()
    };
    with_thread_context(outer.clone(), || {
        assert_eq!(current_thread_context(), Some(outer.clone()));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _inner = ThreadContextGuard::enter(LogContext {
                logged_in_user: user("inner"),
                ..LogContext::default()
            });
            assert_eq!(
                current_thread_context().unwrap().logged_in_user.get("id"),
                Some(&json!("inner"))
            );
            panic!("boom");
        }));
        assert!(result.is_err());
        assert_eq!(current_thread_context(), Some(outer.clone()));
    });
    assert_eq!(current_thread_context(), None);
}

#[test]
fn nested_context_merges_and_preserves_explicit_zero_trace_flags() {
    let outer = LogContext {
        logged_in_user: user("outer"),
        trace_flags: Some(1),
        tags: vec!["outer".into()],
        ..LogContext::default()
    };
    with_thread_context(outer, || {
        let mut patch_user = JsonObject::new();
        patch_user.insert("role".into(), json!("admin"));
        with_thread_context(
            LogContext {
                logged_in_user: patch_user,
                trace_flags: Some(0),
                tags: vec!["inner".into()],
                ..LogContext::default()
            },
            || {
                let current = current_thread_context().unwrap();
                assert_eq!(current.logged_in_user.get("id"), Some(&json!("outer")));
                assert_eq!(current.logged_in_user.get("role"), Some(&json!("admin")));
                assert_eq!(current.trace_flags, Some(0));
                assert_eq!(current.tags, vec!["outer".to_string(), "inner".to_string()]);
            },
        );
    });
}

#[test]
fn context_applies_user_trace_span_and_routine() {
    let logger = Logger::new(Options {
        console: false,
        ..Options::default()
    });
    let mut fields = JsonObject::new();
    fields.insert("request.id".into(), json!("req-1"));
    let context = LogContext {
        logged_in_user: user("user-1"),
        fields,
        trace_id: Some("trace-1".into()),
        trace_ids: vec!["trace-1".into(), "trace-2".into()],
        span_id: Some("span-1".into()),
        trace_flags: Some(1),
        routine_id: Some("handler".into()),
        tags: vec!["http".into()],
        ..LogContext::default()
    };

    let record = logger
        .info_with_context(&context, vec![json!("hello")])
        .to_record()
        .unwrap();
    assert_eq!(
        record.logged_in_user.unwrap().get("id"),
        Some(&json!("user-1"))
    );
    assert_eq!(record.trace_id.as_deref(), Some("trace-1"));
    assert_eq!(
        record.trace_ids,
        vec!["trace-1".to_string(), "trace-2".to_string()]
    );
    assert_eq!(record.fields.get("otel.span_id"), Some(&json!("span-1")));
    assert_eq!(record.routine_id.as_deref(), Some("handler"));
}

#[test]
fn thread_context_isolated_across_workers() {
    let handles = (0..32)
        .map(|index| {
            std::thread::spawn(move || {
                with_thread_context(
                    LogContext {
                        logged_in_user: user(&format!("user-{index}")),
                        ..LogContext::default()
                    },
                    || {
                        current_thread_context()
                            .unwrap()
                            .logged_in_user
                            .get("id")
                            .cloned()
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    for (index, handle) in handles.into_iter().enumerate() {
        assert_eq!(handle.join().unwrap(), Some(json!(format!("user-{index}"))));
    }
}

#[test]
fn shutdown_state_requires_explicit_force_escalation() {
    let mut state = ShutdownState::new(true);
    assert_eq!(
        state.trigger(ShutdownCause::Sigint),
        ShutdownAction::BeginGraceful
    );
    assert_eq!(state.phase(), ShutdownPhase::Draining);
    assert_eq!(
        state.trigger(ShutdownCause::StdinEof),
        ShutdownAction::Force
    );
    assert_eq!(state.phase(), ShutdownPhase::Forced);
    assert_eq!(
        state.trigger(ShutdownCause::Sigterm),
        ShutdownAction::Ignore
    );
}

#[test]
fn graceful_completion_and_timeout_are_distinct() {
    let mut graceful = ShutdownState::new(false);
    graceful.trigger(ShutdownCause::Sigterm);
    assert!(graceful.mark_closed());
    assert_eq!(graceful.phase(), ShutdownPhase::Closed);

    let mut timed_out = ShutdownState::new(false);
    timed_out.trigger(ShutdownCause::Sigterm);
    assert_eq!(timed_out.force_timeout(), ShutdownAction::Force);
    assert_eq!(timed_out.phase(), ShutdownPhase::Forced);
}
