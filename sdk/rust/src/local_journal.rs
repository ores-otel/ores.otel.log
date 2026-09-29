//! Private, bounded local JSONL journals for desktop/server processes.
//!
//! This module is deliberately local-only. Application-owned structured records use the
//! canonical `next-loggers/v1` envelope; arbitrary child stdout/stderr is wrapped in the
//! separate `ores-process-stdio/v1` envelope so raw process output can never be confused
//! with an application log record or be forwarded to remote transports by accident.

use crate::{LogLevel, LogRecord, LoggerError, Transport};
use serde::Serialize;
use serde_json::Value;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

pub const LOCAL_LOG_ROOT_ENV: &str = "ORES_LOCAL_LOG_ROOT";
pub const DEFAULT_LOCAL_LOG_RETENTION: Duration = Duration::from_secs(6 * 60 * 60);
pub const DEFAULT_LOCAL_LOG_SEGMENT_DURATION: Duration = Duration::from_secs(15 * 60);
pub const DEFAULT_MAX_STDIO_LINE_BYTES: usize = 64 * 1024;
pub const DEFAULT_MAX_LOCAL_SEGMENT_BYTES: u64 = 25 * 1024 * 1024;
pub const DEFAULT_MAX_LOCAL_PROCESS_BYTES: u64 = 500 * 1024 * 1024;
const MAX_APP_NAME_BYTES: usize = 128;
const MAX_SOURCE_NAME_BYTES: usize = 256;
const MAX_PROCESS_DIRECTORY_COLLISIONS: u32 = 1024;
const REDACTED_VALUE: &str = "[REDACTED]";

#[derive(Clone, Debug)]
pub struct LocalJournalOptions {
    pub root: PathBuf,
    pub app_name: String,
    pub retention: Duration,
    pub segment_duration: Duration,
    pub max_stdio_line_bytes: usize,
}

impl LocalJournalOptions {
    /// Canonical desktop/laptop location: `$HOME/tmp/logs/<app>/<pid>-<start-ms>`.
    pub fn for_app(app_name: impl Into<String>) -> Result<Self, LoggerError> {
        Ok(Self {
            root: default_local_log_root(),
            app_name: app_name.into(),
            retention: DEFAULT_LOCAL_LOG_RETENTION,
            segment_duration: DEFAULT_LOCAL_LOG_SEGMENT_DURATION,
            max_stdio_line_bytes: DEFAULT_MAX_STDIO_LINE_BYTES,
        })
    }

    pub fn at_root(root: impl Into<PathBuf>, app_name: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            app_name: app_name.into(),
            retention: DEFAULT_LOCAL_LOG_RETENTION,
            segment_duration: DEFAULT_LOCAL_LOG_SEGMENT_DURATION,
            max_stdio_line_bytes: DEFAULT_MAX_STDIO_LINE_BYTES,
        }
    }

    fn validate(&self) -> Result<(), LoggerError> {
        validate_component(&self.app_name, "app name", MAX_APP_NAME_BYTES)?;
        if self.retention.is_zero() {
            return Err(LoggerError("local log retention must be non-zero".into()));
        }
        if self.segment_duration.is_zero() {
            return Err(LoggerError(
                "local log segment duration must be non-zero".into(),
            ));
        }
        if self.segment_duration > self.retention {
            return Err(LoggerError(
                "local log segment duration must not exceed retention".into(),
            ));
        }
        if self.max_stdio_line_bytes == 0 {
            return Err(LoggerError(
                "local stdio line byte limit must be non-zero".into(),
            ));
        }
        Ok(())
    }
}

pub fn default_local_log_root() -> PathBuf {
    if let Some(root) = std::env::var_os(LOCAL_LOG_ROOT_ENV).filter(|value| !value.is_empty()) {
        return PathBuf::from(root);
    }
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(home).join("tmp").join("logs");
    }
    std::env::temp_dir().join("ores-logs")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StdioStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedStdioLine {
    pub bytes: Vec<u8>,
    pub observed_bytes: usize,
}

