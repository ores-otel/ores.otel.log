//! Leptos hydration/CSR and Dioxus-web adapter. Instantiate in the browser
//! entrypoint, never during SSR. Sinks may capture Rc, JsValue, and JS SDKs;
//! there is no unsound Send/Sync implementation or hidden global context.
use crate::TraceParent;
use next_loggers_wasm::Logger;
pub use next_loggers_wasm::{LogContext, LogLevel, LogRecord};
use std::{
    collections::BTreeMap,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use wasm_bindgen::JsValue;
use web_sys::{Request, RequestCredentials, RequestInit, RequestMode, RequestRedirect, Url};

type LocalSink = dyn Fn(&LogRecord) -> Result<(), String>;

fn random_hex(bytes: usize) -> Result<String, String> {
    let window = web_sys::window().ok_or("browser Window is unavailable")?;
    let mut data = vec![0; bytes];
    window
        .crypto()
        .map_err(|_| "browser crypto is unavailable")?
        .get_random_values_with_u8_array(&mut data)
        .map_err(|_| "browser entropy failed")?;
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}

/// Sampling is an explicit application decision, not forced on by the adapter.
pub fn new_trace(sampled: bool) -> Result<TraceParent, String> {
    TraceParent::new(&random_hex(16)?, &random_hex(8)?, u8::from(sampled))
        .map_err(|error| error.to_string())
}

pub fn child_trace(parent: &TraceParent) -> Result<TraceParent, String> {
    parent
        .child(&random_hex(8)?)
        .map_err(|error| error.to_string())
}

/// Wrap the existing WASM record builder, not a second logging implementation.
/// The application owns its sink and exporter lifecycle. No data is transmitted
/// by this adapter unless the explicitly supplied sink transmits it.
pub struct BrowserLogger {
    logger: Logger,
    sink: Rc<LocalSink>,
}
impl BrowserLogger {
    pub fn new<F>(service: &str, sink: F) -> Result<Self, String>
    where
        F: Fn(&LogRecord) -> Result<(), String> + 'static,
    {
        if service.len() > 128 {
            return Err("service name exceeds 128 bytes".into());
        }
        let prefix = random_hex(16)?;
        let counter = Arc::new(AtomicU64::new(1));
        let logger = Logger::new(service)?
            .with_clock(|| String::from(js_sys::Date::new_0().to_iso_string()))
            .with_id_factory(move || {
                format!("{prefix}-{}", counter.fetch_add(1, Ordering::Relaxed))
            });
        Ok(Self {
            logger,
            sink: Rc::new(sink),
        })
    }

    pub fn log(
        &self,
        level: LogLevel,
        message: &str,
        trace: Option<&TraceParent>,
    ) -> Result<LogRecord, String> {
        let context = trace.map(|trace| LogContext {
            trace_id: Some(trace.trace_id().into()),
            span_id: Some(trace.span_id().into()),
            trace_flags: trace.flags(),
            ..Default::default()
        });
        let record = self
            .logger
            .log(level, message, context.as_ref(), BTreeMap::new())?;
        (self.sink)(&record)?;
        Ok(record)
    }
    pub fn info(&self, message: &str, trace: Option<&TraceParent>) -> Result<LogRecord, String> {
        self.log(LogLevel::Info, message, trace)
    }
}

/// Build a fetch Request with trace context only for this page's exact origin.
/// Redirects are rejected, preventing a same-origin redirect from leaking the
/// header off-origin. Cookies stay same-origin; authentication remains app-owned.
/// The supplied method/body/headers survive reconstruction. No fetch is started.
pub fn traced_request(
    url: &str,
    init: &RequestInit,
    trace: &TraceParent,
) -> Result<Request, JsValue> {
    let window =
        web_sys::window().ok_or_else(|| JsValue::from_str("browser Window is unavailable"))?;
    let request = Request::new_with_str_and_init(url, init)?;
    let target = Url::new(&request.url())?;
    if !matches!(target.protocol().as_str(), "https:" | "http:")
        || target.origin() != window.location().origin()?
        || !target.username().is_empty()
        || !target.password().is_empty()
    {
        return Err(JsValue::from_str(
            "trace propagation requires the page's exact HTTP(S) origin",
        ));
    }
    let secure = RequestInit::new();
    secure.set_mode(RequestMode::SameOrigin);
    secure.set_redirect(RequestRedirect::Error);
    secure.set_credentials(RequestCredentials::SameOrigin);
    let request = Request::new_with_request_and_init(&request, &secure)?;
    request.headers().set("traceparent", &trace.to_string())?;
    Ok(request)
}
