//! Shared native-desktop lifecycle logging; no global subscriber or network exporter.
// Named-function returns follow the shared fleet style guide.
#![allow(clippy::needless_return)]

use crate::{json, JsonObject, LogLevel, LogRecord, Logger, LoggerError, Options, Transport, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DEFAULT_DESKTOP_LOCAL_LOG_RETENTION_SECS: u64 = 6 * 60 * 60;
pub const DEFAULT_DESKTOP_LOCAL_LOG_SEGMENT_SECS: u64 = 60 * 60;
pub const DESKTOP_LOCAL_LOG_ROOT_ENV: &str = "ORES_LOCAL_LOG_ROOT";

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

/// Bounded machine-local JSONL cache for native desktop and CLI diagnostics.
///
/// This is deliberately a short-lived diagnostic transport, not an audit log.
/// The default root is `$HOME/tmp/logs`, segments rotate hourly, and files older
/// than six hours are pruned whenever a new segment is opened.
pub struct DesktopLocalFile {
    root: PathBuf,
    app_name: String,
    process_id: u32,
    retention: Duration,
    segment: Duration,
    state: Mutex<Option<DesktopSegment>>,
}

impl std::fmt::Debug for DesktopLocalFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        return formatter
            .debug_struct("DesktopLocalFile")
            .field("root", &self.root)
            .field("app_name", &self.app_name)
            .field("process_id", &self.process_id)
            .field("retention", &self.retention)
            .field("segment", &self.segment)
            .finish_non_exhaustive();
    }
}

impl DesktopLocalFile {
    pub fn new(app_name: &str) -> Result<Self, LoggerError> {
        return Self::for_process_with_root(
            app_name,
            std::process::id(),
            default_desktop_local_log_root(),
        );
    }

    pub fn with_root(app_name: &str, root: PathBuf) -> Result<Self, LoggerError> {
        return Self::for_process_with_root(app_name, std::process::id(), root);
    }

    pub fn for_process(app_name: &str, process_id: u32) -> Result<Self, LoggerError> {
        return Self::for_process_with_root(app_name, process_id, default_desktop_local_log_root());
    }

    pub fn for_process_with_root(
        app_name: &str,
        process_id: u32,
        root: PathBuf,
    ) -> Result<Self, LoggerError> {
        let app_name = sanitize_path_component(app_name);
        let transport = Self {
            root,
            app_name,
            process_id,
            retention: Duration::from_secs(DEFAULT_DESKTOP_LOCAL_LOG_RETENTION_SECS),
            segment: Duration::from_secs(DEFAULT_DESKTOP_LOCAL_LOG_SEGMENT_SECS),
            state: Mutex::new(None),
        };
        ensure_private_directory(&transport.process_directory())?;
        transport.prune()?;
        return Ok(transport);
    }

    pub fn with_retention(mut self, retention: Duration) -> Self {
        self.retention = retention;
        return self;
    }

    pub fn with_segment(mut self, segment: Duration) -> Self {
        self.segment = segment;
        return self;
    }

    pub fn app_directory(&self) -> PathBuf {
        return self.root.join(&self.app_name);
    }

    pub fn process_directory(&self) -> PathBuf {
        return self.app_directory().join(self.process_id.to_string());
    }

    pub fn prune(&self) -> Result<(), LoggerError> {
        let app_directory = self.app_directory();
        if !app_directory.exists() {
            return Ok(());
        }
        let cutoff = SystemTime::now()
            .checked_sub(self.retention)
            .unwrap_or(UNIX_EPOCH);
        prune_tree(&app_directory, cutoff, true)?;
        return Ok(());
    }

    fn write_record(&self, record: &LogRecord) -> Result<(), LoggerError> {
        let now = SystemTime::now();
        let segment_secs = self.segment.as_secs().max(1);
        let current_secs = unix_secs(now);
        let segment_start_secs = current_secs - (current_secs % segment_secs);
        let mut state = self
            .state
            .lock()
            .map_err(|_| LoggerError("desktop local log lock poisoned".to_string()))?;
        let needs_open = state
            .as_ref()
            .map(|segment| segment.segment_start_secs != segment_start_secs)
            .unwrap_or(true);

        if needs_open {
            self.prune()?;
            ensure_private_directory(&self.process_directory())?;
            let path = self
                .process_directory()
                .join(format!("{segment_start_secs}.ndjson"));
            let file = open_private_append(&path)?;
            *state = Some(DesktopSegment {
                file,
                segment_start_secs,
            });
        }

        let segment = state
            .as_mut()
            .ok_or_else(|| LoggerError("desktop local log segment unavailable".to_string()))?;
        let line = record.to_json()?;
        writeln!(segment.file, "{line}").map_err(|error| LoggerError(error.to_string()))?;
        return Ok(());
    }
}