impl DecodedStdioLine {
    pub fn truncated(&self) -> bool {
        self.observed_bytes > self.bytes.len()
    }
}

/// Incremental newline decoder that never retains more than `max_bytes` of one line.
/// Bytes beyond the limit are counted but discarded until newline/EOF so callers can
/// preserve exact terminal output while keeping diagnostic memory bounded.
#[derive(Debug)]
pub struct BoundedStdioLineDecoder {
    buffer: Vec<u8>,
    max_bytes: usize,
    observed_bytes: usize,
}

impl BoundedStdioLineDecoder {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buffer: Vec::with_capacity(max_bytes.min(8 * 1024).max(1)),
            max_bytes: max_bytes.max(1),
            observed_bytes: 0,
        }
    }

    pub fn ingest(&mut self, bytes: &[u8]) -> Vec<DecodedStdioLine> {
        let mut output = Vec::new();
        for byte in bytes {
            if *byte == b'\n' {
                output.push(DecodedStdioLine {
                    bytes: std::mem::take(&mut self.buffer),
                    observed_bytes: self.observed_bytes,
                });
                self.observed_bytes = 0;
                continue;
            }
            self.observed_bytes = self.observed_bytes.saturating_add(1);
            if self.buffer.len() < self.max_bytes {
                self.buffer.push(*byte);
            }
        }
        output
    }

    pub fn finish(&mut self) -> Option<DecodedStdioLine> {
        if self.observed_bytes == 0 && self.buffer.is_empty() {
            return None;
        }
        let line = DecodedStdioLine {
            bytes: std::mem::take(&mut self.buffer),
            observed_bytes: self.observed_bytes,
        };
        self.observed_bytes = 0;
        Some(line)
    }
}

#[derive(Debug)]
struct SegmentWriter {
    segment_start: u64,
    sequence: u32,
    bytes_written: u64,
    file: File,
}

#[derive(Debug, Default)]
struct JournalState {
    events: Option<SegmentWriter>,
    stdio: Option<SegmentWriter>,
    total_bytes: u64,
}

#[derive(Debug)]
pub struct LocalJournal {
    options: LocalJournalOptions,
    app_dir: PathBuf,
    process_dir: PathBuf,
    process_id: u32,
    started_unix_millis: u128,
    state: Mutex<JournalState>,
}

impl LocalJournal {
    pub fn open(options: LocalJournalOptions) -> Result<Self, LoggerError> {
        options.validate()?;
        ensure_private_directory(&options.root)?;
        let app_dir = options.root.join(&options.app_name);
        ensure_private_directory(&app_dir)?;

        let now = SystemTime::now();
        prune_app_dir(&app_dir, options.retention, options.segment_duration, now)?;

        let process_id = std::process::id();
        let started_unix_millis = unix_millis(now);
        let process_dir = create_unique_process_directory(
            &app_dir,
            process_id,
            started_unix_millis,
        )?;

        Ok(Self {
            options,
            app_dir,
            process_dir,
            process_id,
            started_unix_millis,
            state: Mutex::new(JournalState::default()),
        })
    }

    pub fn process_dir(&self) -> &Path {
        &self.process_dir
    }

    pub fn app_dir(&self) -> &Path {
        &self.app_dir
    }

    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    pub fn started_unix_millis(&self) -> u128 {
        self.started_unix_millis
    }

    pub fn max_stdio_line_bytes(&self) -> usize {
        self.options.max_stdio_line_bytes
    }

    /// Remove complete segments that fall entirely outside the configured retention window.
    pub fn prune(&self) -> Result<(), LoggerError> {
        prune_app_dir(
            &self.app_dir,
            self.options.retention,
            self.options.segment_duration,
            SystemTime::now(),
        )
    }

    /// Write one arbitrary child-process line into the private stdio journal.
    ///
    /// Raw stdout/stderr may contain credentials or user data. This API writes only to the
    /// local private journal, never invokes Logger transports or OTEL exporters, and applies
    /// bounded best-effort redaction before persistence. The exact bytes may still be teed to
    /// the interactive terminal by the caller.
    pub fn write_stdio_line(
        &self,
        source_name: &str,
        source_pid: Option<u32>,
        stream: StdioStream,
        line: &[u8],
    ) -> Result<(), LoggerError> {
        self.write_stdio_line_observed(source_name, source_pid, stream, line, line.len())
    }

