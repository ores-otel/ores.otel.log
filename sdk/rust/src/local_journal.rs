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
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const DEFAULT_LOCAL_LOG_RETENTION: Duration = Duration::from_secs(6 * 60 * 60);
pub const DEFAULT_LOCAL_LOG_SEGMENT_DURATION: Duration = Duration::from_secs(15 * 60);
pub const DEFAULT_MAX_STDIO_LINE_BYTES: usize = 64 * 1024;
const MAX_APP_NAME_BYTES: usize = 128;
const MAX_SOURCE_NAME_BYTES: usize = 256;

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
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| LoggerError("HOME/USERPROFILE is unavailable for local logging".into()))?;
        Ok(Self {
            root: PathBuf::from(home).join("tmp").join("logs"),
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StdioStream {
    Stdout,
    Stderr,
}

impl StdioStream {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug)]
struct SegmentWriter {
    segment_start: u64,
    file: File,
}

#[derive(Debug, Default)]
struct JournalState {
    events: Option<SegmentWriter>,
    stdio: Option<SegmentWriter>,
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
        prune_app_dir(
            &app_dir,
            options.retention,
            options.segment_duration,
            now,
        )?;

        let process_id = std::process::id();
        let started_unix_millis = unix_millis(now);
        let process_dir = app_dir.join(format!("{process_id}-{started_unix_millis}"));
        ensure_private_directory(&process_dir)?;

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

    /// Remove complete segments that fall entirely outside the configured retention window.
    ///
    /// This walks every process directory for the app, so a newly started supervisor also
    /// cleans stale journals left by processes that are no longer alive.
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
    /// Raw stdout/stderr may contain credentials or user data. This API intentionally writes
    /// only to the local private journal and never invokes Logger transports or OTEL exporters.
    pub fn write_stdio_line(
        &self,
        source_name: &str,
        source_pid: Option<u32>,
        stream: StdioStream,
        line: &[u8],
    ) -> Result<(), LoggerError> {
        let source_name = bounded_text(source_name, MAX_SOURCE_NAME_BYTES);
        let line = trim_line_ending(line);
        let original_bytes = line.len();
        let kept = &line[..line.len().min(self.options.max_stdio_line_bytes)];
        let message = String::from_utf8_lossy(kept).into_owned();
        let truncated = kept.len() != original_bytes;
        let severity = structured_level(line).unwrap_or_else(|| match stream {
            StdioStream::Stdout => LogLevel::Info,
            StdioStream::Stderr => LogLevel::Warn,
        });

        let record = LocalStdioRecord {
            schema: "ores-process-stdio/v1",
            timestamp: now_rfc3339(),
            level: severity,
            app_name: &self.options.app_name,
            supervisor_pid: self.process_id,
            source_name: &source_name,
            source_pid,
            stream,
            message: &message,
            line_bytes: original_bytes,
            truncated,
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
        let now_secs = unix_seconds(now);
        let segment_secs = self.options.segment_duration.as_secs().max(1);
        let segment_start = (now_secs / segment_secs) * segment_secs;

        let mut state = self
            .state
            .lock()
            .map_err(|error| LoggerError(error.to_string()))?;
        let slot = match kind {
            StreamKind::Events => &mut state.events,
            StreamKind::Stdio => &mut state.stdio,
        };
        let rotate = slot
            .as_ref()
            .is_none_or(|writer| writer.segment_start != segment_start);
        if rotate {
            if let Some(writer) = slot.as_mut() {
                writer
                    .file
                    .flush()
                    .map_err(|error| LoggerError(error.to_string()))?;
            }
            *slot = Some(SegmentWriter {
                segment_start,
                file: open_segment_file(&self.process_dir, kind, segment_start)?,
            });
            drop(state);
            self.prune()?;
            state = self
                .state
                .lock()
                .map_err(|error| LoggerError(error.to_string()))?;
        }

        let slot = match kind {
            StreamKind::Events => &mut state.events,
            StreamKind::Stdio => &mut state.stdio,
        };
        let writer = slot
            .as_mut()
            .ok_or_else(|| LoggerError("local journal segment is unavailable".into()))?;
        writer
            .file
            .write_all(encoded)
            .and_then(|()| writer.file.write_all(b"\n"))
            .map_err(|error| LoggerError(error.to_string()))
    }

    fn flush_all(&self) -> Result<(), LoggerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| LoggerError(error.to_string()))?;
        for writer in [&mut state.events, &mut state.stdio]
            .into_iter()
            .flatten()
        {
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
    timestamp: String,
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
}

fn open_segment_file(
    process_dir: &Path,
    kind: StreamKind,
    segment_start: u64,
) -> Result<File, LoggerError> {
    let path = process_dir.join(format!("{}-{segment_start}.ndjson", kind.prefix()));
    let mut options = OpenOptions::new();
    options.create(true).append(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(&path)
        .map_err(|error| LoggerError(format!("could not open local log segment: {error}")))?;
    #[cfg(unix)]
    {
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| LoggerError(format!("could not harden local log segment: {error}")))?;
    }
    Ok(file)
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
        let metadata = entry
            .metadata()
            .map_err(|error| LoggerError(error.to_string()))?;
        if !metadata.is_dir() {
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
            if !file_type.is_file() {
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
        match fs::remove_dir(&process_dir) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
                ) => {}
            Err(error) => return Err(LoggerError(error.to_string())),
        }
    }
    Ok(())
}

fn parse_segment_start(name: &OsStr) -> Option<u64> {
    let name = name.to_str()?;
    let stem = name.strip_suffix(".ndjson")?;
    let (_, value) = stem.rsplit_once('-')?;
    value.parse().ok()
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
    let level = value.get("level")?.as_str()?.to_ascii_uppercase();
    match level.as_str() {
        "TRACE" => Some(LogLevel::Trace),
        "DEBUG" => Some(LogLevel::Debug),
        "INFO" => Some(LogLevel::Info),
        "WARN" | "WARNING" => Some(LogLevel::Warn),
        "ERROR" => Some(LogLevel::Error),
        "FATAL" => Some(LogLevel::Fatal),
        _ => None,
    }
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| format!("unix-ms:{}", unix_millis(SystemTime::now())))
}

fn unix_seconds(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
        let unique = unix_millis(SystemTime::now());
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
    fn stdio_is_bounded_without_hiding_original_size() {
        let root = scratch("bounded");
        let mut options = LocalJournalOptions::at_root(&root, "bounded-app");
        options.max_stdio_line_bytes = 4;
        let journal = LocalJournal::open(options).expect("open");
        journal
            .write_stdio_line("worker", None, StdioStream::Stdout, b"abcdefgh")
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
            serde_json::from_str(fs::read_to_string(path).expect("contents").trim())
                .expect("json");
        assert_eq!(value["message"], "abcd");
        assert_eq!(value["lineBytes"], 8);
        assert_eq!(value["truncated"], true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prune_removes_only_complete_expired_segments() {
        let root = scratch("prune");
        let app = root.join("app");
        let process = app.join("111-222");
        ensure_private_directory(&process).expect("dirs");
        let now = UNIX_EPOCH + Duration::from_secs(10_000);
        let old = process.join("events-100.ndjson");
        let recent = process.join("events-9000.ndjson");
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
