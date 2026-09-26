//! Shared native-desktop lifecycle logging; no global subscriber or network exporter.
use crate::{json, LogRecord, Logger, LoggerError, Options, Transport};
use std::io::Write;
use std::sync::Arc;

/// JSON lines on stderr leave stdout available for command output and IPC.
#[derive(Debug)]
pub struct DesktopStderr;

impl Transport for DesktopStderr {
    fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
        let line = record.to_json()?;
        return writeln!(std::io::stderr().lock(), "{line}")
            .map_err(|error| LoggerError(error.to_string()));
    }
}

/// Owns one logger until the native event loop returns or unwinds.
///
/// Drop is best effort. Call `finish` when delivery failures must be observed.
/// Neither Drop nor finish runs after process::exit, abort, or forced termination.
/// Injected transports must be local/nonblocking: this guard does not impose a
/// deadline on arbitrary Transport implementations.
#[must_use = "keep the session alive for the lifetime of the native event loop"]
pub struct DesktopSession {
    logger: Option<Logger>,
}

impl DesktopSession {
    pub fn start(app_name: &str, app_version: &str) -> Result<Self, LoggerError> {
        return Self::with_transport(app_name, app_version, Arc::new(DesktopStderr));
    }

    pub fn with_transport<T: Transport + 'static>(
        app_name: &str,
        app_version: &str,
        transport: Arc<T>,
    ) -> Result<Self, LoggerError> {
        let logger = Logger::new(
            Options {
                app_name: app_name.to_owned(),
                name: Some("desktop-lifecycle".to_owned()),
                console: false,
                fields: [("app_version".to_owned(), json!(app_version))]
                    .into_iter()
                    .collect(),
                ..Options::default()
            }
            .with_transport(transport),
        );
        if let Err(error) = logger.info(vec![json!("desktop.starting")]).send() {
            let _ = logger.close();
            return Err(error);
        }
        return Ok(Self {
            logger: Some(logger),
        });
    }

    pub fn finish(mut self) -> Result<(), LoggerError> {
        return self.close();
    }

    fn close(&mut self) -> Result<(), LoggerError> {
        let Some(logger) = self.logger.take() else {
            return Ok(());
        };
        let message = if std::thread::panicking() {
            "desktop.unwinding"
        } else {
            "desktop.stopped"
        };
        let emitted = logger.info(vec![json!(message)]).send().map(|_| ());
        // Attempt close even when emitting failed; preserve the first error.
        let closed = logger.close();
        return emitted.and(closed);
    }
}

impl Drop for DesktopSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
