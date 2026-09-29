//! Cursor-based read-only triage over the bounded desktop log spool.
//!
//! The scanner advances offsets across every record, including INFO/DEBUG, while
//! returning only stderr/WARN/ERROR/FATAL/explicit-triage records. Reads are
//! chunk-bounded so one malformed newline-free file cannot defeat scan budgets.
#![allow(clippy::needless_return)]

use crate::{default_local_log_root, json, LogLevel, LoggerError, Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const DEFAULT_TRIAGE_MAX_RECORDS: usize = 256;
pub const DEFAULT_TRIAGE_MAX_SCANNED_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_INVALID_LINE_CAPTURE_BYTES: usize = 4096;
pub const DEFAULT_TRIAGE_MAX_LINE_CHUNK_BYTES: usize = 256 * 1024;
pub const DEFAULT_TRIAGE_MAX_FILES: usize = 4096;
const MAX_APP_NAME_BYTES: usize = 128;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalTriageCursor {
    /// Relative-file -> next byte offset. Relative names keep cursors portable
    /// across a configurable local-log root while never granting path authority.
    #[serde(default)]
    pub offsets: BTreeMap<String, u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LocalTriageRecord {
    pub relative_path: String,
    pub byte_offset: u64,
    pub record: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LocalTriageBatch {
    pub cursor: LocalTriageCursor,
    pub records: Vec<LocalTriageRecord>,
    pub scanned_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTriageLimits {
    pub max_records: usize,
    pub max_scanned_bytes: u64,
}

impl Default for LocalTriageLimits {
    fn default() -> Self {
        return Self {
            max_records: DEFAULT_TRIAGE_MAX_RECORDS,
            max_scanned_bytes: DEFAULT_TRIAGE_MAX_SCANNED_BYTES,
        };
    }
}

pub fn scan_local_triage(
    app_name: &str,
    cursor: LocalTriageCursor,
) -> Result<LocalTriageBatch, LoggerError> {
    return scan_local_triage_with_root(
        app_name,
        default_local_log_root(),
        cursor,
        LocalTriageLimits::default(),
    );
}

pub fn scan_local_triage_with_root(
    app_name: &str,
    root: PathBuf,
    mut cursor: LocalTriageCursor,
    limits: LocalTriageLimits,
) -> Result<LocalTriageBatch, LoggerError> {
    validate_app_name(app_name)?;
    let app_directory = root.join(app_name);
    let metadata = match fs::symlink_metadata(&app_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            cursor.offsets.clear();
            return Ok(LocalTriageBatch {
                cursor,
                records: Vec::new(),
                scanned_bytes: 0,
                truncated: false,
            });
        }
        Err(error) => return Err(LoggerError(error.to_string())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(LoggerError(
            "local triage app path must be an unaliased directory".into(),
        ));
    }

    let (mut files, file_limit_hit) = collect_ndjson_files(&app_directory)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let current_files = files
        .iter()
        .map(|(relative, _)| relative.clone())
        .collect::<BTreeSet<_>>();
    cursor
        .offsets
        .retain(|relative, _| current_files.contains(relative));

    let mut records = Vec::new();
    let mut scanned_bytes = 0u64;
    let mut truncated = file_limit_hit;

    'files: for (relative_path, absolute_path) in files {
        let mut file = File::open(&absolute_path).map_err(|error| LoggerError(error.to_string()))?;
        let file_len = file
            .metadata()
            .map_err(|error| LoggerError(error.to_string()))?
            .len();
        let requested_offset = cursor.offsets.get(&relative_path).copied().unwrap_or(0);
        // A shorter file at the same relative path means it was replaced or
        // truncated. Reset rather than pinning to EOF and silently missing data.
        let start_offset = if requested_offset <= file_len {
            requested_offset
        } else {
            0
        };
        file.seek(SeekFrom::Start(start_offset))
            .map_err(|error| LoggerError(error.to_string()))?;

        let mut reader = BufReader::new(file);
        let mut offset = start_offset;

        loop {
            if scanned_bytes >= limits.max_scanned_bytes
                || records.len() >= limits.max_records
            {
                truncated = true;
                cursor.offsets.insert(relative_path.clone(), offset);
                break 'files;
            }

            let remaining_budget = limits.max_scanned_bytes.saturating_sub(scanned_bytes);
            let read_cap = usize::try_from(remaining_budget)
                .unwrap_or(usize::MAX)
                .min(DEFAULT_TRIAGE_MAX_LINE_CHUNK_BYTES)
                .max(1);
            let Some(chunk) = read_record_chunk(&mut reader, read_cap)? else {
                cursor.offsets.insert(relative_path.clone(), offset);
                break;
            };

            let line_start = offset;
            offset = offset.saturating_add(chunk.consumed_bytes as u64);
            scanned_bytes = scanned_bytes.saturating_add(chunk.consumed_bytes as u64);
            cursor.offsets.insert(relative_path.clone(), offset);

            if chunk.hit_cap_without_newline {
                truncated = true;
                records.push(LocalTriageRecord {
                    relative_path: relative_path.clone(),
                    byte_offset: line_start,
                    record: json!({
                        "event_name": "ores.local_log.oversized_chunk",
                        "severity_text": "ERROR",
                        "severity_number": 17,
                        "body": bounded_lossy(&chunk.bytes, MAX_INVALID_LINE_CAPTURE_BYTES),
                        "attributes": {
                            "ores.ai.triage": true,
                            "ores.local_log.chunk_bytes": chunk.consumed_bytes,
                            "ores.local_log.unterminated": true
                        }
                    }),
                });
                if records.len() >= limits.max_records {
                    break 'files;
                }
                continue;
            }

            match serde_json::from_slice::<Value>(&chunk.bytes) {
                Ok(value) => {
                    if is_triage_record(&value) {
                        records.push(LocalTriageRecord {
                            relative_path: relative_path.clone(),
                            byte_offset: line_start,
                            record: value,
                        });
                    }
                }
                Err(error) => {
                    let body = bounded_lossy(&chunk.bytes, MAX_INVALID_LINE_CAPTURE_BYTES);
                    records.push(LocalTriageRecord {
                        relative_path: relative_path.clone(),
                        byte_offset: line_start,
                        record: json!({
                            "event_name": "ores.local_log.invalid_json",
                            "severity_text": "ERROR",
                            "severity_number": 17,
                            "body": body,
                            "attributes": {
                                "ores.ai.triage": true,
                                "ores.local_log.parse_error": error.to_string()
                            }
                        }),
                    });
                }
            }
        }
    }

    return Ok(LocalTriageBatch {
        cursor,
        records,
        scanned_bytes,
        truncated,
    });
}

struct RecordChunk {
    bytes: Vec<u8>,
    consumed_bytes: usize,
    hit_cap_without_newline: bool,
}

fn read_record_chunk<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<RecordChunk>, LoggerError> {
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    let mut consumed_bytes = 0usize;
    let mut terminated = false;

    while consumed_bytes < max_bytes {
        let available = reader
            .fill_buf()
            .map_err(|error| LoggerError(error.to_string()))?;
        if available.is_empty() {
            break;
        }
        let remaining = max_bytes - consumed_bytes;
        let inspect_len = available.len().min(remaining);
        let inspected = &available[..inspect_len];
        if let Some(index) = inspected.iter().position(|byte| *byte == b'\n') {
            let take = index + 1;
            bytes.extend_from_slice(&inspected[..index]);
            reader.consume(take);
            consumed_bytes = consumed_bytes.saturating_add(take);
            terminated = true;
            break;
        }
        bytes.extend_from_slice(inspected);
        reader.consume(inspect_len);
        consumed_bytes = consumed_bytes.saturating_add(inspect_len);
    }

    if consumed_bytes == 0 {
        return Ok(None);
    }
    while matches!(bytes.last(), Some(b'\r')) {
        bytes.pop();
    }
    Ok(Some(RecordChunk {
        bytes,
        consumed_bytes,
        hit_cap_without_newline: !terminated && consumed_bytes >= max_bytes,
    }))
}

pub fn is_triage_record(value: &Value) -> bool {
    if explicit_triage(value) == Some(true) {
        return true;
    }

    if stdio_stream(value) == Some("stderr") {
        return true;
    }

    return severity_number(value)
        .map(|number| number >= 13)
        .unwrap_or(false);
}

fn explicit_triage(value: &Value) -> Option<bool> {
    return value
        .pointer("/attributes/ores.ai.triage")
        .or_else(|| value.pointer("/fields/ores.ai.triage"))
        .or_else(|| value.get("ores.ai.triage"))
        .and_then(Value::as_bool);
}

fn stdio_stream(value: &Value) -> Option<&str> {
    return value
        .pointer("/attributes/ores.stdio.stream")
        .or_else(|| value.pointer("/fields/ores.stdio.stream"))
        .or_else(|| value.get("ores.stdio.stream"))
        .or_else(|| value.get("stream"))
        .and_then(Value::as_str);
}

fn severity_number(value: &Value) -> Option<u64> {
    if let Some(number) = value
        .get("severity_number")
        .or_else(|| value.get("severityNumber"))
        .and_then(Value::as_u64)
    {
        return Some(number);
    }

    let level = value
        .get("level")
        .or_else(|| value.get("severity"))
        .or_else(|| value.get("severity_text"))
        .or_else(|| value.get("severityText"))
        .and_then(Value::as_str)?;
    return level_to_severity(level).map(|level| level.otel_severity_number() as u64);
}

fn level_to_severity(level: &str) -> Option<LogLevel> {
    return match level.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(LogLevel::Trace),
        "debug" => Some(LogLevel::Debug),
        "info" | "information" => Some(LogLevel::Info),
        "warn" | "warning" => Some(LogLevel::Warn),
        "error" | "err" => Some(LogLevel::Error),
        "fatal" | "critical" | "crit" | "panic" => Some(LogLevel::Fatal),
        _ => None,
    };
}

fn collect_ndjson_files(root: &Path) -> Result<(Vec<(String, PathBuf)>, bool), LoggerError> {
    let mut output = Vec::new();
    let mut limit_hit = false;
    let entries = fs::read_dir(root).map_err(|error| LoggerError(error.to_string()))?;

    'outer: for entry in entries {
        let entry = entry.map_err(|error| LoggerError(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| LoggerError(error.to_string()))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_file() {
            if is_ndjson(&path) {
                push_file(root, path, &mut output)?;
            }
            if output.len() >= DEFAULT_TRIAGE_MAX_FILES {
                limit_hit = true;
                break;
            }
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }

        let children = match fs::read_dir(&path) {
            Ok(children) => children,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(LoggerError(error.to_string())),
        };
        for child in children {
            let child = child.map_err(|error| LoggerError(error.to_string()))?;
            let child_type = child
                .file_type()
                .map_err(|error| LoggerError(error.to_string()))?;
            if child_type.is_symlink() || !child_type.is_file() {
                continue;
            }
            let child_path = child.path();
            if is_ndjson(&child_path) {
                push_file(root, child_path, &mut output)?;
            }
            if output.len() >= DEFAULT_TRIAGE_MAX_FILES {
                limit_hit = true;
                break 'outer;
            }
        }
    }

    Ok((output, limit_hit))
}

fn push_file(
    root: &Path,
    path: PathBuf,
    output: &mut Vec<(String, PathBuf)>,
) -> Result<(), LoggerError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| LoggerError(error.to_string()))?
        .to_string_lossy()
        .replace('\\', "/");
    output.push((relative, path));
    Ok(())
}