    /// Variant for bounded pipe readers that retain only a prefix of a long line.
    /// `observed_line_bytes` records the payload length before truncation.
    pub fn write_stdio_line_observed(
        &self,
        source_name: &str,
        source_pid: Option<u32>,
        stream: StdioStream,
        line: &[u8],
        observed_line_bytes: usize,
    ) -> Result<(), LoggerError> {
        let source_name = bounded_text(source_name, MAX_SOURCE_NAME_BYTES);
        let line = trim_line_ending(line);
        let original_bytes = observed_line_bytes.max(line.len());
        let kept = &line[..line.len().min(self.options.max_stdio_line_bytes)];
        let severity = if line.len() <= self.options.max_stdio_line_bytes {
            structured_level(line)
        } else {
            None
        }
        .unwrap_or(LogLevel::Info);
        let (message, redacted) = sanitize_stdio_message(kept, self.options.max_stdio_line_bytes);
        let truncated = kept.len() != original_bytes;

        let record = LocalStdioRecord {
            schema: "ores-process-stdio/v1",
            timestamp_unix_ms: unix_millis(SystemTime::now()),
            level: severity,
            app_name: &self.options.app_name,
            supervisor_pid: self.process_id,
            source_name: &source_name,
            source_pid,
            stream,
            message: &message,
            line_bytes: original_bytes,
            truncated,
            redacted,
        };
        let encoded = serde_json::to_vec(&record).map_err(LoggerError::from)?;
        self.write_encoded(StreamKind::Stdio, &encoded, SystemTime::now())
    }

    fn write_record(&self, record: &LogRecord) -> Result<(), LoggerError> {
        let encoded = serde_json::to_vec(record).map_err(LoggerError::from)?;
        self.write_encoded(StreamKind::Events, &encoded, SystemTime::now())
    }

    fn write_encoded(
        &self,
        kind: StreamKind,
        encoded: &[u8],
        now: SystemTime,
    ) -> Result<(), LoggerError> {
        let encoded_len = u64::try_from(encoded.len())
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        if encoded_len > DEFAULT_MAX_LOCAL_SEGMENT_BYTES {
            return Err(LoggerError(
                "local log record exceeds the segment byte budget".into(),
            ));
        }

        let now_secs = unix_seconds(now);
        let segment_secs = self.options.segment_duration.as_secs().max(1);
        let segment_start = (now_secs / segment_secs) * segment_secs;
        let mut state = self
            .state
            .lock()
            .map_err(|error| LoggerError(error.to_string()))?;

        if state.total_bytes.saturating_add(encoded_len) > DEFAULT_MAX_LOCAL_PROCESS_BYTES {
            return Err(LoggerError(
                "local log process byte budget exhausted".into(),
            ));
        }

        let rotate = match kind {
            StreamKind::Events => state.events.as_ref(),
            StreamKind::Stdio => state.stdio.as_ref(),
        }
        .map(|writer| {
            writer.segment_start != segment_start
                || writer.bytes_written.saturating_add(encoded_len)
                    > DEFAULT_MAX_LOCAL_SEGMENT_BYTES
        })
        .unwrap_or(true);

        if rotate {
            let next_sequence = match kind {
                StreamKind::Events => state.events.as_ref(),
                StreamKind::Stdio => state.stdio.as_ref(),
            }
            .filter(|writer| writer.segment_start == segment_start)
            .map(|writer| writer.sequence.saturating_add(1))
            .unwrap_or(0);

            if let Some(writer) = match kind {
                StreamKind::Events => state.events.as_mut(),
                StreamKind::Stdio => state.stdio.as_mut(),
            } {
                writer
                    .file
                    .flush()
                    .map_err(|error| LoggerError(error.to_string()))?;
            }

            let (file, sequence) =
                open_segment_file(&self.process_dir, kind, segment_start, next_sequence)?;
            let writer = SegmentWriter {
                segment_start,
                sequence,
                bytes_written: 0,
                file,
            };
            match kind {
                StreamKind::Events => state.events = Some(writer),
                StreamKind::Stdio => state.stdio = Some(writer),
            }
        }

        let writer = match kind {
            StreamKind::Events => state.events.as_mut(),
            StreamKind::Stdio => state.stdio.as_mut(),
        }
        .ok_or_else(|| LoggerError("local journal segment is unavailable".into()))?;
        writer
            .file
            .write_all(encoded)
            .and_then(|()| writer.file.write_all(b"\n"))
            .map_err(|error| LoggerError(error.to_string()))?;
        writer.bytes_written = writer.bytes_written.saturating_add(encoded_len);
        state.total_bytes = state.total_bytes.saturating_add(encoded_len);
        drop(state);

        self.prune()?;
        Ok(())
    }

