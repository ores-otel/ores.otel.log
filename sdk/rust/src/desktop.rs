//! Shared native-desktop lifecycle logging; no global subscriber or network exporter.
// Named-function returns follow the shared fleet style guide.
#![allow(clippy::needless_return)]

use crate::{
    json, BoundedStdioLineDecoder, LocalJournal, LocalJournalOptions, LogRecord, Logger,
    LoggerError, Options, StdioStream, Transport,
};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;

pub const DEFAULT_DESKTOP_LOCAL_LOG_RETENTION_SECS: u64 = 6 * 60 * 60;
pub const DEFAULT_DESKTOP_LOCAL_LOG_SEGMENT_SECS: u64 = 15 * 60;
pub const DESKTOP_LOCAL_LOG_ROOT_ENV: &str = crate::local_journal::LOCAL_LOG_ROOT_ENV;

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

/// Fan out one structured application record to two transports. The first error
/// is preserved while the second transport is still attempted.
pub struct DesktopTee {
    first: Arc<dyn Transport>,
    second: Arc<dyn Transport>,
}

impl std::fmt::Debug for DesktopTee {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        return formatter.debug_struct("DesktopTee").finish_non_exhaustive();
    }
}

impl DesktopTee {
    pub fn new(first: Arc<dyn Transport>, second: Arc<dyn Transport>) -> Self {
        return Self { first, second };
    }
}

impl Transport for DesktopTee {
    fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
        let first = self.first.write(record);
        let second = self.second.write(record);
        return first.and(second);
    }

    fn flush(&self) -> Result<(), LoggerError> {
        let first = self.first.flush();
        let second = self.second.flush();
        return first.and(second);
    }

    fn close(&self) -> Result<(), LoggerError> {
        let first = self.first.close();
        let second = self.second.close();
        return first.and(second);
    }
}

/// Spawn a supervised child with stdout/stderr captured through the canonical
/// bounded local journal while preserving the exact interactive terminal bytes.
///
/// Raw child output intentionally does **not** pass through the application
/// Logger transport graph. It is persisted only as `ores-process-stdio/v1`, so
/// arbitrary process output cannot accidentally become remotely exported OTEL.
pub fn spawn_with_local_stdio_capture(
    command: &mut Command,
    app_name: &str,
    unit_name: &str,
) -> Result<Child, LoggerError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| LoggerError(error.to_string()))?;
    if let Err(error) = attach_child_stdio_capture(&mut child, app_name, unit_name) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    return Ok(child);
}

