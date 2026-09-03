use oresoftware_next_loggers_request_context::{
    current_request_id, run_with_classified_request_boundary, run_with_request_boundary,
    with_request_context, RequestBoundary, RequestBoundaryCause, RequestFailureKind, RequestScope,
    RequestTransport,
};
use oresoftware_next_loggers_request_context::RequestContext;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

fn request(slot: usize) -> RequestContext {
    RequestContext {
        request_id: format!("request-{slot}"),
        logged_in_user_id: Some(format!("user-{slot}")),
        tenant_id: Some(format!("tenant-{slot}")),
        session_id: Some(format!("session-{slot}")),
        correlation_id: Some(format!("correlation-{slot}")),
        trace_id: Some(format!("{slot:032x}")),
        operation: Some("request-boundary-test".into()),
        baggage: BTreeMap::new(),
        ..Default::default()
    }
}

fn boundary(slot: usize) -> RequestBoundary {
    match slot % 5 {
        0 => RequestBoundary::http("handler", Some(format!("http-{slot}"))),
        1 => RequestBoundary::tcp_connection(
            "accept",
            Some(format!("connection-{slot}")),
            Some("tcp.accept".into()),
        ),
        2 => RequestBoundary::tcp_message(
            "decode",
            Some(format!("connection-{slot}")),
            Some(format!("message-{slot}")),
            Some("tcp.decode".into()),
        ),
        3 => RequestBoundary::websocket_session(
            "upgrade",
            Some(format!("session-{slot}")),
            Some("websocket.upgrade".into()),
        ),
        4 => RequestBoundary::websocket_message(
            "dispatch",
            Some(format!("session-{slot}")),
            Some(format!("message-{slot}")),
            Some("websocket.dispatch".into()),
        ),
        _ => unreachable!(),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn interleaved_protocol_failures_keep_their_own_request_context() {
    let reports = Arc::new(Mutex::new(Vec::new()));
    let mut futures = Vec::new();
    for slot in 0..50usize {
        let reports = Arc::clone(&reports);
        futures.push(run_with_request_boundary(
            request(slot),
            boundary(slot),
            async move {
                for _ in 0..(slot % 4) {
                    tokio::task::yield_now().await;
                }
                assert_eq!(
                    current_request_id().as_deref(),
                    Some(format!("request-{slot}").as_str())
                );
                Err::<usize, String>(format!("failure-{slot}"))
            },
            move |failure| {
                assert_eq!(
                    current_request_id().as_deref(),
                    Some(format!("request-{slot}").as_str())
                );
                reports
                    .lock()
                    .expect("report lock")
                    .push((failure.context.request_id.clone(), failure.boundary.transport));
            },
        ));
    }

    let results = futures::future::join_all(futures).await;
    assert_eq!(current_request_id(), None);
    assert_eq!(reports.lock().expect("report lock").len(), 50);
    for (slot, result) in results.into_iter().enumerate() {
        let failure = result.expect_err("operation should fail");
        assert_eq!(failure.kind, RequestFailureKind::Exception);
        assert_eq!(failure.context.request_id, format!("request-{slot}"));
        match failure.cause {
            RequestBoundaryCause::Error(error) => assert_eq!(error, format!("failure-{slot}")),
            other => panic!("unexpected cause: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn operation_and_reporter_panics_are_contained_by_the_request_boundary() {
    let result = run_with_request_boundary(
        request(60),
        RequestBoundary::websocket_message(
            "dispatch",
            Some("session-60".into()),
            Some("message-60".into()),
            None,
        ),
        async {
            panic!("handler panic");
            #[allow(unreachable_code)]
            Ok::<(), String>(())
        },
        |_failure| panic!("telemetry panic"),
    )
    .await;

    let failure = result.expect_err("panic should become a boundary failure");
    assert_eq!(failure.kind, RequestFailureKind::Panic);
    assert_eq!(failure.context.request_id, "request-60");
    match failure.cause {
        RequestBoundaryCause::Panic(payload) => {
            assert_eq!(payload.downcast_ref::<&'static str>(), Some(&"handler panic"));
        }
        other => panic!("unexpected cause: {other:?}"),
    }
    assert_eq!(current_request_id(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn classifiers_can_map_typed_errors_without_losing_the_cause() {
    let result = run_with_classified_request_boundary(
        request(70),
        RequestBoundary::tcp_message(
            "read",
            Some("connection-70".into()),
            Some("message-70".into()),
            None,
        ),
        async { Err::<(), _>("deadline") },
        |_error, _boundary| RequestFailureKind::Timeout,
        |_failure| {},
    )
    .await;

    let failure = result.expect_err("deadline should fail");
    assert_eq!(failure.kind, RequestFailureKind::Timeout);
    match failure.cause {
        RequestBoundaryCause::Error(error) => assert_eq!(error, "deadline"),
        other => panic!("unexpected cause: {other:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn nested_boundaries_restore_the_parent_poll_local_context() {
    with_request_context(request(80), async {
        let result = run_with_request_boundary(
            request(81),
            RequestBoundary::http("handler", None),
            async {
                assert_eq!(current_request_id().as_deref(), Some("request-81"));
                Ok::<_, String>(81)
            },
            |_failure| {},
        )
        .await;
        assert_eq!(result.expect("inner success"), 81);
        assert_eq!(current_request_id().as_deref(), Some("request-80"));
    })
    .await;
    assert_eq!(current_request_id(), None);
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_state_is_exhaustive_and_does_not_poll_the_operation() {
    let polled = Arc::new(AtomicBool::new(false));
    let operation_polled = Arc::clone(&polled);
    let result = run_with_request_boundary(
        request(90),
        RequestBoundary {
            transport: RequestTransport::Http,
            scope: RequestScope::Message,
            phase: "handler".into(),
            operation: None,
            connection_id: None,
            message_id: None,
        },
        async move {
            operation_polled.store(true, Ordering::SeqCst);
            Ok::<_, String>(())
        },
        |_failure| {},
    )
    .await;

    assert!(!polled.load(Ordering::SeqCst));
    let failure = result.expect_err("invalid boundary should fail");
    assert_eq!(failure.kind, RequestFailureKind::Exception);
    assert!(matches!(
        failure.cause,
        RequestBoundaryCause::InvalidBoundary(_)
    ));
    assert_eq!(failure.context.request_id, "request-90");
}