    fn flush_all(&self) -> Result<(), LoggerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| LoggerError(error.to_string()))?;
        if let Some(writer) = state.events.as_mut() {
            writer
                .file
                .flush()
                .map_err(|error| LoggerError(error.to_string()))?;
        }
        if let Some(writer) = state.stdio.as_mut() {
            writer
                .file
                .flush()
                .map_err(|error| LoggerError(error.to_string()))?;
        }
        Ok(())
    }
}

impl Transport for LocalJournal {
    fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
        self.write_record(record)
    }

    fn flush(&self) -> Result<(), LoggerError> {
        self.flush_all()
    }

    fn close(&self) -> Result<(), LoggerError> {
        self.flush_all()
    }
}

#[derive(Clone, Copy, Debug)]
enum StreamKind {
    Events,
    Stdio,
}

impl StreamKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Events => "events",
            Self::Stdio => "stdio",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStdioRecord<'a> {
    schema: &'static str,
    timestamp_unix_ms: u128,
    level: LogLevel,
    app_name: &'a str,
    supervisor_pid: u32,
    source_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_pid: Option<u32>,
    stream: StdioStream,
    message: &'a str,
    line_bytes: usize,
    truncated: bool,
    redacted: bool,
}

fn open_segment_file(
    process_dir: &Path,
    kind: StreamKind,
    segment_start: u64,
    mut sequence: u32,
) -> Result<(File, u32), LoggerError> {
    for _ in 0..MAX_PROCESS_DIRECTORY_COLLISIONS {
        let path = process_dir.join(format!(
            "{}-{segment_start}-{sequence}.ndjson",
            kind.prefix()
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&path) {
            Ok(file) => {
                #[cfg(unix)]
                file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|error| {
                    LoggerError(format!("could not harden local log segment: {error}"))
                })?;
                return Ok((file, sequence));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                sequence = sequence.saturating_add(1);
            }
            Err(error) => {
                return Err(LoggerError(format!(
                    "could not open local log segment: {error}"
                )))
            }
        }
    }
    Err(LoggerError(
        "local log segment collision budget exhausted".into(),
    ))
}

fn create_unique_process_directory(
    app_dir: &Path,
    process_id: u32,
    started_unix_millis: u128,
) -> Result<PathBuf, LoggerError> {
    let base = format!("{process_id}-{started_unix_millis}");
    for collision in 0..MAX_PROCESS_DIRECTORY_COLLISIONS {
        let name = if collision == 0 {
            base.clone()
        } else {
            format!("{base}-{collision}")
        };
        let path = app_dir.join(name);
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&path) {
            Ok(()) => {
                ensure_private_directory(&path)?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(LoggerError(format!(
                    "could not create local process log directory: {error}"
                )))
            }
        }
    }
    Err(LoggerError(
        "local process directory collision budget exhausted".into(),
    ))
}

fn ensure_private_directory(path: &Path) -> Result<(), LoggerError> {
    fs::create_dir_all(path)
        .map_err(|error| LoggerError(format!("could not create local log directory: {error}")))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| LoggerError(format!("could not inspect local log directory: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(LoggerError(
            "local log path must be an unaliased directory".into(),
        ));
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| LoggerError(format!("could not harden local log directory: {error}")))?;
    Ok(())
}