/// Attach one already-spawned child to the bounded local journal.
///
/// Both pipes are checked before either is taken so a malformed caller does not
/// lose ownership of one stream on a partial setup failure.
pub fn attach_child_stdio_capture(
    child: &mut Child,
    app_name: &str,
    unit_name: &str,
) -> Result<(), LoggerError> {
    if child.stdout.is_none() || child.stderr.is_none() {
        return Err(LoggerError(
            "child stdout and stderr must both be piped before local capture".to_string(),
        ));
    }

    let process_id = child.id();
    let stdout = child.stdout.take().ok_or_else(|| {
        LoggerError("captured child stdout pipe unavailable".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        LoggerError("captured child stderr pipe unavailable".to_string())
    })?;
    let journal = Arc::new(LocalJournal::open(LocalJournalOptions::for_app(app_name)?)?);

    spawn_stdio_reader(
        stdout,
        journal.clone(),
        process_id,
        unit_name,
        StdioStream::Stdout,
    );
    spawn_stdio_reader(
        stderr,
        journal,
        process_id,
        unit_name,
        StdioStream::Stderr,
    );
    return Ok(());
}

fn spawn_stdio_reader<R>(
    mut reader: R,
    journal: Arc<LocalJournal>,
    process_id: u32,
    unit_name: &str,
    stream: StdioStream,
) where
    R: Read + Send + 'static,
{
    let unit_name = unit_name.to_owned();
    thread::spawn(move || {
        let mut decoder = BoundedStdioLineDecoder::new(journal.max_stdio_line_bytes());
        let mut buffer = [0u8; 8192];
        let mut reported_persistence_failure = false;

        loop {
            let bytes_read = match reader.read(&mut buffer) {
                Ok(bytes_read) => bytes_read,
                Err(error) => {
                    emit_capture_failure_once(
                        &unit_name,
                        stream,
                        &error.to_string(),
                        &mut reported_persistence_failure,
                    );
                    return;
                }
            };
            if bytes_read == 0 {
                if let Some(line) = decoder.finish() {
                    persist_decoded_line(
                        &journal,
                        process_id,
                        &unit_name,
                        stream,
                        line.bytes,
                        line.observed_bytes,
                        &mut reported_persistence_failure,
                    );
                }
                return;
            }

            let bytes = &buffer[..bytes_read];
            tee_raw_stdio(stream, bytes);
            for line in decoder.ingest(bytes) {
                persist_decoded_line(
                    &journal,
                    process_id,
                    &unit_name,
                    stream,
                    line.bytes,
                    line.observed_bytes,
                    &mut reported_persistence_failure,
                );
            }
        }
    });
}

fn persist_decoded_line(
    journal: &LocalJournal,
    process_id: u32,
    unit_name: &str,
    stream: StdioStream,
    bytes: Vec<u8>,
    observed_bytes: usize,
    reported_persistence_failure: &mut bool,
) {
    match journal.write_stdio_line_observed(
        unit_name,
        Some(process_id),
        stream,
        &bytes,
        observed_bytes,
    ) {
        Ok(()) => {
            *reported_persistence_failure = false;
        }
        Err(error) => emit_capture_failure_once(
            unit_name,
            stream,
            &error.to_string(),
            reported_persistence_failure,
        ),
    }
}

fn emit_capture_failure_once(
    unit_name: &str,
    stream: StdioStream,
    error: &str,
    already_reported: &mut bool,
) {
    if *already_reported {
        return;
    }
    *already_reported = true;
    let diagnostic = json!({
        "schema": "ores-internal-diagnostic/v1",
        "event_name": "ores.local_log.capture_failed",
        "severity_text": "ERROR",
        "severity_number": 17,
        "unit": unit_name,
        "stream": match stream {
            StdioStream::Stdout => "stdout",
            StdioStream::Stderr => "stderr",
        },
        "error": error,
    });
    let _ = writeln!(std::io::stderr().lock(), "{diagnostic}");
}

fn tee_raw_stdio(stream: StdioStream, bytes: &[u8]) {
    match stream {
        StdioStream::Stdout => {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(bytes);
            let _ = stdout.flush();
        }
        StdioStream::Stderr => {
            let mut stderr = std::io::stderr().lock();
            let _ = stderr.write_all(bytes);
            let _ = stderr.flush();
        }
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

    pub fn start_with_local_file(
        app_name: &str,
        app_version: &str,
    ) -> Result<Self, LoggerError> {
        let journal = Arc::new(LocalJournal::open(LocalJournalOptions::for_app(app_name)?)?);
        let tee = DesktopTee::new(Arc::new(DesktopStderr), journal);
        return Self::with_transport(app_name, app_version, Arc::new(tee));
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
        let closed = logger.close();
        return emitted.and(closed);
    }
}

impl Drop for DesktopSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

pub fn default_desktop_local_log_root() -> PathBuf {
    return crate::local_journal::default_local_log_root();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_retention_is_six_hours() {
        assert_eq!(DEFAULT_DESKTOP_LOCAL_LOG_RETENTION_SECS, 21_600);
    }

    #[test]
    fn segment_duration_matches_local_journal_policy() {
        assert_eq!(DEFAULT_DESKTOP_LOCAL_LOG_SEGMENT_SECS, 900);
    }
}