impl Transport for DesktopLocalFile {
    fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
        return self.write_record(record);
    }

    fn flush(&self) -> Result<(), LoggerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| LoggerError("desktop local log lock poisoned".to_string()))?;
        if let Some(segment) = state.as_mut() {
            segment
                .file
                .flush()
                .map_err(|error| LoggerError(error.to_string()))?;
        }
        return Ok(());
    }

    fn close(&self) -> Result<(), LoggerError> {
        self.flush()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| LoggerError("desktop local log lock poisoned".to_string()))?;
        *state = None;
        return Ok(());
    }
}

struct DesktopSegment {
    file: File,
    segment_start_secs: u64,
}

/// Fan out one record to two local transports. The first error is preserved,
/// while the second transport is still attempted so a file outage does not
/// suppress stderr and a terminal outage does not suppress the local cache.
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
/// logger while preserving the exact interactive terminal byte stream.
///
/// The caller remains responsible for environment clearing, working directory,
/// process-group semantics, shutdown and restart policy. This helper owns only
/// stdio capture and the short-lived local log cache.
pub fn spawn_with_local_stdio_capture(
    command: &mut Command,
    app_name: &str,
    unit_name: &str,
) -> Result<Child, LoggerError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| LoggerError(error.to_string()))?;
    let process_id = child.id();
    let stdout = child.stdout.take().ok_or_else(|| {
        return LoggerError("captured child stdout pipe unavailable".to_string());
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        return LoggerError("captured child stderr pipe unavailable".to_string());
    })?;
    let file = match DesktopLocalFile::for_process(app_name, process_id) {
        Ok(file) => Arc::new(file),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let logger = Logger::new(
        Options {
            app_name: app_name.to_owned(),
            name: Some("captured-stdio".to_owned()),
            console: false,
            ..Options::default()
        }
        .with_transport(file),
    );

    spawn_stdio_reader(stdout, logger.clone(), process_id, unit_name, CapturedStream::Stdout);
    spawn_stdio_reader(stderr, logger, process_id, unit_name, CapturedStream::Stderr);
    return Ok(child);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CapturedStream {
    Stdout,
    Stderr,
}

impl CapturedStream {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => return "stdout",
            Self::Stderr => return "stderr",
        }
    }

    fn default_level(self) -> LogLevel {
        match self {
            Self::Stdout => return LogLevel::Info,
            Self::Stderr => return LogLevel::Warn,
        }
    }
}

fn spawn_stdio_reader<R>(
    reader: R,
    logger: Logger,
    process_id: u32,
    unit_name: &str,
    stream: CapturedStream,
) where
    R: Read + Send + 'static,
{
    let unit_name = unit_name.to_owned();
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            let bytes_read = match reader.read_until(b'\n', &mut buffer) {
                Ok(bytes_read) => bytes_read,
                Err(_) => return,
            };
            if bytes_read == 0 {
                return;
            }
            tee_raw_stdio(stream, &buffer);

            let body = String::from_utf8_lossy(&buffer)
                .trim_end_matches(&['\r', '\n'][..])
                .to_string();
            let parsed = serde_json::from_str::<Value>(&body).ok();
            let level = parsed
                .as_ref()
                .and_then(explicit_log_level)
                .unwrap_or_else(|| stream.default_level());
            let mut fields = JsonObject::new();
            fields.insert("process.pid".to_string(), json!(process_id));
            fields.insert("ores.process.unit".to_string(), json!(unit_name));
            fields.insert("ores.stdio.stream".to_string(), json!(stream.as_str()));
            fields.insert(
                "ores.ai.triage".to_string(),
                json!(stream == CapturedStream::Stderr || level.otel_severity_number() >= 13),
            );
            fields.insert("ores.source.structured".to_string(), json!(parsed.is_some()));
            let event = match level {
                LogLevel::Trace => logger.trace(vec![json!(body)]),
                LogLevel::Debug => logger.debug(vec![json!(body)]),
                LogLevel::Info => logger.info(vec![json!(body)]),
                LogLevel::Warn => logger.warn(vec![json!(body)]),
                LogLevel::Error => logger.error(vec![json!(body)]),
                LogLevel::Fatal => logger.fatal(vec![json!(body)]),
            };
            let _ = event.add_fields(fields).send();
        }
    });
}

