use oresoftware_next_loggers_request_context::{
    capture_request_context, current_correlation_id, current_logged_in_user_id,
    current_request_context, current_request_id, current_session_id, current_tenant_id,
    spawn_with_current_request_context, with_captured_request_context, with_request_context,
    RequestContext, REQUEST_CONTEXT_SCHEMA,
};
use std::collections::BTreeMap;

fn request(id: &str) -> RequestContext {
    RequestContext {
        request_id: format!("request-{id}"),
        logged_in_user_id: Some(format!("user-{id}")),
        tenant_id: Some(format!("tenant-{id}")),
        session_id: Some(format!("session-{id}")),
        correlation_id: Some(format!("correlation-{id}")),
        parent_request_id: Some("request-parent".into()),
        trace_id: Some(format!("{id:0<32}")),
        span_id: Some(format!("{id:0<16}")),
        operation: Some("GET /v1/profile".into()),
        service_name: Some("profile-api".into()),
        locale: Some("en-US".into()),
        started_at_unix_ms: Some(1_000),
        deadline_unix_ms: Some(2_000),
        baggage: BTreeMap::from([("region".into(), id.into())]),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_futures_do_not_observe_sibling_request_context() {
    let alpha = with_request_context(request("alpha"), async {
        tokio::task::yield_now().await;
        assert_eq!(current_request_id().as_deref(), Some("request-alpha"));
        assert_eq!(current_logged_in_user_id().as_deref(), Some("user-alpha"));
        assert_eq!(current_tenant_id().as_deref(), Some("tenant-alpha"));
        assert_eq!(current_session_id().as_deref(), Some("session-alpha"));
        assert_eq!(
            current_correlation_id().as_deref(),
            Some("correlation-alpha")
        );
        current_request_context().expect("alpha request context")
    });
    let beta = with_request_context(request("beta"), async {
        tokio::task::yield_now().await;
        assert_eq!(current_request_id().as_deref(), Some("request-beta"));
        assert_eq!(current_logged_in_user_id().as_deref(), Some("user-beta"));
        current_request_context().expect("beta request context")
    });

    let (alpha, beta) = tokio::join!(alpha, beta);
    assert_eq!(alpha.request_id, "request-alpha");
    assert_eq!(beta.request_id, "request-beta");
    assert_eq!(current_request_id(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn captured_context_crosses_detached_boundaries_only_when_reentered() {
    let captured =
        with_request_context(request("capture"), async { capture_request_context() }).await;
    assert_eq!(current_request_id(), None);

    with_captured_request_context(captured.clone(), async {
        tokio::task::yield_now().await;
        assert_eq!(current_request_id().as_deref(), Some("request-capture"));
    })
    .await;

    with_request_context(request("spawn"), async {
        let handle = spawn_with_current_request_context(async {
            tokio::task::yield_now().await;
            current_request_id()
        });
        assert_eq!(
            handle.await.expect("spawned task"),
            Some("request-spawn".into())
        );
    })
    .await;
}

#[test]
fn projection_uses_stable_fields_and_one_log_context_shape() {
    let request = request("fields");
    let log_context = request.to_log_context();
    assert_eq!(
        log_context
            .fields
            .get("request.context.schema")
            .and_then(|value| value.as_str()),
        Some(REQUEST_CONTEXT_SCHEMA)
    );
    assert_eq!(
        log_context
            .fields
            .get("request.id")
            .and_then(|value| value.as_str()),
        Some("request-fields")
    );
    assert_eq!(
        log_context
            .logged_in_user
            .get("id")
            .and_then(|value| value.as_str()),
        Some("user-fields")
    );
    assert_eq!(
        RequestContext::from_log_context(&log_context),
        Some(request)
    );
}