fn prune_app_dir(
    app_dir: &Path,
    retention: Duration,
    segment_duration: Duration,
    now: SystemTime,
) -> Result<(), LoggerError> {
    let cutoff = unix_seconds(now).saturating_sub(retention.as_secs());
    let segment_secs = segment_duration.as_secs().max(1);
    let entries = match fs::read_dir(app_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(LoggerError(format!(
                "could not enumerate local log directory: {error}"
            )))
        }
    };

    for entry in entries {
        let entry = entry.map_err(|error| LoggerError(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| LoggerError(error.to_string()))?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let process_dir = entry.path();
        let files = match fs::read_dir(&process_dir) {
            Ok(files) => files,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(LoggerError(error.to_string())),
        };
        for file in files {
            let file = file.map_err(|error| LoggerError(error.to_string()))?;
            let file_type = file
                .file_type()
                .map_err(|error| LoggerError(error.to_string()))?;
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let Some(segment_start) = parse_segment_start(&file.file_name()) else {
                continue;
            };
            if segment_start.saturating_add(segment_secs) <= cutoff {
                match fs::remove_file(file.path()) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(LoggerError(error.to_string())),
                }
            }
        }
        remove_empty_directory_race_safe(&process_dir)?;
    }
    Ok(())
}

fn remove_empty_directory_race_safe(path: &Path) -> Result<(), LoggerError> {
    let empty = match fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(LoggerError(error.to_string())),
    };
    if !empty {
        return Ok(());
    }
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            let became_non_empty = fs::read_dir(path)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
            if became_non_empty {
                return Ok(());
            }
            Err(LoggerError(error.to_string()))
        }
    }
}

fn parse_segment_start(name: &OsStr) -> Option<u64> {
    let name = name.to_str()?;
    let stem = name.strip_suffix(".ndjson")?;
    let rest = stem
        .strip_prefix("events-")
        .or_else(|| stem.strip_prefix("stdio-"))?;
    rest.split('-').next()?.parse().ok()
}

fn validate_component(value: &str, label: &str, max_bytes: usize) -> Result<(), LoggerError> {
    if value.is_empty() || value.len() > max_bytes {
        return Err(LoggerError(format!(
            "{label} must be between 1 and {max_bytes} bytes"
        )));
    }
    if matches!(value, "." | "..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(LoggerError(format!(
            "{label} may contain only ASCII letters, digits, '.', '_' and '-'"
        )));
    }
    Ok(())
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...[truncated]", &value[..end])
}

fn trim_line_ending(mut line: &[u8]) -> &[u8] {
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line = &line[..line.len() - 1];
    }
    line
}