fn is_ndjson(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("ndjson")
}

fn bounded_lossy(bytes: &[u8], max_bytes: usize) -> String {
    let end = bytes.len().min(max_bytes);
    return String::from_utf8_lossy(&bytes[..end]).to_string();
}

fn validate_app_name(value: &str) -> Result<(), LoggerError> {
    if value.is_empty() || value.len() > MAX_APP_NAME_BYTES {
        return Err(LoggerError(format!(
            "app name must be between 1 and {MAX_APP_NAME_BYTES} bytes"
        )));
    }
    if matches!(value, "." | "..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(LoggerError(
            "app name may contain only ASCII letters, digits, '.', '_' and '-'".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        return std::env::temp_dir().join(format!(
            "ores-local-triage-{name}-{}-{nonce}",
            std::process::id()
        ));
    }

    fn write_lines(path: &Path, lines: &[Value]) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let mut file = File::create(path).expect("create");
        for line in lines {
            writeln!(file, "{}", serde_json::to_string(line).expect("json")).expect("write");
        }
    }

    #[test]
    fn cursor_advances_past_info_without_returning_it_again() {
        let root = unique_root("cursor");
        let path = root.join("demo").join("123").join("100.ndjson");
        write_lines(
            &path,
            &[
                json!({"severity_number": 9, "body": "healthy"}),
                json!({"severity_number": 17, "body": "boom"}),
            ],
        );

        let first = scan_local_triage_with_root(
            "demo",
            root.clone(),
            LocalTriageCursor::default(),
            LocalTriageLimits::default(),
        )
        .expect("first scan");
        assert_eq!(first.records.len(), 1);
        assert_eq!(first.records[0].record["body"], "boom");

        let second = scan_local_triage_with_root(
            "demo",
            root.clone(),
            first.cursor,
            LocalTriageLimits::default(),
        )
        .expect("second scan");
        assert!(second.records.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn top_level_stderr_is_triage_even_when_level_is_info() {
        assert!(is_triage_record(&json!({
            "level": "INFO",
            "stream": "stderr"
        })));
        assert!(is_triage_record(&json!({
            "severity_number": 9,
            "attributes": {"ores.stdio.stream": "stderr"}
        })));
    }

    #[test]
    fn oversized_newline_free_input_is_chunked_with_bounded_memory() {
        let root = unique_root("oversized");
        let path = root.join("demo").join("123").join("stdio-1-0.ndjson");
        fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        fs::write(&path, vec![b'x'; DEFAULT_TRIAGE_MAX_LINE_CHUNK_BYTES + 64]).expect("write");

        let batch = scan_local_triage_with_root(
            "demo",
            root.clone(),
            LocalTriageCursor::default(),
            LocalTriageLimits {
                max_records: 8,
                max_scanned_bytes: (DEFAULT_TRIAGE_MAX_LINE_CHUNK_BYTES + 64) as u64,
            },
        )
        .expect("scan");
        assert!(batch.truncated);
        assert!(!batch.records.is_empty());
        assert_eq!(
            batch.records[0].record["event_name"],
            "ores.local_log.oversized_chunk"
        );
        assert!(batch.records[0].record["body"].as_str().unwrap().len() <= MAX_INVALID_LINE_CAPTURE_BYTES);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_cursor_resets_when_file_shrinks() {
        let root = unique_root("shrink");
        let path = root.join("demo").join("123").join("events-1-0.ndjson");
        write_lines(&path, &[json!({"severity_number": 17, "body": "new"})]);
        let relative = "123/events-1-0.ndjson".to_string();
        let cursor = LocalTriageCursor {
            offsets: [(relative, 1_000_000)].into_iter().collect(),
        };
        let batch = scan_local_triage_with_root(
            "demo",
            root.clone(),
            cursor,
            LocalTriageLimits::default(),
        )
        .expect("scan");
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.records[0].record["body"], "new");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_aliased_app_names() {
        let root = unique_root("invalid-name");
        assert!(scan_local_triage_with_root(
            "../escape",
            root,
            LocalTriageCursor::default(),
            LocalTriageLimits::default(),
        )
        .is_err());
    }
}
