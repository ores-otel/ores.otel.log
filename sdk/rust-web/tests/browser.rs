#![cfg(all(feature = "browser", target_arch = "wasm32"))]
use ores_otel_web::browser::{BrowserLogger, new_trace, child_trace, traced_request};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen_test::*;
use web_sys::{RequestInit, RequestMode, RequestRedirect};
wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn clock_and_non_send_sink_work_in_real_browser() {
    let records = Rc::new(RefCell::new(Vec::new()));
    let sink = records.clone();
    let logger = BrowserLogger::new("leptos-hydration", move |record| { sink.borrow_mut().push(record.clone()); Ok(()) }).unwrap();
    let trace = new_trace(false).unwrap();
    let first = logger.info("hydrated", Some(&trace)).unwrap();
    let second = logger.info("event", None).unwrap();
    assert_ne!(first.id, second.id);
    assert!(!first.timestamp.starts_with("1970-"));
    assert!(first.timestamp.ends_with('Z'));
    assert_eq!(first.trace_id.as_deref(), Some(trace.trace_id()));
    assert!(second.trace_id.is_none());
    assert_eq!(records.borrow().len(), 2);
}

#[wasm_bindgen_test]
fn browser_children_do_not_reuse_parent_span() {
    let parent = new_trace(false).unwrap();
    let child = child_trace(&parent).unwrap();
    assert_eq!(child.trace_id(), parent.trace_id());
    assert_ne!(child.span_id(), parent.span_id());
    assert!(!child.sampled());
}

#[wasm_bindgen_test]
fn propagation_is_same_origin_and_redirect_safe() {
    let trace = new_trace(false).unwrap();
    let init = RequestInit::new();
    init.set_method("POST");
    let request = traced_request("/api/example", &init, &trace).unwrap();
    assert_eq!(request.method(), "POST");
    assert_eq!(request.mode(), RequestMode::SameOrigin);
    assert_eq!(request.redirect(), RequestRedirect::Error);
    assert_eq!(request.headers().get("traceparent").unwrap().unwrap(), trace.to_string());
    assert!(traced_request("https://example.invalid/api", &init, &trace).is_err());
    assert!(traced_request("data:text/plain,hello", &init, &trace).is_err());
}

#[wasm_bindgen_test]
fn sink_failure_is_explicit_not_a_panic() {
    let logger = BrowserLogger::new("dioxus-web", |_| Err("export unavailable".into())).unwrap();
    assert_eq!(logger.info("event", None).unwrap_err(), "export unavailable");
}