fn structured_level(line: &[u8]) -> Option<LogLevel> {
    let value: Value = serde_json::from_slice(line).ok()?;
    if let Some(number) = value
        .get("severity_number")
        .or_else(|| value.get("severityNumber"))
        .and_then(Value::as_u64)
    {
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
    let level = value
        .get("level")
        .or_else(|| value.get("severity"))
        .or_else(|| value.get("severity_text"))
        .or_else(|| value.get("severityText"))?
        .as_str()?
        .to_ascii_uppercase();
    match level.as_str() {
        "TRACE" => Some(LogLevel::Trace),
        "DEBUG" => Some(LogLevel::Debug),
        "INFO" | "INFORMATION" => Some(LogLevel::Info),
        "WARN" | "WARNING" => Some(LogLevel::Warn),
        "ERROR" | "ERR" => Some(LogLevel::Error),
        "FATAL" | "CRITICAL" | "CRIT" | "PANIC" => Some(LogLevel::Fatal),
        _ => None,
    }
}

fn sanitize_stdio_message(line: &[u8], max_bytes: usize) -> (String, bool) {
    if let Ok(mut value) = serde_json::from_slice::<Value>(line) {
        let redacted = redact_json_value(&mut value);
        if let Ok(encoded) = serde_json::to_string(&value) {
            return (bounded_utf8(&encoded, max_bytes), redacted);
        }
    }
    let text = String::from_utf8_lossy(line).into_owned();
    let (text, redacted) = redact_bearer_tokens(&text);
    (bounded_utf8(&text, max_bytes), redacted)
}

fn redact_json_value(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let mut changed = false;
            for (key, value) in object.iter_mut() {
                if is_sensitive_key(key) {
                    *value = Value::String(REDACTED_VALUE.to_string());
                    changed = true;
                } else if redact_json_value(value) {
                    changed = true;
                }
            }
            changed
        }
        Value::Array(values) => values.iter_mut().any(redact_json_value),
        Value::String(text) => {
            let (redacted, changed) = redact_bearer_tokens(text);
            if changed {
                *text = redacted;
            }
            changed
        }
        _ => false,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace('-', "_");
    matches!(
        normalized.as_str(),
        "authorization"
            | "cookie"
            | "set_cookie"
            | "password"
            | "passwd"
            | "private_key"
            | "access_key"
            | "secret_key"
            | "api_key"
            | "token"
            | "credential"
            | "credentials"
    ) || normalized.ends_with("_token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("_private_key")
        || normalized.ends_with("_access_key")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("_credential")
}

fn redact_bearer_tokens(value: &str) -> (String, bool) {
    let lower = value.to_ascii_lowercase();
    let bytes = value.as_bytes();
    let mut ranges = Vec::new();
    let mut search_from = 0usize;
    while let Some(relative) = lower[search_from..].find("bearer ") {
        let start = search_from + relative;
        let boundary_ok = start == 0
            || bytes
                .get(start.saturating_sub(1))
                .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b':' | b'=' | b'\'' | b'"'));
        let token_start = start + "bearer ".len();
        if boundary_ok && token_start < bytes.len() {
            let mut token_end = token_start;
            while token_end < bytes.len()
                && !bytes[token_end].is_ascii_whitespace()
                && !matches!(bytes[token_end], b',' | b';' | b'\'' | b'"')
            {
                token_end += 1;
            }
            if token_end > token_start {
                ranges.push((token_start, token_end));
            }
        }
        search_from = token_start.min(lower.len());
        if search_from >= lower.len() {
            break;
        }
    }
    if ranges.is_empty() {
        return (value.to_owned(), false);
    }
    let mut output = value.to_owned();
    for (start, end) in ranges.into_iter().rev() {
        output.replace_range(start..end, REDACTED_VALUE);
    }
    (output, true)
}

