use next_loggers::context::{
    capture_log_context, current_log_context, with_log_context, with_log_context_async, LogContext,
};
use next_loggers::shutdown::{
    ShutdownCoordinator, ShutdownDecision, ShutdownPhase, ShutdownTrigger,
};
use next_loggers::{json, JsonObject, Logger, Options};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

struct NoopWake;
impl Wake for NoopWake {
    fn wake(self: Arc<Self>) {}
}

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let waker = Waker::from(Arc::new(NoopWake));
    let mut context = Context::from_waker(&waker);
    future.poll(&mut context)
}

#[test]
fn scoped_and_future_context_do_not_leak() {
    let context = LogContext {
        fields: JsonObject::from_iter([("request.id".into(), json!("r1"))]),
        logged_in_user: JsonObject::from_iter([("id".into(), json!("u1"))]),
        trace_id: Some("trace-1".into()),
        ..LogContext::default()
    };
    let expected_context = context.clone().normalized();

    let logger = Logger::new(Options {
        console: false,
        ..Options::default()
    });
    let record = with_log_context(context.clone(), || {
        assert_eq!(capture_log_context(), expected_context);
        logger
            .info_context(vec![json!("hello")])
            .to_record()
            .expect("record")
    });
    assert_eq!(current_log_context(), LogContext::default());
    assert_eq!(record.trace_id.as_deref(), Some("trace-1"));
    assert_eq!(record.logged_in_user.expect("user")["id"], json!("u1"));

    let future_context = context.clone().normalized();
    let mut future = Box::pin(with_log_context_async(context, async move {
        current_log_context()
    }));
    assert_eq!(poll_once(future.as_mut()), Poll::Ready(future_context));
    assert_eq!(current_log_context(), LogContext::default());
}

#[test]
fn shutdown_is_drain_then_force() {
    let coordinator = ShutdownCoordinator::default();
    assert_eq!(
        coordinator.request(ShutdownTrigger::SigInt, true),
        ShutdownDecision::Drain
    );
    assert_eq!(coordinator.phase(), ShutdownPhase::Draining);
    assert_eq!(
        coordinator.request(ShutdownTrigger::StdinEof, true),
        ShutdownDecision::Force
    );
    assert_eq!(coordinator.phase(), ShutdownPhase::Forcing);
    coordinator.mark_stopped(ShutdownTrigger::StdinEof, true);
    assert_eq!(coordinator.phase(), ShutdownPhase::Stopped);
}
