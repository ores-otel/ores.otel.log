//! Cursor-based read-only triage over the bounded desktop log spool.
//!
//! The scanner advances offsets across every line, including INFO/DEBUG, while
//! returning only stderr/WARN/ERROR/FATAL/explicit-triage records. This keeps
//! periodic repair agents from paying to reread healthy log history.
#![allow(clippy::needless_return)]

use crate::{default_desktop_local_log_root, json, LogLevel, LoggerError, Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub const DEFAULT_TRIAGE_MAX_RECORDS: usize = 256;
pub const DEFAULT_TRIAGE_MAX_SCANNED_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_INVALID_LINE_CAPTURE_BYTES: usize = 4096;

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
        default_desktop_local_log_root(),
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
    let app_name = sanitize_path_component(app_name);
    let app_directory = root.join(app_name);
    if !app_directory.exists() {
        cursor.offsets.clear();
        return Ok(LocalTriageBatch {
            cursor,
            records: Vec::new(),
            scanned_bytes: 0,
            truncated: false,
        });
    }

    let mut files = Vec::new();
    collect_ndjson_files(&app_directory, &app_directory, &mut files)?;
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
    let mut truncated = false;

    'files: for (relative_path, absolute_path) in files {
        let mut file = File::open(&absolute_path).map_err(|error| LoggerError(error.to_string()))?;
        let file_len = file
            .metadata()
            .map_err(|error| LoggerError(error.to_string()))?
            .len();
        let requested_offset = cursor.offsets.get(&relative_path).copied().unwrap_or(0);
        let start_offset = requested_offset.min(file_len);
        file.seek(SeekFrom::Start(start_offset))
            .map_err(|error| LoggerError(error.to_string()))?;

        let mut reader = BufReader::new(file);
        let mut offset = start_offset;
        let mut line = Vec::new();

        loop {
            if scanned_bytes >= limits.max_scanned_bytes
                || records.len() >= limits.max_records
            {
                truncated = true;
                cursor.offsets.insert(relative_path.clone(), offset);
                break 'files;
            }

            line.clear();
            let bytes_read = reader
                .read_until(b'\n', &mut line)
                .map_err(|error| LoggerError(error.to_string()))?;
            if bytes_read == 0 {
                cursor.offsets.insert(relative_path.clone(), offset);
                break;
            }

            let line_start = offset;
            offset = offset.saturating_add(bytes_read as u64);
            scanned_bytes = scanned_bytes.saturating_add(bytes_read as u64);
            // Advance even for healthy records. This is the core token-cost
            // invariant: a future scan never rereads INFO merely because it was
            // filtered out of the returned batch.
            cursor.offsets.insert(relative_path.clone(), offset);

            let parsed = serde_json::from_slice::<Value>(&line);
            match parsed {
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
                    let body = bounded_lossy(&line, MAX_INVALID_LINE_CAPTURE_BYTES);
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

fn collect_ndjson_files(
    root: &Path,
    directory: &Path,
    output: &mut Vec<(String, PathBuf)>,
) -> Result<(), LoggerError> {
    for entry in fs::read_dir(directory).map_err(|error| LoggerError(error.to_string()))? {
        let entry = entry.map_err(|error| LoggerError(error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| LoggerError(error.to_string()))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_ndjson_files(root, &path, output)?;
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|value| value.to_str()) != Some("ndjson") {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| LoggerError(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        output.push((relative, path));
    }
    return Ok(());
}

fn bounded_lossy(bytes: &[u8], max_bytes: usize) -> String {
    let end = bytes.len().min(max_bytes);
    return String::from_utf8_lossy(&bytes[..end]).to_string();
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
    fn stderr_attribute_is_triage_even_when_level_is_info() {
        assert!(is_triage_record(&json!({
            "severity_number": 9,
            "attributes": {"ores.stdio.stream": "stderr"}
        })));
    }

    #[test]
    fn symlink_files_are_not_scanned() {
        let root = unique_root("symlink");
        let app = root.join("demo");
        fs::create_dir_all(&app).expect("mkdir");
        let outside = root.join("outside.ndjson");
        write_lines(&outside, &[json!({"severity_number": 17})]);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, app.join("linked.ndjson")).expect("symlink");
            let batch = scan_local_triage_with_root(
                "demo",
                root.clone(),
                LocalTriageCursor::default(),
                LocalTriageLimits::default(),
            )
            .expect("scan");
            assert!(batch.records.is_empty());
        }
        let _ = fs::remove_dir_all(root);
    }
}