fn explicit_log_level(value: &Value) -> Option<LogLevel> {
    let number = value
        .get("severity_number")
        .or_else(|| value.get("severityNumber"))
        .and_then(Value::as_u64);
    if let Some(number) = number {
        return match number {
            1..=4 => Some(LogLevel::Trace),
            5..=8 => Some(LogLevel::Debug),
            9..=12 => Some(LogLevel::Info),
            13..=16 => Some(LogLevel::Warn),
            17..=20 => Some(LogLevel::Error),
            21..=24 => Some(LogLevel::Fatal),
            _ => None,
        };
    }
    let text = value
        .get("level")
        .or_else(|| value.get("severity"))
        .or_else(|| value.get("severity_text"))
        .or_else(|| value.get("severityText"))
        .and_then(Value::as_str)?
        .trim()
        .to_ascii_lowercase();
    return match text.as_str() {
        "trace" => Some(LogLevel::Trace),
        "debug" => Some(LogLevel::Debug),
        "info" | "information" => Some(LogLevel::Info),
        "warn" | "warning" => Some(LogLevel::Warn),
        "error" | "err" => Some(LogLevel::Error),
        "fatal" | "critical" | "crit" | "panic" => Some(LogLevel::Fatal),
        _ => None,
    };
}

fn tee_raw_stdio(stream: CapturedStream, bytes: &[u8]) {
    match stream {
        CapturedStream::Stdout => {
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(bytes);
            let _ = stdout.flush();
        }
        CapturedStream::Stderr => {
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
        let file = Arc::new(DesktopLocalFile::new(app_name)?);
        let tee = DesktopTee::new(Arc::new(DesktopStderr), file);
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
    if let Some(root) = env::var_os(DESKTOP_LOCAL_LOG_ROOT_ENV) {
        return PathBuf::from(root);
    }
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home).join("tmp").join("logs");
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        return PathBuf::from(home).join("tmp").join("logs");
    }
    return env::temp_dir().join("ores-logs");
}

fn sanitize_path_component(value: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                return character;
            }
            return '_';
        })
        .collect::<String>();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return "unknown".to_string();
    }
    return sanitized;
}

fn ensure_private_directory(path: &Path) -> Result<(), LoggerError> {
    fs::create_dir_all(path).map_err(|error| LoggerError(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| LoggerError(error.to_string()))?;
    }
    return Ok(());
}

fn open_private_append(path: &Path) -> Result<File, LoggerError> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    return options
        .open(path)
        .map_err(|error| LoggerError(error.to_string()));
}

fn prune_tree(path: &Path, cutoff: SystemTime, keep_root: bool) -> Result<bool, LoggerError> {
    let entries = fs::read_dir(path).map_err(|error| LoggerError(error.to_string()))?;
    let mut has_entries = false;

    for entry in entries {
        let entry = entry.map_err(|error| LoggerError(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| LoggerError(error.to_string()))?;
        let entry_path = entry.path();
        if file_type.is_symlink() {
            has_entries = true;
            continue;
        }
        if file_type.is_dir() {
            if prune_tree(&entry_path, cutoff, false)? {
                has_entries = true;
            }
            continue;
        }
        if !file_type.is_file() {
            has_entries = true;
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::now());
        if modified < cutoff {
            match fs::remove_file(&entry_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(LoggerError(error.to_string())),
            }
        } else {
            has_entries = true;
        }
    }

    if !keep_root && !has_entries {
        match fs::remove_dir(path) {
            Ok(()) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => return Ok(true),
            Err(error) => return Err(LoggerError(error.to_string())),
        }
    }
    return Ok(has_entries);
}

fn unix_secs(time: SystemTime) -> u64 {
    return time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_components_are_confined_to_one_directory() {
        assert_eq!(sanitize_path_component("../../foo/bar"), ".._.._foo_bar");
        assert_eq!(sanitize_path_component(".."), "unknown");
        assert_eq!(sanitize_path_component(""), "unknown");
    }

    #[test]
    fn default_retention_is_six_hours() {
        assert_eq!(DEFAULT_DESKTOP_LOCAL_LOG_RETENTION_SECS, 21_600);
    }

    #[test]
    fn stderr_defaults_to_warn_and_error_json_is_preserved() {
        assert_eq!(CapturedStream::Stderr.default_level(), LogLevel::Warn);
        assert_eq!(
            explicit_log_level(&json!({"level": "error"})),
            Some(LogLevel::Error)
        );
        assert_eq!(
            explicit_log_level(&json!({"severityNumber": 21})),
            Some(LogLevel::Fatal)
        );
    }
}
