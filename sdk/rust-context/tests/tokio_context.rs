#![cfg(feature = "tokio")]

use next_loggers::{json, JsonObject, Value};
use oresoftware_next_loggers_context::{
    current_context, spawn_with_current_context, with_task_context, LogContext,
};

fn context(id: &str) -> LogContext {
    let mut user = JsonObject::new();
    user.insert("id".into(), Value::String(id.into()));
    LogContext {
        logged_in_user: user,
        ..LogContext::default()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn task_local_context_survives_await_and_isolates_concurrency() {
    let first = with_task_context(context("first"), async {
        tokio::task::yield_now().await;
        current_context().unwrap().logged_in_user.get("id").cloned()
    });
    let second = with_task_context(context("second"), async {
        tokio::task::yield_now().await;
        current_context().unwrap().logged_in_user.get("id").cloned()
    });
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first, Some(json!("first")));
    assert_eq!(second, Some(json!("second")));
    assert_eq!(current_context(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn nested_task_context_merges_and_preserves_zero_flags() {
    let mut outer = context("outer");
    outer.trace_flags = Some(1);
    let observed = with_task_context(outer, async {
        let mut role = JsonObject::new();
        role.insert("role".into(), json!("admin"));
        with_task_context(
            LogContext {
                logged_in_user: role,
                trace_flags: Some(0),
                ..LogContext::default()
            },
            async { current_context().unwrap() },
        )
        .await
    })
    .await;
    assert_eq!(observed.logged_in_user.get("id"), Some(&json!("outer")));
    assert_eq!(observed.logged_in_user.get("role"), Some(&json!("admin")));
    assert_eq!(observed.trace_flags, Some(0));
}

#[tokio::test(flavor = "current_thread")]
async fn spawned_task_propagation_is_explicit_and_isolated() {
    let observed = with_task_context(context("parent"), async {
        spawn_with_current_context(async {
            tokio::task::yield_now().await;
            current_context().and_then(|value| value.logged_in_user.get("id").cloned())
        })
        .await
        .unwrap()
    })
    .await;
    assert_eq!(observed, Some(json!("parent")));
    assert_eq!(current_context(), None);
}
