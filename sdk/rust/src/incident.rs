//! Deterministic, bounded incident extraction from the private local process journal.
//!
//! This scanner does no network I/O and invokes no model. It is intended to be the cheap
//! front-end for a remediation loop: scan recent segments, collapse repeated failures, and wake
//! an AI agent only when the resulting bundle contains incidents.

use crate::{LogLevel, LoggerError, DEFAULT_LOCAL_LOG_SEGMENT_DURATION};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub const DEFAULT_INCIDENT_LOOKBACK: Duration = Duration::from_secs(20 * 60);
pub const DEFAULT_INCIDENT_MAX_SAMPLES: usize = 32;
pub const DEFAULT_INCIDENT_MAX_BYTES: usize = 24 * 1024;
pub const DEFAULT_INCIDENT_MESSAGE_BYTES: usize = 2 * 1024;

#[derive(Clone, Debug)]
pub struct IncidentScanOptions {
    pub root: PathBuf,
    pub app_name: String,
    pub lookback: Duration,
    pub max_samples: usize,
    pub max_output_bytes: usize,
    pub max_message_bytes: usize,
    pub include_messages: bool,
}

impl IncidentScanOptions {
    pub fn for_app(app_name: impl Into<String>) -> Result<Self, LoggerError> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                LoggerError("HOME/USERPROFILE is unavailable for incident scanning".into())
            })?;
        Ok(Self {
            root: PathBuf::from(home).join("tmp").join("logs"),
            app_name: app_name.into(),
            lookback: DEFAULT_INCIDENT_LOOKBACK,
            max_samples: DEFAULT_INCIDENT_MAX_SAMPLES,
            max_output_bytes: DEFAULT_INCIDENT_MAX_BYTES,
            max_message_bytes: DEFAULT_INCIDENT_MESSAGE_BYTES,
            include_messages: false,
        })
    }

    pub fn at_root(root: impl Into<PathBuf>, app_name: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            app_name: app_name.into(),
            lookback: DEFAULT_INCIDENT_LOOKBACK,
            max_samples: DEFAULT_INCIDENT_MAX_SAMPLES,
            max_output_bytes: DEFAULT_INCIDENT_MAX_BYTES,
            max_message_bytes: DEFAULT_INCIDENT_MESSAGE_BYTES,
            include_messages: false,
        }
    }

    fn validate(&self) -> Result<(), LoggerError> {
        validate_component(&self.app_name)?;
        if self.lookback.is_zero() {
            return Err(LoggerError("incident lookback must be non-zero".into()));
        }
        if self.max_samples == 0 {
            return Err(LoggerError("incident max_samples must be non-zero".into()));
        }
        if self.max_output_bytes < 1024 {
            return Err(LoggerError(
                "incident max_output_bytes must be at least 1024".into(),
            ));
        }
        if self.max_message_bytes == 0 || self.max_message_bytes > self.max_output_bytes {
            return Err(LoggerError(
                "incident max_message_bytes must be non-zero and fit inside max_output_bytes"
                    .into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentSample {
    pub fingerprint: String,
    pub level: LogLevel,
    pub schema: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    pub first_timestamp: String,
    pub last_timestamp: String,
    pub repeat_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub message_truncated: bool,
    pub journal_file: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentBundle {
    pub schema: String,
    pub app_name: String,
    pub scanned_at: String,
    pub lookback_seconds: u64,
    pub scanned_records: u64,
    pub matching_records: u64,
    pub unique_incidents: u64,
    pub omitted_incidents: u64,
    pub output_truncated: bool,
    pub samples: Vec<IncidentSample>,
}

impl IncidentBundle {
    #[must_use]
    pub fn has_incidents(&self) -> bool {
        self.matching_records > 0
    }
}

#[derive(Clone, Debug)]
struct Candidate {
    fingerprint: String,
    level: LogLevel,
    schema: String,
    source_name: Option<String>,
    stream: Option<String>,
    timestamp: String,
    message: String,
    message_truncated: bool,
    journal_file: String,
}

#[derive(Debug)]
struct Aggregate {
    sample: IncidentSample,
}

pub fn scan_local_incidents(options: &IncidentScanOptions) -> Result<IncidentBundle, LoggerError> {
    options.validate()?;
    let now = SystemTime::now();
    let now_secs = unix_seconds(now);
    let cutoff = now_secs.saturating_sub(options.lookback.as_secs());
    let app_dir = options.root.join(&options.app_name);
    let mut files = recent_segment_files(&app_dir, cutoff)?;
    files.sort();

    let mut scanned_records = 0_u64;
    let mut matching_records = 0_u64;
    let mut by_fingerprint = BTreeMap::<String, Aggregate>::new();

    for path in files {
        let contents = match fs::read(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(LoggerError(format!(
                    "could not read incident journal {}: {error}",
                    path.display()
                )))
            }
        };
        for raw in contents
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
        {
            scanned_records = scanned_records.saturating_add(1);
            let Some(candidate) = incident_candidate(raw, &path, options.max_message_bytes) else {
                continue;
            };
            matching_records = matching_records.saturating_add(1);
            match by_fingerprint.get_mut(&candidate.fingerprint) {
                Some(existing) => {
                    existing.sample.repeat_count = existing.sample.repeat_count.saturating_add(1);
                    existing.sample.last_timestamp = candidate.timestamp;
                    existing.sample.journal_file = candidate.journal_file;
                    if severity_rank(candidate.level) > severity_rank(existing.sample.level) {
                        existing.sample.level = candidate.level;
                    }
                }
                None => {
                    by_fingerprint.insert(
                        candidate.fingerprint.clone(),
                        Aggregate {
                            sample: IncidentSample {
                                fingerprint: candidate.fingerprint,
                                level: candidate.level,
                                schema: candidate.schema,
                                source_name: candidate.source_name,
                                stream: candidate.stream,
                                first_timestamp: candidate.timestamp.clone(),
                                last_timestamp: candidate.timestamp,
                                repeat_count: 1,
                                message: options.include_messages.then_some(candidate.message),
                                message_truncated: options.include_messages
                                    && candidate.message_truncated,
                                journal_file: candidate.journal_file,
                            },
                        },
                    );
                }
            }
        }
    }

    let unique_incidents = by_fingerprint.len() as u64;
    let mut samples = by_fingerprint
        .into_values()
        .map(|aggregate| aggregate.sample)
        .collect::<Vec<_>>();
    samples.sort_by(|left, right| {
        severity_rank(right.level)
            .cmp(&severity_rank(left.level))
            .then_with(|| right.repeat_count.cmp(&left.repeat_count))
            .then_with(|| right.last_timestamp.cmp(&left.last_timestamp))
            .then_with(|| left.fingerprint.cmp(&right.fingerprint))
    });

    let mut omitted_incidents = samples.len().saturating_sub(options.max_samples) as u64;
    samples.truncate(options.max_samples);

    let mut output_truncated = omitted_incidents > 0;
    loop {
        let trial = IncidentBundle {
            schema: "ores-incident-bundle/v1".into(),
            app_name: options.app_name.clone(),
            scanned_at: now_rfc3339(),
            lookback_seconds: options.lookback.as_secs(),
            scanned_records,
            matching_records,
            unique_incidents,
            omitted_incidents,
            output_truncated,
            samples: samples.clone(),
        };
        let encoded = serde_json::to_vec(&trial).map_err(LoggerError::from)?;
        if encoded.len() <= options.max_output_bytes || samples.is_empty() {
            return Ok(trial);
        }
        samples.pop();
        omitted_incidents = omitted_incidents.saturating_add(1);
        output_truncated = true;
    }
}

fn recent_segment_files(app_dir: &Path, cutoff: u64) -> Result<Vec<PathBuf>, LoggerError> {
    let entries = match fs::read_dir(app_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(LoggerError(format!(
                "could not enumerate incident app directory: {error}"
            )))
        }
    };

    let mut files = Vec::new();
    for process in entries {
        let process = process.map_err(|error| LoggerError(error.to_string()))?;
        let process_type = process
            .file_type()
            .map_err(|error| LoggerError(error.to_string()))?;
        if !process_type.is_dir() || process_type.is_symlink() {
            continue;
        }
        let children = match fs::read_dir(process.path()) {
            Ok(children) => children,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(LoggerError(error.to_string())),
        };
        for child in children {
            let child = child.map_err(|error| LoggerError(error.to_string()))?;
            let file_type = child
                .file_type()
                .map_err(|error| LoggerError(error.to_string()))?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let Some(segment_start) = parse_segment_start(&child.file_name()) else {
                continue;
            };
            // Segment timestamps are lower bounds. Retain the first segment whose end overlaps
            // the requested lookback, then let record severity decide whether it is interesting.
            if segment_start.saturating_add(DEFAULT_LOCAL_LOG_SEGMENT_DURATION.as_secs()) >= cutoff
            {
                files.push(child.path());
            }
        }
    }
    Ok(files)
}

fn incident_candidate(raw: &[u8], path: &Path, max_message_bytes: usize) -> Option<Candidate> {
    let value: Value = serde_json::from_slice(raw).ok()?;
    let schema = value.get("schema")?.as_str()?.to_owned();
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let stream = value
        .get("stream")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let level = parse_level(value.get("level").and_then(Value::as_str))?;
    let is_stderr = stream.as_deref() == Some("stderr");
    if !is_stderr && severity_rank(level) < severity_rank(LogLevel::Warn) {
        return None;
    }

    let source_name = value
        .get("sourceName")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("<no message>");
    let (message, message_truncated) = bounded_utf8(message, max_message_bytes);
    let fingerprint = incident_fingerprint(
        &schema,
        source_name.as_deref(),
        stream.as_deref(),
        level,
        &message,
    );
    Some(Candidate {
        fingerprint,
        level,
        schema,
        source_name,
        stream,
        timestamp,
        message,
        message_truncated,
        journal_file: path.to_string_lossy().into_owned(),
    })
}

fn parse_level(level: Option<&str>) -> Option<LogLevel> {
    match level?.to_ascii_uppercase().as_str() {
        "TRACE" => Some(LogLevel::Trace),
        "DEBUG" => Some(LogLevel::Debug),
        "INFO" => Some(LogLevel::Info),
        "WARN" | "WARNING" => Some(LogLevel::Warn),
        "ERROR" => Some(LogLevel::Error),
        "FATAL" => Some(LogLevel::Fatal),
        _ => None,
    }
}

fn severity_rank(level: LogLevel) -> u8 {
    match level {
        LogLevel::Trace => 0,
        LogLevel::Debug => 1,
        LogLevel::Info => 2,
        LogLevel::Warn => 3,
        LogLevel::Error => 4,
        LogLevel::Fatal => 5,
    }
}

fn bounded_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

fn incident_fingerprint(
    schema: &str,
    source_name: Option<&str>,
    stream: Option<&str>,
    level: LogLevel,
    message: &str,
) -> String {
    // Stable FNV-1a is sufficient here: this is a dedupe key, not a security primitive.
    let mut hash = 0xcbf29ce484222325_u64;
    for piece in [
        schema,
        source_name.unwrap_or(""),
        stream.unwrap_or(""),
        level_name(level),
        message,
    ] {
        for byte in piece.as_bytes().iter().copied().chain([0]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

fn level_name(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Trace => "TRACE",
        LogLevel::Debug => "DEBUG",
        LogLevel::Info => "INFO",
        LogLevel::Warn => "WARN",
        LogLevel::Error => "ERROR",
        LogLevel::Fatal => "FATAL",
    }
}

fn parse_segment_start(name: &std::ffi::OsStr) -> Option<u64> {
    let name = name.to_str()?;
    let stem = name.strip_suffix(".ndjson")?;
    let (_, value) = stem.rsplit_once('-')?;
    value.parse().ok()
}

fn validate_component(value: &str) -> Result<(), LoggerError> {
    if value.is_empty()
        || value.len() > 128
        || matches!(value, "." | "..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(LoggerError(
            "incident app name must be 1..=128 bytes of ASCII letters, digits, '.', '_' or '-'"
                .into(),
        ));
    }
    Ok(())
}

fn unix_seconds(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| format!("unix-seconds:{}", unix_seconds(SystemTime::now())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ores-incident-scan-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write_segment(root: &Path, app: &str, name: &str, lines: &[&str]) {
        let dir = root.join(app).join("123-456");
        fs::create_dir_all(&dir).expect("create process dir");
        fs::write(dir.join(name), lines.join("\n") + "\n").expect("write segment");
    }

    fn current_segment_name(kind: &str) -> String {
        let now = unix_seconds(SystemTime::now());
        let width = DEFAULT_LOCAL_LOG_SEGMENT_DURATION.as_secs();
        let start = (now / width) * width;
        format!("{kind}-{start}.ndjson")
    }

    #[test]
    fn selects_stderr_and_warn_plus_and_dedupes_repeats() {
        let root = scratch("select");
        let app = "app";
        let stdio = r#"{"schema":"ores-process-stdio/v1","timestamp":"2026-09-29T20:00:00Z","level":"WARN","appName":"app","sourceName":"nginx","stream":"stderr","message":"bind failed"}"#;
        let info = r#"{"schema":"ores-process-stdio/v1","timestamp":"2026-09-29T20:00:01Z","level":"INFO","appName":"app","sourceName":"nginx","stream":"stdout","message":"healthy"}"#;
        let warning = r#"{"schema":"next-loggers/v1","timestamp":"2026-09-29T20:00:02Z","level":"ERROR","appName":"app","name":"worker","message":"boom"}"#;
        write_segment(
            &root,
            app,
            &current_segment_name("stdio"),
            &[stdio, stdio, info],
        );
        write_segment(&root, app, &current_segment_name("events"), &[warning]);

        let bundle = scan_local_incidents(&IncidentScanOptions::at_root(&root, app)).expect("scan");
        assert_eq!(bundle.scanned_records, 4);
        assert_eq!(bundle.matching_records, 3);
        assert_eq!(bundle.unique_incidents, 2);
        assert_eq!(bundle.samples.len(), 2);
        assert_eq!(bundle.samples[0].level, LogLevel::Error);
        assert_eq!(bundle.samples[1].repeat_count, 2);
        assert!(bundle.has_incidents());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounds_messages_samples_and_serialized_output() {
        let root = scratch("bounded");
        let app = "app";
        let long = "x".repeat(4096);
        let mut lines = Vec::new();
        for index in 0..8 {
            lines.push(format!(
                "{{\"schema\":\"ores-process-stdio/v1\",\"timestamp\":\"2026-09-29T20:00:{index:02}Z\",\"level\":\"ERROR\",\"appName\":\"app\",\"sourceName\":\"worker-{index}\",\"stream\":\"stderr\",\"message\":\"{long}\"}}"
            ));
        }
        let refs = lines.iter().map(String::as_str).collect::<Vec<_>>();
        write_segment(&root, app, &current_segment_name("stdio"), &refs);

        let mut options = IncidentScanOptions::at_root(&root, app);
        options.max_samples = 3;
        options.max_message_bytes = 128;
        options.max_output_bytes = 4096;
        let bundle = scan_local_incidents(&options).expect("scan");
        let encoded = serde_json::to_vec(&bundle).expect("encode");
        assert!(bundle.output_truncated);
        assert!(bundle.omitted_incidents >= 5);
        assert!(bundle.samples.len() <= 3);
        assert!(bundle.samples.iter().all(|sample| sample.message.is_none()));
        options.include_messages = true;
        let with_messages = scan_local_incidents(&options).expect("scan with messages");
        assert!(with_messages.samples.iter().all(|sample| {
            sample
                .message
                .as_ref()
                .is_some_and(|message| message.len() <= 128)
        }));
        assert!(encoded.len() <= options.max_output_bytes);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_old_segments_and_invalid_app_components() {
        let root = scratch("old");
        let app = "app";
        write_segment(
            &root,
            app,
            "events-1.ndjson",
            &[r#"{"schema":"next-loggers/v1","timestamp":"old","level":"FATAL","message":"old"}"#],
        );
        let bundle = scan_local_incidents(&IncidentScanOptions::at_root(&root, app)).expect("scan");
        assert_eq!(bundle.scanned_records, 0);
        assert!(!bundle.has_incidents());
        assert!(scan_local_incidents(&IncidentScanOptions::at_root(&root, "../escape")).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