fn bounded_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn unix_seconds(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn unix_millis(now: SystemTime) -> u128 {
    now.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{json, Logger, Options};
    use std::sync::Arc;

    fn scratch(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "next-loggers-local-journal-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn writes_canonical_events_and_private_stdio_envelopes() {
        let root = scratch("write");
        let journal = Arc::new(
            LocalJournal::open(LocalJournalOptions::at_root(&root, "example-app"))
                .expect("open local journal"),
        );
        let logger = Logger::new(
            Options {
                app_name: "example-app".into(),
                console: false,
                ..Options::default()
            }
            .with_transport(journal.clone()),
        );

        logger
            .error(vec![json!("boom")])
            .send()
            .expect("write structured record");
        journal
            .write_stdio_line(
                "nginx",
                Some(123),
                StdioStream::Stderr,
                b"{\"level\":\"FATAL\",\"message\":\"bad\"}\n",
            )
            .expect("write stdio record");
        journal.flush().expect("flush");

        let files = fs::read_dir(journal.process_dir())
            .expect("read process dir")
            .map(|entry| entry.expect("entry").path())
            .collect::<Vec<_>>();
        assert!(files.iter().any(|path| {
            path.file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with("events-"))
        }));
        assert!(files.iter().any(|path| {
            path.file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with("stdio-"))
        }));

        let stdio = files
            .iter()
            .find(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with("stdio-"))
            })
            .and_then(|path| fs::read_to_string(path).ok())
            .expect("stdio contents");
        let record: Value = serde_json::from_str(stdio.trim()).expect("valid json");
        assert_eq!(record["schema"], "ores-process-stdio/v1");
        assert_eq!(record["stream"], "stderr");
        assert_eq!(record["level"], "FATAL");
        assert_eq!(record["sourceName"], "nginx");
        assert!(record["timestampUnixMs"].as_u64().is_some());

        #[cfg(unix)]
        for path in files {
            assert_eq!(
                fs::metadata(path).expect("metadata").permissions().mode() & 0o777,
                0o600
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unstructured_stderr_is_not_promoted_to_warn() {
        let root = scratch("stderr-info");
        let journal = LocalJournal::open(LocalJournalOptions::at_root(&root, "example-app"))
            .expect("open");
        journal
            .write_stdio_line("worker", None, StdioStream::Stderr, b"plain stderr")
            .expect("write");
        journal.flush().expect("flush");
        let path = fs::read_dir(journal.process_dir())
            .expect("read")
            .map(|entry| entry.expect("entry").path())
            .find(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with("stdio-"))
            })
            .expect("stdio segment");
        let value: Value =
            serde_json::from_str(fs::read_to_string(path).expect("contents").trim()).expect("json");
        assert_eq!(value["level"], "INFO");
        assert_eq!(value["stream"], "stderr");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stdio_is_bounded_and_sensitive_json_is_redacted() {
        let root = scratch("bounded");
        let mut options = LocalJournalOptions::at_root(&root, "bounded-app");
        options.max_stdio_line_bytes = 64;
        let journal = LocalJournal::open(options).expect("open");
        journal
            .write_stdio_line(
                "worker",
                None,
                StdioStream::Stdout,
                br#"{"token":"secret-value","message":"hello"}"#,
            )
            .expect("write");

        let path = fs::read_dir(journal.process_dir())
            .expect("read")
            .map(|entry| entry.expect("entry").path())
            .find(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with("stdio-"))
            })
            .expect("stdio segment");
        let value: Value =
            serde_json::from_str(fs::read_to_string(path).expect("contents").trim()).expect("json");
        assert!(!value["message"].as_str().unwrap().contains("secret-value"));
        assert_eq!(value["redacted"], true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_decoder_never_retains_an_unbounded_line() {
        let mut decoder = BoundedStdioLineDecoder::new(4);
        assert!(decoder.ingest(b"abcdefgh").is_empty());
        let lines = decoder.ingest(b"\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].bytes, b"abcd");
        assert_eq!(lines[0].observed_bytes, 8);
        assert!(lines[0].truncated());
    }

    #[test]
    fn prune_removes_only_complete_expired_segments() {
        let root = scratch("prune");
        let app = root.join("app");
        let process = app.join("111-222");
        ensure_private_directory(&process).expect("dirs");
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let old = process.join("events-100-0.ndjson");
        let recent = process.join("events-9000-0.ndjson");
        fs::write(&old, "{}\n").expect("old");
        fs::write(&recent, "{}\n").expect("recent");

        prune_app_dir(
            &app,
            Duration::from_secs(3_600),
            Duration::from_secs(900),
            now,
        )
        .expect("prune");

        assert!(!old.exists());
        assert!(recent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn prune_never_follows_process_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let root = scratch("symlink");
        let app = root.join("app");
        let outside = root.join("outside");
        ensure_private_directory(&app).expect("app");
        ensure_private_directory(&outside).expect("outside");
        let sentinel = outside.join("events-1-0.ndjson");
        fs::write(&sentinel, "keep me").expect("sentinel");
        symlink(&outside, app.join("999-1")).expect("symlink");

        prune_app_dir(
            &app,
            Duration::from_secs(1),
            Duration::from_secs(1),
            UNIX_EPOCH + Duration::from_secs(10_000),
        )
        .expect("prune");

        assert!(sentinel.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_path_components_and_invalid_window() {
        let root = scratch("validation");
        assert!(LocalJournal::open(LocalJournalOptions::at_root(&root, "../escape")).is_err());

        let mut options = LocalJournalOptions::at_root(&root, "app");
        options.segment_duration = options.retention + Duration::from_secs(1);
        assert!(LocalJournal::open(options).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
