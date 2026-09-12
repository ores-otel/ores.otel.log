//! `.ores-otel.toml` loader for the shared `ores-otel-config.v1` contract.
//!
//! The pipeline mirrors the TypeScript loader (`src/ores-otel-config.ts`):
//!
//! 1. [`parse_toml`] — a strict, fail-closed reader for the TOML subset the
//!    repository uses (equivalent to `src/cli/toml.ts`).
//! 2. [`parse_ores_otel_toml`] — strict key sets, value types, ranges, and the
//!    runtime-only semantic checks the JSON Schema cannot express.
//! 3. [`resolve_ores_otel_config`] — `defaults < common < selected role <
//!    process environment < flags-2-env overrides < explicit overrides`.
//! 4. [`load_ores_otel_config`] — file discovery plus the steps above.
//!
//! Every stage builds and returns new values; nothing is filled through an
//! out-parameter.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::PathBuf;

pub const ORES_OTEL_CONFIG_BASENAME: &str = ".ores-otel.toml";
pub const ORES_OTEL_CONFIG_VERSION: u8 = 1;

pub const ENV_ROLE: &str = "ORES_OTEL_ROLE";
pub const ENV_CONFIG_DIR: &str = "ORES_OTEL_CONFIG_DIR";
pub const ENV_CONFIG_FILE: &str = "ORES_OTEL_CONFIG_FILE";
pub const ENV_ENABLED: &str = "ORES_OTEL_ENABLED";
pub const ENV_SERVICE_NAME: &str = "ORES_OTEL_SERVICE_NAME";
pub const ENV_ENVIRONMENT: &str = "ORES_OTEL_ENVIRONMENT";
pub const ENV_LOGGING_ENABLED: &str = "ORES_OTEL_LOGGING_ENABLED";
pub const ENV_LOG_LEVEL: &str = "ORES_OTEL_LOG_LEVEL";
pub const ENV_LOG_CONSOLE: &str = "ORES_OTEL_LOG_CONSOLE";
pub const ENV_LOG_AUTO_SEND: &str = "ORES_OTEL_LOG_AUTO_SEND";
pub const ENV_TRACING_ENABLED: &str = "ORES_OTEL_TRACING_ENABLED";
pub const ENV_TRACE_SAMPLE_RATIO: &str = "ORES_OTEL_TRACE_SAMPLE_RATIO";
pub const ENV_PROPAGATORS: &str = "ORES_OTEL_PROPAGATORS";
pub const ENV_METRICS_ENABLED: &str = "ORES_OTEL_METRICS_ENABLED";
pub const ENV_METRICS_PROCESS_ENABLED: &str = "ORES_OTEL_METRICS_PROCESS_ENABLED";
pub const ENV_METRICS_SAMPLE_INTERVAL_MS: &str = "ORES_OTEL_METRICS_SAMPLE_INTERVAL_MS";
pub const ENV_METRICS_FILESYSTEM_ENABLED: &str = "ORES_OTEL_METRICS_FILESYSTEM_ENABLED";
pub const ENV_METRICS_FILESYSTEM_PATHS: &str = "ORES_OTEL_METRICS_FILESYSTEM_PATHS";
pub const ENV_METRICS_MIN_FREE_BYTES: &str = "ORES_OTEL_METRICS_MIN_FREE_BYTES";
pub const ENV_METRICS_MIN_FREE_RATIO: &str = "ORES_OTEL_METRICS_MIN_FREE_RATIO";
pub const ENV_METRICS_LATENCY_ENABLED: &str = "ORES_OTEL_METRICS_LATENCY_ENABLED";
pub const ENV_METRICS_HISTOGRAM_BOUNDARIES_MS: &str = "ORES_OTEL_METRICS_HISTOGRAM_BOUNDARIES_MS";
pub const ENV_METRICS_RUNTIME_ENABLED: &str = "ORES_OTEL_METRICS_RUNTIME_ENABLED";
pub const ENV_METRICS_SATURATION_ENABLED: &str = "ORES_OTEL_METRICS_SATURATION_ENABLED";
pub const ENV_METRICS_MEMORY_RATIO_WARNING: &str = "ORES_OTEL_METRICS_MEMORY_RATIO_WARNING";
pub const ENV_EXPORTER_PROTOCOL: &str = "ORES_OTEL_EXPORTER_PROTOCOL";
pub const ENV_EXPORTER_ENDPOINT_ENV: &str = "ORES_OTEL_EXPORTER_ENDPOINT_ENV";

/// Every environment variable the loader honours; mirrors
/// `contracts/ores-otel.cli-flags.toml` exactly (a test enforces the parity).
pub const ORES_OTEL_ENV_VARS: &[&str] = &[
    ENV_ROLE,
    ENV_CONFIG_DIR,
    ENV_CONFIG_FILE,
    ENV_ENABLED,
    ENV_SERVICE_NAME,
    ENV_ENVIRONMENT,
    ENV_LOGGING_ENABLED,
    ENV_LOG_LEVEL,
    ENV_LOG_CONSOLE,
    ENV_LOG_AUTO_SEND,
    ENV_TRACING_ENABLED,
    ENV_TRACE_SAMPLE_RATIO,
    ENV_PROPAGATORS,
    ENV_METRICS_ENABLED,
    ENV_METRICS_PROCESS_ENABLED,
    ENV_METRICS_SAMPLE_INTERVAL_MS,
    ENV_METRICS_FILESYSTEM_ENABLED,
    ENV_METRICS_FILESYSTEM_PATHS,
    ENV_METRICS_MIN_FREE_BYTES,
    ENV_METRICS_MIN_FREE_RATIO,
    ENV_METRICS_LATENCY_ENABLED,
    ENV_METRICS_HISTOGRAM_BOUNDARIES_MS,
    ENV_METRICS_RUNTIME_ENABLED,
    ENV_METRICS_SATURATION_ENABLED,
    ENV_METRICS_MEMORY_RATIO_WARNING,
    ENV_EXPORTER_PROTOCOL,
    ENV_EXPORTER_ENDPOINT_ENV,
];

const SAMPLE_INTERVAL_MIN_MS: u64 = 100;
const SAMPLE_INTERVAL_MAX_MS: u64 = 3_600_000;
const MAX_ARRAY_ENTRIES: usize = 32;
const MAX_PROPAGATORS: usize = 8;
const DEFAULT_SAMPLE_INTERVAL_MS: u64 = 10_000;
const DEFAULT_HISTOGRAM_BOUNDARIES_MS: [f64; 12] = [
    1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0,
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum OresOtelConfigError {
    /// The input is not in the supported TOML subset.
    Toml { line: usize, message: String },
    /// The TOML is well formed but violates the v1 contract.
    Invalid(String),
    /// An `ORES_OTEL_*` environment or flags-2-env value is malformed.
    Environment(String),
    /// Role selection failed (ambiguous or mismatched role).
    Role(String),
    /// Reading the configuration file failed for a reason other than absence.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for OresOtelConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Toml { line, message } => write!(formatter, "{message} (line {line})"),
            Self::Invalid(message) | Self::Environment(message) | Self::Role(message) => {
                formatter.write_str(message)
            }
            Self::Io { path, source } => {
                write!(formatter, "failed to read {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for OresOtelConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Toml { .. } | Self::Invalid(_) | Self::Environment(_) | Self::Role(_) => None,
        }
    }
}

fn toml_error(line: usize, message: impl Into<String>) -> OresOtelConfigError {
    OresOtelConfigError::Toml {
        line,
        message: message.into(),
    }
}

fn invalid(message: impl Into<String>) -> OresOtelConfigError {
    OresOtelConfigError::Invalid(message.into())
}

fn env_error(message: impl Into<String>) -> OresOtelConfigError {
    OresOtelConfigError::Environment(message.into())
}

// ---------------------------------------------------------------------------
// Strict TOML-subset reader
// ---------------------------------------------------------------------------

/// A value produced by [`parse_toml`]. Arrays are homogeneous: all strings or
/// all numbers (integers and floats may mix, as in TypeScript's `number[]`).
#[derive(Clone, Debug, PartialEq)]
pub enum TomlValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Array(Vec<TomlValue>),
    Table(TomlTable),
}

pub type TomlTable = BTreeMap<String, TomlValue>;

impl TomlValue {
    fn as_number(&self) -> Option<f64> {
        match self {
            Self::Integer(value) => Some(*value as f64),
            Self::Float(value) => Some(*value),
            _ => None,
        }
    }
}

/// Each char with its byte index and whether it sits inside a basic string.
/// Quotes preceded by an odd number of backslashes do not toggle the state,
/// exactly as `src/cli/toml.ts` counts them.
fn scan_string_state(text: &str) -> Vec<(usize, char, bool)> {
    text.char_indices()
        .scan((false, 0_usize), |state, (index, ch)| {
            let (inside, backslashes) = *state;
            let toggles = ch == '"' && backslashes % 2 == 0;
            *state = (
                if toggles { !inside } else { inside },
                if ch == '\\' { backslashes + 1 } else { 0 },
            );
            Some((index, ch, inside))
        })
        .collect()
}

fn find_outside_strings(text: &str, target: char) -> Option<usize> {
    scan_string_state(text)
        .into_iter()
        .find(|(_, ch, inside)| *ch == target && !inside)
        .map(|(index, _, _)| index)
}

fn split_outside_strings(text: &str, separator: char) -> Vec<&str> {
    let cuts = scan_string_state(text)
        .into_iter()
        .filter(|(_, ch, inside)| *ch == separator && !inside)
        .map(|(index, _, _)| index)
        .collect::<Vec<_>>();
    let starts = std::iter::once(0).chain(cuts.iter().map(|cut| cut + separator.len_utf8()));
    let ends = cuts.iter().copied().chain(std::iter::once(text.len()));
    starts
        .zip(ends)
        .map(|(start, end)| &text[start..end])
        .collect()
}

fn strip_comment(line: &str) -> &str {
    find_outside_strings(line, '#').map_or(line, |index| &line[..index])
}

fn bracket_depth(text: &str) -> i64 {
    scan_string_state(text)
        .into_iter()
        .filter(|(_, _, inside)| !inside)
        .map(|(_, ch, _)| match ch {
            '[' => 1,
            ']' => -1,
            _ => 0,
        })
        .sum()
}

fn is_bare_key(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn with_char(text: String, ch: char) -> String {
    let mut text = text;
    text.push(ch);
    text
}

fn parse_basic_string(raw: &str, line: usize) -> Result<String, OresOtelConfigError> {
    let body = raw
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .ok_or_else(|| toml_error(line, format!("expected a double-quoted string, got {raw}")))?;
    let (text, escaping) = body.chars().try_fold(
        (String::with_capacity(body.len()), false),
        |(text, escaping), ch| match (escaping, ch) {
            (true, 'n') => Ok((with_char(text, '\n'), false)),
            (true, 't') => Ok((with_char(text, '\t'), false)),
            (true, 'r') => Ok((with_char(text, '\r'), false)),
            (true, '"') => Ok((with_char(text, '"'), false)),
            (true, '\\') => Ok((with_char(text, '\\'), false)),
            (true, other) => Err(toml_error(line, format!("unsupported escape \\{other}"))),
            (false, '\\') => Ok((text, true)),
            (false, '"') => Err(toml_error(line, "unescaped quote inside a string")),
            (false, other) => Ok((with_char(text, other), false)),
        },
    )?;
    if escaping {
        return Err(toml_error(line, "unsupported escape \\"));
    }
    Ok(text)
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn unsigned(text: &str) -> &str {
    text.strip_prefix(['+', '-']).unwrap_or(text)
}

/// `^[+-]?\d+$`
fn is_toml_integer(text: &str) -> bool {
    is_digits(unsigned(text))
}

/// `^[+-]?(\d+\.\d+|\d+[eE][+-]?\d+|\d+\.\d+[eE][+-]?\d+)$`
fn is_toml_float(text: &str) -> bool {
    let body = unsigned(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(index) => (&body[..index], Some(&body[index + 1..])),
        None => (body, None),
    };
    let exponent_ok = exponent.is_none_or(|value| is_digits(unsigned(value)));
    let decimal = mantissa
        .split_once('.')
        .is_some_and(|(whole, fraction)| is_digits(whole) && is_digits(fraction));
    exponent_ok && (decimal || (exponent.is_some() && is_digits(mantissa)))
}

fn parse_number(text: &str, line: usize) -> Result<Option<TomlValue>, OresOtelConfigError> {
    if is_toml_integer(text) {
        return text
            .parse::<i64>()
            .map(|value| Some(TomlValue::Integer(value)))
            .map_err(|_| toml_error(line, format!("integer {text} is out of range")));
    }
    if is_toml_float(text) {
        return text
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(|value| Some(TomlValue::Float(value)))
            .ok_or_else(|| toml_error(line, format!("float {text} is out of range")));
    }
    Ok(None)
}

fn parse_array_item(item: &str, line: usize) -> Result<TomlValue, OresOtelConfigError> {
    if item.starts_with('"') {
        return parse_basic_string(item, line).map(TomlValue::String);
    }
    parse_number(item, line)?.ok_or_else(|| {
        toml_error(
            line,
            format!("arrays may contain only strings or numbers, got {item}"),
        )
    })
}

fn parse_array(text: &str, line: usize) -> Result<TomlValue, OresOtelConfigError> {
    let body = text[1..text.len() - 1].trim();
    if body.is_empty() {
        return Ok(TomlValue::Array(Vec::new()));
    }
    let raw_items = split_outside_strings(body, ',');
    let last = raw_items.len() - 1;
    let items = raw_items
        .into_iter()
        .enumerate()
        // A trailing comma is allowed; an empty item anywhere else is not.
        .filter(|(index, item)| !(*index == last && item.trim().is_empty()))
        .map(|(_, item)| parse_array_item(item.trim(), line))
        .collect::<Result<Vec<_>, _>>()?;
    let all_strings = items
        .iter()
        .all(|item| matches!(item, TomlValue::String(_)));
    let all_numbers = items.iter().all(|item| item.as_number().is_some());
    if !all_strings && !all_numbers {
        return Err(toml_error(line, "arrays must not mix strings and numbers"));
    }
    Ok(TomlValue::Array(items))
}

fn parse_value(raw: &str, line: usize) -> Result<TomlValue, OresOtelConfigError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(toml_error(line, "missing value"));
    }
    if text.starts_with('"') {
        return parse_basic_string(text, line).map(TomlValue::String);
    }
    if text.starts_with('[') {
        if text.len() < 2 || !text.ends_with(']') {
            return Err(toml_error(line, "unterminated array"));
        }
        return parse_array(text, line);
    }
    if text.starts_with('{') {
        return Err(toml_error(line, "inline tables are not supported"));
    }
    match text {
        "true" => Ok(TomlValue::Boolean(true)),
        "false" => Ok(TomlValue::Boolean(false)),
        _ => parse_number(text, line)?
            .ok_or_else(|| toml_error(line, format!("unsupported value {text}"))),
    }
}

fn parse_key(raw: &str, line: usize) -> Result<String, OresOtelConfigError> {
    if raw.starts_with('"') {
        return parse_basic_string(raw, line);
    }
    if !is_bare_key(raw) {
        return Err(toml_error(line, format!("invalid key \"{raw}\"")));
    }
    Ok(raw.to_owned())
}

fn split_table_path(header: &str, line: usize) -> Result<Vec<String>, OresOtelConfigError> {
    split_outside_strings(header, '.')
        .into_iter()
        .map(|part| {
            let part = part.trim();
            if part.starts_with('"') {
                return parse_basic_string(part, line);
            }
            if !is_bare_key(part) {
                return Err(toml_error(line, format!("invalid key segment \"{part}\"")));
            }
            Ok(part.to_owned())
        })
        .collect()
}

fn table_at<'a>(root: &'a TomlTable, path: &[String]) -> Option<&'a TomlTable> {
    path.iter()
        .try_fold(root, |table, segment| match table.get(segment) {
            Some(TomlValue::Table(child)) => Some(child),
            _ => None,
        })
}

/// Returns `table` with every segment of `path` present as a table.
fn ensure_table(
    table: TomlTable,
    path: &[String],
    line: usize,
) -> Result<TomlTable, OresOtelConfigError> {
    let Some((head, rest)) = path.split_first() else {
        return Ok(table);
    };
    let mut table = table;
    let child = match table.remove(head) {
        None => TomlTable::new(),
        Some(TomlValue::Table(child)) => child,
        Some(_) => {
            return Err(toml_error(
                line,
                format!("\"{head}\" is already a value, not a table"),
            ))
        }
    };
    table.insert(
        head.clone(),
        TomlValue::Table(ensure_table(child, rest, line)?),
    );
    Ok(table)
}

/// Returns `table` with `key = value` inserted into the table at `path`.
fn insert_value(
    table: TomlTable,
    path: &[String],
    key: String,
    value: TomlValue,
    line: usize,
) -> Result<TomlTable, OresOtelConfigError> {
    let mut table = table;
    match path.split_first() {
        None => {
            if table.contains_key(&key) {
                return Err(toml_error(line, format!("duplicate key \"{key}\"")));
            }
            table.insert(key, value);
            Ok(table)
        }
        Some((head, rest)) => {
            let Some(TomlValue::Table(child)) = table.remove(head) else {
                return Err(toml_error(line, format!("\"{head}\" is not a table")));
            };
            let child = insert_value(child, rest, key, value, line)?;
            table.insert(head.clone(), TomlValue::Table(child));
            Ok(table)
        }
    }
}

#[derive(Debug)]
struct PendingArray {
    key: String,
    raw: String,
    depth: i64,
    line: usize,
}

#[derive(Debug, Default)]
struct ReaderState {
    root: TomlTable,
    current: Vec<String>,
    pending: Option<PendingArray>,
    /// Paths of explicit `[table]` headers. Each may appear once; a table
    /// created implicitly by `[a.b]` may still be defined once as `[a]`.
    defined: BTreeSet<Vec<String>>,
}

fn read_line(
    state: ReaderState,
    line_number: usize,
    line: &str,
) -> Result<ReaderState, OresOtelConfigError> {
    let ReaderState {
        root,
        current,
        pending,
        defined,
    } = state;
    let content = strip_comment(line).trim();

    if let Some(pending) = pending {
        // Multi-line arrays keep consuming lines until the brackets balance;
        // comments are already stripped per line.
        let raw = format!("{} {content}", pending.raw);
        let depth = pending.depth + bracket_depth(content);
        if depth > 0 {
            return Ok(ReaderState {
                root,
                current,
                pending: Some(PendingArray {
                    raw,
                    depth,
                    ..pending
                }),
                defined,
            });
        }
        let value = parse_value(&raw, pending.line)?;
        let root = insert_value(root, &current, pending.key, value, pending.line)?;
        return Ok(ReaderState {
            root,
            current,
            pending: None,
            defined,
        });
    }

    if content.is_empty() {
        return Ok(ReaderState {
            root,
            current,
            pending: None,
            defined,
        });
    }
    if content.starts_with("[[") {
        return Err(toml_error(
            line_number,
            "arrays of tables are not supported",
        ));
    }
    if let Some(header) = content.strip_prefix('[') {
        let inner = header
            .strip_suffix(']')
            .ok_or_else(|| toml_error(line_number, "unterminated table header"))?;
        let path = split_table_path(inner.trim(), line_number)?;
        if defined.contains(&path) {
            return Err(toml_error(
                line_number,
                format!("table [{}] is defined more than once", path.join(".")),
            ));
        }
        let root = ensure_table(root, &path, line_number)?;
        let mut defined = defined;
        defined.insert(path.clone());
        return Ok(ReaderState {
            root,
            current: path,
            pending: None,
            defined,
        });
    }

    let equals = find_outside_strings(content, '=').ok_or_else(|| {
        toml_error(
            line_number,
            format!("expected key = value, got \"{content}\""),
        )
    })?;
    let key = parse_key(content[..equals].trim(), line_number)?;
    if table_at(&root, &current).is_some_and(|table| table.contains_key(&key)) {
        return Err(toml_error(line_number, format!("duplicate key \"{key}\"")));
    }
    let raw = content[equals + 1..].trim();
    let depth = bracket_depth(raw);
    if raw.starts_with('[') && depth > 0 {
        return Ok(ReaderState {
            root,
            current,
            pending: Some(PendingArray {
                key,
                raw: raw.to_owned(),
                depth,
                line: line_number,
            }),
            defined,
        });
    }
    let value = parse_value(raw, line_number)?;
    let root = insert_value(root, &current, key, value, line_number)?;
    Ok(ReaderState {
        root,
        current,
        pending: None,
        defined,
    })
}

/// Strictly parses the supported TOML subset: tables (including dotted
/// headers), bare/quoted keys, basic strings with `\n \t \r \" \\` escapes,
/// integers, floats, booleans, comments, and homogeneous single- or
/// multi-line arrays of strings or numbers. Inline tables, arrays of tables,
/// duplicate keys, table headers defined more than once, mixed-type arrays,
/// and anything else fail.
pub fn parse_toml(input: &str) -> Result<TomlTable, OresOtelConfigError> {
    let finished = input
        .split('\n')
        .enumerate()
        .try_fold(ReaderState::default(), |state, (index, line)| {
            read_line(state, index + 1, line.strip_suffix('\r').unwrap_or(line))
        })?;
    match finished.pending {
        Some(pending) => Err(toml_error(pending.line, "unterminated array")),
        None => Ok(finished.root),
    }
}

// ---------------------------------------------------------------------------
// Contract enums
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OresOtelRole {
    Client,
    Server,
    Shared,
}

/// A role a process may request; `shared` is only ever inferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRole {
    Client,
    Server,
}

impl RuntimeRole {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "client" => Some(Self::Client),
            "server" => Some(Self::Server),
            _ => None,
        }
    }
}

impl From<RuntimeRole> for OresOtelRole {
    fn from(role: RuntimeRole) -> Self {
        match role {
            RuntimeRole::Client => Self::Client,
            RuntimeRole::Server => Self::Server,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OresOtelLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl OresOtelLogLevel {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "trace" => Some(Self::Trace),
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            "fatal" => Some(Self::Fatal),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OresOtelExporterProtocol {
    None,
    OtlpHttp,
    OtlpGrpc,
}

impl OresOtelExporterProtocol {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "otlp_http" => Some(Self::OtlpHttp),
            "otlp_grpc" => Some(Self::OtlpGrpc),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OresOtelPropagator {
    Tracecontext,
    Baggage,
}

impl OresOtelPropagator {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "tracecontext" => Some(Self::Tracecontext),
            "baggage" => Some(Self::Baggage),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Parsed file shape (snake_case contract object)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileLoggingConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<OresOtelLogLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_send: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileTracingConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub propagators: Option<Vec<OresOtelPropagator>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileProcessMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rss_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub virtual_memory_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heap_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_seconds: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_count: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_file_descriptors: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileFilesystemMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_ratio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inode_free_ratio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_free_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_free_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_inode_free_ratio: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileLatencyMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_duration_ms: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_duration_ms: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_wait_ms: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_loop_lag_ms: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub histogram_boundaries_ms: Option<Vec<f64>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileRuntimeMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gc_pause_ms: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gc_heap_bytes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_loop_utilization: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler_queue_depth: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileSaturationMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_ratio_warning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_ratio_warning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_free_ratio_warning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_depth_warning: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileMetricsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process: Option<FileProcessMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<FileFilesystemMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<FileLatencyMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<FileRuntimeMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saturation: Option<FileSaturationMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exemplars: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_metrics: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_graphs: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FileExporterConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<OresOtelExporterProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_env: Option<String>,
}

/// One `[common]`, `[client]`, or `[server]` layer. The same shape is used for
/// explicit runtime overrides ([`ResolveOptions::overrides`]).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OresOtelFileLayer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logging: Option<FileLoggingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracing: Option<FileTracingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<FileMetricsConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exporter: Option<FileExporterConfig>,
}

/// Parsed `.ores-otel.toml` object governed by `ores-otel-config.v1`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OresOtelFileConfig {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub common: Option<OresOtelFileLayer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<OresOtelFileLayer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<OresOtelFileLayer>,
}

impl Default for OresOtelFileConfig {
    fn default() -> Self {
        Self {
            version: ORES_OTEL_CONFIG_VERSION,
            common: None,
            client: None,
            server: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Layer merging: key-by-key, arrays replace
// ---------------------------------------------------------------------------

trait Overlay {
    /// Returns a new value where every field set in `top` wins.
    fn overlay(self, top: Self) -> Self;
}

fn overlay_option<T: Overlay>(base: Option<T>, top: Option<T>) -> Option<T> {
    match (base, top) {
        (Some(base), Some(top)) => Some(base.overlay(top)),
        (base, None) => base,
        (None, top) => top,
    }
}

/// Struct literals are exhaustive, so adding a field without merging it fails
/// to compile.
macro_rules! impl_overlay {
    ($ty:ty { $($scalar:ident),* $(,)? } { $($nested:ident),* $(,)? }) => {
        impl Overlay for $ty {
            fn overlay(self, top: Self) -> Self {
                Self {
                    $($scalar: top.$scalar.or(self.$scalar),)*
                    $($nested: overlay_option(self.$nested, top.$nested),)*
                }
            }
        }
    };
}

impl_overlay!(FileLoggingConfig { enabled, level, console, auto_send } {});
impl_overlay!(FileTracingConfig { enabled, sample_ratio, propagators } {});
impl_overlay!(FileProcessMetrics {
    enabled, sample_interval_ms, rss_bytes, virtual_memory_bytes, heap_bytes, cpu_seconds,
    thread_count, open_file_descriptors
} {});
impl_overlay!(FileFilesystemMetrics {
    enabled, paths, capacity_bytes, free_bytes, free_ratio, inode_free_ratio, min_free_bytes,
    min_free_ratio, min_inode_free_ratio
} {});
impl_overlay!(FileLatencyMetrics {
    enabled, request_duration_ms, operation_duration_ms, queue_wait_ms, event_loop_lag_ms,
    histogram_boundaries_ms
} {});
impl_overlay!(FileRuntimeMetrics {
    enabled, gc_pause_ms, gc_heap_bytes, event_loop_utilization, scheduler_queue_depth
} {});
impl_overlay!(FileSaturationMetrics {
    enabled, cpu_ratio_warning, memory_ratio_warning, disk_free_ratio_warning, queue_depth_warning
} {});
impl_overlay!(FileMetricsConfig {
    enabled, exemplars, span_metrics, service_graphs
} {
    process, filesystem, latency, runtime, saturation
});
impl_overlay!(FileExporterConfig { protocol, endpoint_env } {});
impl_overlay!(OresOtelFileLayer {
    enabled, service_name, environment
} {
    logging, tracing, metrics, exporter
});

// ---------------------------------------------------------------------------
// Shared validators (file, environment, and resolved overrides)
// ---------------------------------------------------------------------------

/// `/^[A-Z][A-Z0-9_]{0,127}$/`
fn is_env_name(text: &str) -> bool {
    match text.as_bytes().split_first() {
        Some((first, rest)) => {
            first.is_ascii_uppercase()
                && rest.len() <= 127
                && rest
                    .iter()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
        }
        None => false,
    }
}

/// `/(?:authorization|token|secret|password|cookie|api[_-]?key|private[_-]?key|headers?)/iu`
fn is_secret_shaped(key: &str) -> bool {
    const NEEDLES: [&str; 12] = [
        "authorization",
        "token",
        "secret",
        "password",
        "cookie",
        "apikey",
        "api_key",
        "api-key",
        "privatekey",
        "private_key",
        "private-key",
        "header",
    ];
    let lower = key.to_lowercase();
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

/// JavaScript `String.prototype.trim` (Unicode whitespace plus BOM).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
}

/// JavaScript `string.length` (UTF-16 code units).
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn in_unit_interval(value: f64) -> bool {
    (0.0..=1.0).contains(&value)
}

fn validate_paths(paths: Vec<String>, label: &str) -> Result<Vec<String>, OresOtelConfigError> {
    if paths.is_empty() || paths.len() > MAX_ARRAY_ENTRIES {
        return Err(invalid(format!(
            "{label} must contain 1..{MAX_ARRAY_ENTRIES} paths"
        )));
    }
    if paths.iter().any(|path| js_trim(path).is_empty()) {
        return Err(invalid(format!("{label} must not contain empty paths")));
    }
    if paths.iter().any(|path| path.contains('\0')) {
        return Err(invalid(format!("{label} must not contain NUL bytes")));
    }
    if paths.iter().collect::<BTreeSet<_>>().len() != paths.len() {
        return Err(invalid(format!("{label} must not contain duplicates")));
    }
    Ok(paths)
}

fn validate_boundaries(values: Vec<f64>, label: &str) -> Result<Vec<f64>, OresOtelConfigError> {
    if values.is_empty() || values.len() > MAX_ARRAY_ENTRIES {
        return Err(invalid(format!(
            "{label} must contain 1..{MAX_ARRAY_ENTRIES} boundaries"
        )));
    }
    if values
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(invalid(format!(
            "{label} must contain finite numbers greater than 0"
        )));
    }
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(invalid(format!("{label} must be strictly increasing")));
    }
    Ok(values)
}

fn validate_propagators(
    values: Vec<String>,
    label: &str,
) -> Result<Vec<OresOtelPropagator>, OresOtelConfigError> {
    if values.len() > MAX_PROPAGATORS {
        return Err(invalid(format!(
            "{label} may contain at most {MAX_PROPAGATORS} entries"
        )));
    }
    let propagators = values
        .iter()
        .map(|value| {
            OresOtelPropagator::parse(value)
                .ok_or_else(|| invalid(format!("{label} contains unsupported value {value}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if propagators.iter().collect::<BTreeSet<_>>().len() != propagators.len() {
        return Err(invalid(format!("{label} must not contain duplicates")));
    }
    Ok(propagators)
}

// ---------------------------------------------------------------------------
// Strict contract parser
// ---------------------------------------------------------------------------

const ROOT_KEYS: &[&str] = &["version", "common", "client", "server"];
const LAYER_KEYS: &[&str] = &[
    "enabled",
    "service_name",
    "environment",
    "logging",
    "tracing",
    "metrics",
    "exporter",
];
const LOGGING_KEYS: &[&str] = &["enabled", "level", "console", "auto_send"];
const TRACING_KEYS: &[&str] = &["enabled", "sample_ratio", "propagators"];
const METRICS_KEYS: &[&str] = &[
    "enabled",
    "process",
    "filesystem",
    "latency",
    "runtime",
    "saturation",
    "exemplars",
    "span_metrics",
    "service_graphs",
];
const PROCESS_KEYS: &[&str] = &[
    "enabled",
    "sample_interval_ms",
    "rss_bytes",
    "virtual_memory_bytes",
    "heap_bytes",
    "cpu_seconds",
    "thread_count",
    "open_file_descriptors",
];
const FILESYSTEM_KEYS: &[&str] = &[
    "enabled",
    "paths",
    "capacity_bytes",
    "free_bytes",
    "free_ratio",
    "inode_free_ratio",
    "min_free_bytes",
    "min_free_ratio",
    "min_inode_free_ratio",
];
const LATENCY_KEYS: &[&str] = &[
    "enabled",
    "request_duration_ms",
    "operation_duration_ms",
    "queue_wait_ms",
    "event_loop_lag_ms",
    "histogram_boundaries_ms",
];
const RUNTIME_KEYS: &[&str] = &[
    "enabled",
    "gc_pause_ms",
    "gc_heap_bytes",
    "event_loop_utilization",
    "scheduler_queue_depth",
];
const SATURATION_KEYS: &[&str] = &[
    "enabled",
    "cpu_ratio_warning",
    "memory_ratio_warning",
    "disk_free_ratio_warning",
    "queue_depth_warning",
];
const EXPORTER_KEYS: &[&str] = &["protocol", "endpoint_env"];

/// Typed, path-labelled read access to one TOML table whose keys have already
/// been checked against the allowed set.
struct TableReader<'a> {
    table: &'a TomlTable,
    path: String,
}

impl<'a> TableReader<'a> {
    fn new(
        table: &'a TomlTable,
        path: impl Into<String>,
        allowed: &[&str],
    ) -> Result<Self, OresOtelConfigError> {
        let path = path.into();
        table.keys().try_for_each(|key| {
            if is_secret_shaped(key) {
                return Err(invalid(format!(
                    "{path}.{key} is forbidden: credentials and secret-shaped settings do not belong in .ores-otel.toml"
                )));
            }
            if !allowed.contains(&key.as_str()) {
                return Err(invalid(format!(
                    "{path}.{key} is not a supported .ores-otel.toml v1 key"
                )));
            }
            Ok(())
        })?;
        Ok(Self { table, path })
    }

    fn label(&self, key: &str) -> String {
        format!("{}.{key}", self.path)
    }

    fn table(&self, key: &str) -> Result<Option<&'a TomlTable>, OresOtelConfigError> {
        match self.table.get(key) {
            None => Ok(None),
            Some(TomlValue::Table(table)) => Ok(Some(table)),
            Some(_) => Err(invalid(format!("{} must be a TOML table", self.label(key)))),
        }
    }

    fn boolean(&self, key: &str) -> Result<Option<bool>, OresOtelConfigError> {
        match self.table.get(key) {
            None => Ok(None),
            Some(TomlValue::Boolean(value)) => Ok(Some(*value)),
            Some(_) => Err(invalid(format!("{} must be a boolean", self.label(key)))),
        }
    }

    fn string(&self, key: &str, maximum: usize) -> Result<Option<String>, OresOtelConfigError> {
        match self.table.get(key) {
            None => Ok(None),
            Some(TomlValue::String(value)) => {
                let normalized = js_trim(value);
                let length = js_length(normalized);
                if length == 0 || length > maximum {
                    return Err(invalid(format!(
                        "{} must contain 1..{maximum} non-whitespace characters",
                        self.label(key)
                    )));
                }
                Ok(Some(normalized.to_owned()))
            }
            Some(_) => Err(invalid(format!("{} must be a string", self.label(key)))),
        }
    }

    fn number(&self, key: &str) -> Result<Option<f64>, OresOtelConfigError> {
        match self.table.get(key) {
            None => Ok(None),
            Some(value) => value
                .as_number()
                .filter(|number| number.is_finite())
                .map(Some)
                .ok_or_else(|| invalid(format!("{} must be a finite number", self.label(key)))),
        }
    }

    fn ratio(&self, key: &str) -> Result<Option<f64>, OresOtelConfigError> {
        match self.number(key)? {
            Some(value) if !in_unit_interval(value) => Err(invalid(format!(
                "{} must be between 0 and 1 inclusive",
                self.label(key)
            ))),
            other => Ok(other),
        }
    }

    fn integer(
        &self,
        key: &str,
        minimum: u64,
        maximum: u64,
    ) -> Result<Option<u64>, OresOtelConfigError> {
        let out_of_range = || {
            invalid(format!(
                "{} must be an integer between {minimum} and {maximum}",
                self.label(key)
            ))
        };
        match self.table.get(key) {
            None => Ok(None),
            Some(TomlValue::Integer(value)) => u64::try_from(*value)
                .ok()
                .filter(|value| (minimum..=maximum).contains(value))
                .map(Some)
                .ok_or_else(out_of_range),
            // Shared parity rule: integer keys reject float spellings such as
            // `5000.0` even when the value is integral.
            Some(TomlValue::Float(_)) => Err(invalid(format!(
                "{} must be an integer, not a float literal",
                self.label(key)
            ))),
            Some(_) => Err(invalid(format!("{} must be an integer", self.label(key)))),
        }
    }

    fn strings(&self, key: &str) -> Result<Option<Vec<String>>, OresOtelConfigError> {
        let not_strings = || invalid(format!("{} must be an array of strings", self.label(key)));
        match self.table.get(key) {
            None => Ok(None),
            Some(TomlValue::Array(items)) => items
                .iter()
                .map(|item| match item {
                    TomlValue::String(value) => Ok(value.clone()),
                    _ => Err(not_strings()),
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            Some(_) => Err(not_strings()),
        }
    }

    fn numbers(&self, key: &str) -> Result<Option<Vec<f64>>, OresOtelConfigError> {
        let not_numbers = || invalid(format!("{} must be an array of numbers", self.label(key)));
        match self.table.get(key) {
            None => Ok(None),
            Some(TomlValue::Array(items)) => items
                .iter()
                .map(|item| item.as_number().ok_or_else(not_numbers))
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            Some(_) => Err(not_numbers()),
        }
    }
}

fn parse_logging(
    table: &TomlTable,
    path: String,
) -> Result<FileLoggingConfig, OresOtelConfigError> {
    let reader = TableReader::new(table, path, LOGGING_KEYS)?;
    let enabled = reader.boolean("enabled")?;
    let level = reader
        .string("level", 16)?
        .map(|level| {
            OresOtelLogLevel::parse(&level.to_lowercase()).ok_or_else(|| {
                invalid(format!(
                    "{} must be trace|debug|info|warn|error|fatal",
                    reader.label("level")
                ))
            })
        })
        .transpose()?;
    Ok(FileLoggingConfig {
        enabled,
        level,
        console: reader.boolean("console")?,
        auto_send: reader.boolean("auto_send")?,
    })
}

fn parse_tracing(
    table: &TomlTable,
    path: String,
) -> Result<FileTracingConfig, OresOtelConfigError> {
    let reader = TableReader::new(table, path, TRACING_KEYS)?;
    let sample_ratio = reader.ratio("sample_ratio")?;
    let propagators = reader
        .strings("propagators")?
        .map(|values| {
            validate_propagators(
                values
                    .iter()
                    .map(|value| js_trim(value).to_lowercase())
                    .collect(),
                &reader.label("propagators"),
            )
        })
        .transpose()?;
    Ok(FileTracingConfig {
        enabled: reader.boolean("enabled")?,
        sample_ratio,
        propagators,
    })
}

fn parse_process_metrics(
    table: &TomlTable,
    path: String,
) -> Result<FileProcessMetrics, OresOtelConfigError> {
    let reader = TableReader::new(table, path, PROCESS_KEYS)?;
    Ok(FileProcessMetrics {
        enabled: reader.boolean("enabled")?,
        sample_interval_ms: reader.integer(
            "sample_interval_ms",
            SAMPLE_INTERVAL_MIN_MS,
            SAMPLE_INTERVAL_MAX_MS,
        )?,
        rss_bytes: reader.boolean("rss_bytes")?,
        virtual_memory_bytes: reader.boolean("virtual_memory_bytes")?,
        heap_bytes: reader.boolean("heap_bytes")?,
        cpu_seconds: reader.boolean("cpu_seconds")?,
        thread_count: reader.boolean("thread_count")?,
        open_file_descriptors: reader.boolean("open_file_descriptors")?,
    })
}

fn parse_filesystem_metrics(
    table: &TomlTable,
    path: String,
) -> Result<FileFilesystemMetrics, OresOtelConfigError> {
    let reader = TableReader::new(table, path, FILESYSTEM_KEYS)?;
    Ok(FileFilesystemMetrics {
        enabled: reader.boolean("enabled")?,
        paths: reader
            .strings("paths")?
            .map(|paths| validate_paths(paths, &reader.label("paths")))
            .transpose()?,
        capacity_bytes: reader.boolean("capacity_bytes")?,
        free_bytes: reader.boolean("free_bytes")?,
        free_ratio: reader.boolean("free_ratio")?,
        inode_free_ratio: reader.boolean("inode_free_ratio")?,
        min_free_bytes: reader.integer("min_free_bytes", 0, u64::MAX)?,
        min_free_ratio: reader.ratio("min_free_ratio")?,
        min_inode_free_ratio: reader.ratio("min_inode_free_ratio")?,
    })
}

fn parse_latency_metrics(
    table: &TomlTable,
    path: String,
) -> Result<FileLatencyMetrics, OresOtelConfigError> {
    let reader = TableReader::new(table, path, LATENCY_KEYS)?;
    Ok(FileLatencyMetrics {
        enabled: reader.boolean("enabled")?,
        request_duration_ms: reader.boolean("request_duration_ms")?,
        operation_duration_ms: reader.boolean("operation_duration_ms")?,
        queue_wait_ms: reader.boolean("queue_wait_ms")?,
        event_loop_lag_ms: reader.boolean("event_loop_lag_ms")?,
        histogram_boundaries_ms: reader
            .numbers("histogram_boundaries_ms")?
            .map(|values| validate_boundaries(values, &reader.label("histogram_boundaries_ms")))
            .transpose()?,
    })
}

fn parse_runtime_metrics(
    table: &TomlTable,
    path: String,
) -> Result<FileRuntimeMetrics, OresOtelConfigError> {
    let reader = TableReader::new(table, path, RUNTIME_KEYS)?;
    Ok(FileRuntimeMetrics {
        enabled: reader.boolean("enabled")?,
        gc_pause_ms: reader.boolean("gc_pause_ms")?,
        gc_heap_bytes: reader.boolean("gc_heap_bytes")?,
        event_loop_utilization: reader.boolean("event_loop_utilization")?,
        scheduler_queue_depth: reader.boolean("scheduler_queue_depth")?,
    })
}

fn parse_saturation_metrics(
    table: &TomlTable,
    path: String,
) -> Result<FileSaturationMetrics, OresOtelConfigError> {
    let reader = TableReader::new(table, path, SATURATION_KEYS)?;
    Ok(FileSaturationMetrics {
        enabled: reader.boolean("enabled")?,
        cpu_ratio_warning: reader.ratio("cpu_ratio_warning")?,
        memory_ratio_warning: reader.ratio("memory_ratio_warning")?,
        disk_free_ratio_warning: reader.ratio("disk_free_ratio_warning")?,
        queue_depth_warning: reader.integer("queue_depth_warning", 0, u64::MAX)?,
    })
}

fn parse_sub_table<T>(
    reader: &TableReader<'_>,
    key: &str,
    parse: fn(&TomlTable, String) -> Result<T, OresOtelConfigError>,
) -> Result<Option<T>, OresOtelConfigError> {
    reader
        .table(key)?
        .map(|table| parse(table, reader.label(key)))
        .transpose()
}

fn parse_metrics(
    table: &TomlTable,
    path: String,
) -> Result<FileMetricsConfig, OresOtelConfigError> {
    let reader = TableReader::new(table, path, METRICS_KEYS)?;
    Ok(FileMetricsConfig {
        enabled: reader.boolean("enabled")?,
        process: parse_sub_table(&reader, "process", parse_process_metrics)?,
        filesystem: parse_sub_table(&reader, "filesystem", parse_filesystem_metrics)?,
        latency: parse_sub_table(&reader, "latency", parse_latency_metrics)?,
        runtime: parse_sub_table(&reader, "runtime", parse_runtime_metrics)?,
        saturation: parse_sub_table(&reader, "saturation", parse_saturation_metrics)?,
        exemplars: reader.boolean("exemplars")?,
        span_metrics: reader.boolean("span_metrics")?,
        service_graphs: reader.boolean("service_graphs")?,
    })
}

fn parse_exporter(
    table: &TomlTable,
    path: String,
) -> Result<FileExporterConfig, OresOtelConfigError> {
    let reader = TableReader::new(table, path, EXPORTER_KEYS)?;
    let protocol = reader
        .string("protocol", 32)?
        .map(|protocol| {
            OresOtelExporterProtocol::parse(&protocol.to_lowercase()).ok_or_else(|| {
                invalid(format!(
                    "{} must be none|otlp_http|otlp_grpc",
                    reader.label("protocol")
                ))
            })
        })
        .transpose()?;
    let endpoint_env = reader
        .string("endpoint_env", 128)?
        .map(|name| {
            if is_env_name(&name) {
                Ok(name)
            } else {
                Err(invalid(format!(
                    "{} must be an uppercase environment-variable name",
                    reader.label("endpoint_env")
                )))
            }
        })
        .transpose()?;
    Ok(FileExporterConfig {
        protocol,
        endpoint_env,
    })
}

fn parse_layer(table: &TomlTable, path: String) -> Result<OresOtelFileLayer, OresOtelConfigError> {
    let reader = TableReader::new(table, path, LAYER_KEYS)?;
    Ok(OresOtelFileLayer {
        enabled: reader.boolean("enabled")?,
        service_name: reader.string("service_name", 256)?,
        environment: reader.string("environment", 128)?,
        logging: parse_sub_table(&reader, "logging", parse_logging)?,
        tracing: parse_sub_table(&reader, "tracing", parse_tracing)?,
        metrics: parse_sub_table(&reader, "metrics", parse_metrics)?,
        exporter: parse_sub_table(&reader, "exporter", parse_exporter)?,
    })
}

/// Strictly parses the tracked TOML file and applies runtime-only semantic
/// checks (ranges, integral integers, histogram ordering, path uniqueness).
pub fn parse_ores_otel_toml(input: &str) -> Result<OresOtelFileConfig, OresOtelConfigError> {
    let root = parse_toml(input)?;
    let reader = TableReader::new(&root, "root", ROOT_KEYS)?;
    // `version = 1.0` is a float literal and fails like every other integer key.
    let version_ok = matches!(
        root.get("version"),
        Some(TomlValue::Integer(version)) if *version == i64::from(ORES_OTEL_CONFIG_VERSION)
    );
    if !version_ok {
        return Err(invalid(format!(
            "root.version must equal {ORES_OTEL_CONFIG_VERSION}"
        )));
    }
    let layer = |key: &str| {
        reader
            .table(key)?
            .map(|table| parse_layer(table, key.to_owned()))
            .transpose()
    };
    Ok(OresOtelFileConfig {
        version: ORES_OTEL_CONFIG_VERSION,
        common: layer("common")?,
        client: layer("client")?,
        server: layer("server")?,
    })
}

// ---------------------------------------------------------------------------
// Environment layer
// ---------------------------------------------------------------------------

pub type OresOtelEnv = BTreeMap<String, String>;

fn env_bool(env: &OresOtelEnv, name: &str) -> Result<Option<bool>, OresOtelConfigError> {
    env.get(name)
        .map(|raw| match js_trim(raw).to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(env_error(format!(
                "{name} must be true/false, 1/0, yes/no, or on/off"
            ))),
        })
        .transpose()
}

fn env_text(
    env: &OresOtelEnv,
    name: &str,
    maximum: usize,
) -> Result<Option<String>, OresOtelConfigError> {
    env.get(name)
        .map(|raw| {
            let value = js_trim(raw);
            let length = js_length(value);
            if length == 0 || length > maximum {
                return Err(env_error(format!(
                    "{name} must contain 1..{maximum} characters"
                )));
            }
            Ok(value.to_owned())
        })
        .transpose()
}

fn parse_env_f64(raw: &str) -> Option<f64> {
    let text = js_trim(raw);
    if text.is_empty() {
        return None;
    }
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn env_ratio(env: &OresOtelEnv, name: &str) -> Result<Option<f64>, OresOtelConfigError> {
    env.get(name)
        .map(|raw| {
            parse_env_f64(raw)
                .filter(|value| in_unit_interval(*value))
                .ok_or_else(|| env_error(format!("{name} must be a finite number between 0 and 1")))
        })
        .transpose()
}

fn env_integer(
    env: &OresOtelEnv,
    name: &str,
    minimum: u64,
    maximum: u64,
) -> Result<Option<u64>, OresOtelConfigError> {
    env.get(name)
        .map(|raw| {
            // Shared parity rule: integer variables accept digits only, so
            // `5000.0` and `12.5` both fail (TypeScript and Dart agree).
            js_trim(raw)
                .parse::<u64>()
                .ok()
                .filter(|value| (minimum..=maximum).contains(value))
                .ok_or_else(|| {
                    env_error(format!(
                        "{name} must be an integer between {minimum} and {maximum}"
                    ))
                })
        })
        .transpose()
}

#[derive(Clone, Debug, PartialEq)]
enum EnvArrayItem {
    Text(String),
    Number(f64),
}

/// A JSON array (what flags-2-env emits for `type = "array"`) or a
/// comma-separated list whose items are trimmed.
fn env_array(
    env: &OresOtelEnv,
    name: &str,
) -> Result<Option<Vec<EnvArrayItem>>, OresOtelConfigError> {
    env.get(name)
        .map(|raw| {
            let text = js_trim(raw);
            if !text.starts_with('[') {
                return Ok(text
                    .split(',')
                    .map(|item| EnvArrayItem::Text(js_trim(item).to_owned()))
                    .collect());
            }
            let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| {
                env_error(format!(
                    "{name} must be a JSON array or a comma-separated list"
                ))
            })?;
            parsed
                .as_array()
                .ok_or_else(|| env_error(format!("{name} must be a JSON array")))?
                .iter()
                .map(|item| match item {
                    serde_json::Value::String(value) => Ok(EnvArrayItem::Text(value.clone())),
                    serde_json::Value::Number(value) => value
                        .as_f64()
                        .map(EnvArrayItem::Number)
                        .ok_or_else(|| env_error(format!("{name} contains an invalid number"))),
                    _ => Err(env_error(format!(
                        "{name} array items must be strings or numbers"
                    ))),
                })
                .collect()
        })
        .transpose()
}

fn as_environment_error(error: OresOtelConfigError) -> OresOtelConfigError {
    match error {
        OresOtelConfigError::Invalid(message) => OresOtelConfigError::Environment(message),
        other => other,
    }
}

fn env_paths(env: &OresOtelEnv) -> Result<Option<Vec<String>>, OresOtelConfigError> {
    let name = ENV_METRICS_FILESYSTEM_PATHS;
    env_array(env, name)?
        .map(|items| {
            let paths = items
                .into_iter()
                .map(|item| match item {
                    EnvArrayItem::Text(value) => Ok(value),
                    EnvArrayItem::Number(_) => {
                        Err(env_error(format!("{name} must contain only strings")))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            validate_paths(paths, name).map_err(as_environment_error)
        })
        .transpose()
}

fn env_boundaries(env: &OresOtelEnv) -> Result<Option<Vec<f64>>, OresOtelConfigError> {
    let name = ENV_METRICS_HISTOGRAM_BOUNDARIES_MS;
    env_array(env, name)?
        .map(|items| {
            let values = items
                .into_iter()
                .map(|item| match item {
                    EnvArrayItem::Number(value) => Ok(value),
                    EnvArrayItem::Text(value) => parse_env_f64(&value)
                        .ok_or_else(|| env_error(format!("{name} must contain only numbers"))),
                })
                .collect::<Result<Vec<_>, _>>()?;
            validate_boundaries(values, name).map_err(as_environment_error)
        })
        .transpose()
}

fn env_propagators(
    env: &OresOtelEnv,
) -> Result<Option<Vec<OresOtelPropagator>>, OresOtelConfigError> {
    env.get(ENV_PROPAGATORS)
        .map(|raw| {
            let values = raw
                .split(',')
                .map(|value| js_trim(value).to_lowercase())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            let parsed = values
                .iter()
                .map(|value| OresOtelPropagator::parse(value))
                .collect::<Option<Vec<_>>>()
                .filter(|parsed| !parsed.is_empty())
                .ok_or_else(|| {
                    env_error(format!(
                        "{ENV_PROPAGATORS} must be a comma-separated subset of tracecontext,baggage"
                    ))
                })?;
            if parsed.iter().collect::<BTreeSet<_>>().len() != parsed.len() {
                return Err(env_error(format!(
                    "{ENV_PROPAGATORS} must not contain duplicates"
                )));
            }
            Ok(parsed)
        })
        .transpose()
}

fn env_log_level(env: &OresOtelEnv) -> Result<Option<OresOtelLogLevel>, OresOtelConfigError> {
    env.get(ENV_LOG_LEVEL)
        .map(|raw| {
            OresOtelLogLevel::parse(&js_trim(raw).to_lowercase()).ok_or_else(|| {
                env_error(format!(
                    "{ENV_LOG_LEVEL} must be trace|debug|info|warn|error|fatal"
                ))
            })
        })
        .transpose()
}

fn env_protocol(
    env: &OresOtelEnv,
) -> Result<Option<OresOtelExporterProtocol>, OresOtelConfigError> {
    env.get(ENV_EXPORTER_PROTOCOL)
        .map(|raw| {
            OresOtelExporterProtocol::parse(&js_trim(raw).to_lowercase()).ok_or_else(|| {
                env_error(format!(
                    "{ENV_EXPORTER_PROTOCOL} must be none|otlp_http|otlp_grpc"
                ))
            })
        })
        .transpose()
}

fn env_endpoint_env(env: &OresOtelEnv) -> Result<Option<String>, OresOtelConfigError> {
    env.get(ENV_EXPORTER_ENDPOINT_ENV)
        .map(|raw| {
            let name = js_trim(raw);
            if is_env_name(name) {
                Ok(name.to_owned())
            } else {
                Err(env_error(format!(
                    "{ENV_EXPORTER_ENDPOINT_ENV} must name an uppercase environment variable"
                )))
            }
        })
        .transpose()
}

/// Builds the environment layer. Struct literal fields evaluate in source
/// order, so the first malformed variable reported is deterministic.
fn env_layer(env: &OresOtelEnv) -> Result<OresOtelFileLayer, OresOtelConfigError> {
    Ok(OresOtelFileLayer {
        enabled: env_bool(env, ENV_ENABLED)?,
        service_name: env_text(env, ENV_SERVICE_NAME, 256)?,
        environment: env_text(env, ENV_ENVIRONMENT, 128)?,
        logging: Some(FileLoggingConfig {
            enabled: env_bool(env, ENV_LOGGING_ENABLED)?,
            level: env_log_level(env)?,
            console: env_bool(env, ENV_LOG_CONSOLE)?,
            auto_send: env_bool(env, ENV_LOG_AUTO_SEND)?,
        }),
        tracing: Some(FileTracingConfig {
            enabled: env_bool(env, ENV_TRACING_ENABLED)?,
            sample_ratio: env_ratio(env, ENV_TRACE_SAMPLE_RATIO)?,
            propagators: env_propagators(env)?,
        }),
        metrics: Some(FileMetricsConfig {
            enabled: env_bool(env, ENV_METRICS_ENABLED)?,
            process: Some(FileProcessMetrics {
                enabled: env_bool(env, ENV_METRICS_PROCESS_ENABLED)?,
                sample_interval_ms: env_integer(
                    env,
                    ENV_METRICS_SAMPLE_INTERVAL_MS,
                    SAMPLE_INTERVAL_MIN_MS,
                    SAMPLE_INTERVAL_MAX_MS,
                )?,
                ..FileProcessMetrics::default()
            }),
            filesystem: Some(FileFilesystemMetrics {
                enabled: env_bool(env, ENV_METRICS_FILESYSTEM_ENABLED)?,
                paths: env_paths(env)?,
                min_free_bytes: env_integer(env, ENV_METRICS_MIN_FREE_BYTES, 0, u64::MAX)?,
                min_free_ratio: env_ratio(env, ENV_METRICS_MIN_FREE_RATIO)?,
                ..FileFilesystemMetrics::default()
            }),
            latency: Some(FileLatencyMetrics {
                enabled: env_bool(env, ENV_METRICS_LATENCY_ENABLED)?,
                histogram_boundaries_ms: env_boundaries(env)?,
                ..FileLatencyMetrics::default()
            }),
            runtime: Some(FileRuntimeMetrics {
                enabled: env_bool(env, ENV_METRICS_RUNTIME_ENABLED)?,
                ..FileRuntimeMetrics::default()
            }),
            saturation: Some(FileSaturationMetrics {
                enabled: env_bool(env, ENV_METRICS_SATURATION_ENABLED)?,
                memory_ratio_warning: env_ratio(env, ENV_METRICS_MEMORY_RATIO_WARNING)?,
                ..FileSaturationMetrics::default()
            }),
            ..FileMetricsConfig::default()
        }),
        exporter: Some(FileExporterConfig {
            protocol: env_protocol(env)?,
            endpoint_env: env_endpoint_env(env)?,
        }),
    })
}

// ---------------------------------------------------------------------------
// Resolved shape
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedLoggingConfig {
    pub enabled: bool,
    pub level: OresOtelLogLevel,
    pub console: bool,
    pub auto_send: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedTracingConfig {
    pub enabled: bool,
    pub sample_ratio: f64,
    pub propagators: Vec<OresOtelPropagator>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedProcessMetrics {
    pub enabled: bool,
    pub sample_interval_ms: u64,
    pub rss_bytes: bool,
    pub virtual_memory_bytes: bool,
    pub heap_bytes: bool,
    pub cpu_seconds: bool,
    pub thread_count: bool,
    pub open_file_descriptors: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedFilesystemMetrics {
    pub enabled: bool,
    pub paths: Vec<String>,
    pub capacity_bytes: bool,
    pub free_bytes: bool,
    pub free_ratio: bool,
    pub inode_free_ratio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_free_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_free_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_inode_free_ratio: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedLatencyMetrics {
    pub enabled: bool,
    pub request_duration_ms: bool,
    pub operation_duration_ms: bool,
    pub queue_wait_ms: bool,
    pub event_loop_lag_ms: bool,
    pub histogram_boundaries_ms: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedRuntimeMetrics {
    pub enabled: bool,
    pub gc_pause_ms: bool,
    pub gc_heap_bytes: bool,
    pub event_loop_utilization: bool,
    pub scheduler_queue_depth: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedSaturationMetrics {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_ratio_warning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_ratio_warning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_free_ratio_warning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_depth_warning: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedMetrics {
    pub enabled: bool,
    pub process: ResolvedProcessMetrics,
    pub filesystem: ResolvedFilesystemMetrics,
    pub latency: ResolvedLatencyMetrics,
    pub runtime: ResolvedRuntimeMetrics,
    pub saturation: ResolvedSaturationMetrics,
    pub exemplars: bool,
    pub span_metrics: bool,
    pub service_graphs: bool,
}

impl ResolvedMetrics {
    /// Probes run only when the master switch and the sub-table switch are on.
    #[must_use]
    pub fn process_active(&self) -> bool {
        self.enabled && self.process.enabled
    }

    #[must_use]
    pub fn filesystem_active(&self) -> bool {
        self.enabled && self.filesystem.enabled
    }

    #[must_use]
    pub fn latency_active(&self) -> bool {
        self.enabled && self.latency.enabled
    }

    #[must_use]
    pub fn runtime_active(&self) -> bool {
        self.enabled && self.runtime.enabled
    }

    #[must_use]
    pub fn saturation_active(&self) -> bool {
        self.enabled && self.saturation.enabled
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedExporterConfig {
    pub protocol: OresOtelExporterProtocol,
    /// Name of the environment variable holding the exporter endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_env: Option<String>,
}

/// Fully resolved configuration; serializes to the snake_case shape compared by
/// the cross-language parity fixtures.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedOresOtelConfig {
    pub version: u8,
    pub role: OresOtelRole,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    pub logging: ResolvedLoggingConfig,
    pub tracing: ResolvedTracingConfig,
    pub metrics: ResolvedMetrics,
    pub exporter: ResolvedExporterConfig,
}

impl ResolvedOresOtelConfig {
    /// The resolved shape as JSON, with unset optionals omitted.
    #[must_use]
    pub fn to_json_value(&self) -> serde_json::Value {
        // Serialization of these plain structs cannot fail: every map key is a
        // string field name and non-finite floats are rejected during
        // resolution, so the fallback is unreachable.
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

fn resolve_metrics(metrics: FileMetricsConfig) -> ResolvedMetrics {
    let process = metrics.process.unwrap_or_default();
    let filesystem = metrics.filesystem.unwrap_or_default();
    let latency = metrics.latency.unwrap_or_default();
    let runtime = metrics.runtime.unwrap_or_default();
    let saturation = metrics.saturation.unwrap_or_default();
    ResolvedMetrics {
        enabled: metrics.enabled.unwrap_or(true),
        process: ResolvedProcessMetrics {
            enabled: process.enabled.unwrap_or(true),
            sample_interval_ms: process
                .sample_interval_ms
                .unwrap_or(DEFAULT_SAMPLE_INTERVAL_MS),
            rss_bytes: process.rss_bytes.unwrap_or(true),
            virtual_memory_bytes: process.virtual_memory_bytes.unwrap_or(true),
            heap_bytes: process.heap_bytes.unwrap_or(true),
            cpu_seconds: process.cpu_seconds.unwrap_or(true),
            thread_count: process.thread_count.unwrap_or(true),
            open_file_descriptors: process.open_file_descriptors.unwrap_or(true),
        },
        filesystem: ResolvedFilesystemMetrics {
            enabled: filesystem.enabled.unwrap_or(true),
            paths: filesystem.paths.unwrap_or_else(|| vec![".".to_owned()]),
            capacity_bytes: filesystem.capacity_bytes.unwrap_or(true),
            free_bytes: filesystem.free_bytes.unwrap_or(true),
            free_ratio: filesystem.free_ratio.unwrap_or(true),
            inode_free_ratio: filesystem.inode_free_ratio.unwrap_or(true),
            min_free_bytes: filesystem.min_free_bytes,
            min_free_ratio: filesystem.min_free_ratio,
            min_inode_free_ratio: filesystem.min_inode_free_ratio,
        },
        latency: ResolvedLatencyMetrics {
            enabled: latency.enabled.unwrap_or(true),
            request_duration_ms: latency.request_duration_ms.unwrap_or(true),
            operation_duration_ms: latency.operation_duration_ms.unwrap_or(true),
            queue_wait_ms: latency.queue_wait_ms.unwrap_or(true),
            event_loop_lag_ms: latency.event_loop_lag_ms.unwrap_or(true),
            histogram_boundaries_ms: latency
                .histogram_boundaries_ms
                .unwrap_or_else(|| DEFAULT_HISTOGRAM_BOUNDARIES_MS.to_vec()),
        },
        runtime: ResolvedRuntimeMetrics {
            enabled: runtime.enabled.unwrap_or(true),
            gc_pause_ms: runtime.gc_pause_ms.unwrap_or(true),
            gc_heap_bytes: runtime.gc_heap_bytes.unwrap_or(true),
            event_loop_utilization: runtime.event_loop_utilization.unwrap_or(true),
            scheduler_queue_depth: runtime.scheduler_queue_depth.unwrap_or(true),
        },
        saturation: ResolvedSaturationMetrics {
            enabled: saturation.enabled.unwrap_or(true),
            cpu_ratio_warning: saturation.cpu_ratio_warning,
            memory_ratio_warning: saturation.memory_ratio_warning,
            disk_free_ratio_warning: saturation.disk_free_ratio_warning,
            queue_depth_warning: saturation.queue_depth_warning,
        },
        exemplars: metrics.exemplars.unwrap_or(false),
        span_metrics: metrics.span_metrics.unwrap_or(false),
        service_graphs: metrics.service_graphs.unwrap_or(false),
    }
}

/// Explicit runtime overrides are typed but not parsed, so their numeric
/// invariants are re-checked on the final value. File and environment values
/// always pass because they were validated on entry.
fn validate_resolved(
    config: ResolvedOresOtelConfig,
) -> Result<ResolvedOresOtelConfig, OresOtelConfigError> {
    let label = "overrides";
    let tracing = &config.tracing;
    let metrics = &config.metrics;
    let ratios = [
        tracing.sample_ratio,
        metrics.filesystem.min_free_ratio.unwrap_or(0.0),
        metrics.filesystem.min_inode_free_ratio.unwrap_or(0.0),
        metrics.saturation.cpu_ratio_warning.unwrap_or(0.0),
        metrics.saturation.memory_ratio_warning.unwrap_or(0.0),
        metrics.saturation.disk_free_ratio_warning.unwrap_or(0.0),
    ];
    if ratios.iter().any(|ratio| !in_unit_interval(*ratio)) {
        return Err(invalid(format!(
            "{label}: ratio settings must be between 0 and 1 inclusive"
        )));
    }
    if !(SAMPLE_INTERVAL_MIN_MS..=SAMPLE_INTERVAL_MAX_MS)
        .contains(&metrics.process.sample_interval_ms)
    {
        return Err(invalid(format!(
            "{label}: metrics.process.sample_interval_ms must be between {SAMPLE_INTERVAL_MIN_MS} and {SAMPLE_INTERVAL_MAX_MS}"
        )));
    }
    if tracing.propagators.iter().collect::<BTreeSet<_>>().len() != tracing.propagators.len() {
        return Err(invalid(format!(
            "{label}: tracing.propagators must not contain duplicates"
        )));
    }
    validate_paths(metrics.filesystem.paths.clone(), "metrics.filesystem.paths")?;
    validate_boundaries(
        metrics.latency.histogram_boundaries_ms.clone(),
        "metrics.latency.histogram_boundaries_ms",
    )?;
    Ok(config)
}

// ---------------------------------------------------------------------------
// Role selection and resolution
// ---------------------------------------------------------------------------

/// Inputs to [`resolve_ores_otel_config`]. The effective environment is `env`
/// with `flag_overrides` (a flags-2-env map) applied on top.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResolveOptions {
    pub role: Option<RuntimeRole>,
    pub env: OresOtelEnv,
    pub flag_overrides: OresOtelEnv,
    pub overrides: Option<OresOtelFileLayer>,
}

impl ResolveOptions {
    /// Options reading the real process environment (non-UTF-8 values are
    /// converted lossily, so malformed `ORES_OTEL_*` values still fail).
    #[must_use]
    pub fn from_process_env() -> Self {
        Self {
            env: std::env::vars_os()
                .map(|(key, value)| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_role(self, role: RuntimeRole) -> Self {
        Self {
            role: Some(role),
            ..self
        }
    }

    #[must_use]
    pub fn with_env(self, env: OresOtelEnv) -> Self {
        Self { env, ..self }
    }

    #[must_use]
    pub fn with_flag_overrides(self, flag_overrides: OresOtelEnv) -> Self {
        Self {
            flag_overrides,
            ..self
        }
    }

    #[must_use]
    pub fn with_overrides(self, overrides: OresOtelFileLayer) -> Self {
        Self {
            overrides: Some(overrides),
            ..self
        }
    }

    /// `env` then `flag_overrides` on top, as a new map.
    #[must_use]
    pub fn effective_env(&self) -> OresOtelEnv {
        self.env
            .iter()
            .chain(&self.flag_overrides)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
}

fn requested_role(
    env: &OresOtelEnv,
    explicit: Option<RuntimeRole>,
) -> Result<Option<RuntimeRole>, OresOtelConfigError> {
    if explicit.is_some() {
        return Ok(explicit);
    }
    let Some(raw) = env.get(ENV_ROLE).map(|raw| js_trim(raw).to_lowercase()) else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    RuntimeRole::parse(&raw)
        .map(Some)
        .ok_or_else(|| OresOtelConfigError::Role(format!("{ENV_ROLE} must be client or server")))
}

fn select_role(
    parsed: &OresOtelFileConfig,
    requested: Option<RuntimeRole>,
) -> Result<OresOtelRole, OresOtelConfigError> {
    let has_client = parsed.client.is_some();
    let has_server = parsed.server.is_some();
    match requested {
        Some(RuntimeRole::Client) if !has_client && has_server => Err(OresOtelConfigError::Role(
            "client telemetry role was requested but the file defines only a server role"
                .to_owned(),
        )),
        Some(RuntimeRole::Server) if !has_server && has_client => Err(OresOtelConfigError::Role(
            "server telemetry role was requested but the file defines only a client role"
                .to_owned(),
        )),
        Some(role) => Ok(role.into()),
        None if has_client && has_server => Err(OresOtelConfigError::Role(
            "ambiguous .ores-otel.toml: both client and server sections exist; set ORES_OTEL_ROLE or pass role explicitly".to_owned(),
        )),
        None if has_client => Ok(OresOtelRole::Client),
        None if has_server => Ok(OresOtelRole::Server),
        None => Ok(OresOtelRole::Shared),
    }
}

/// Applies `defaults < common < selected role < environment < flag overrides <
/// explicit overrides`.
pub fn resolve_ores_otel_config(
    parsed: &OresOtelFileConfig,
    options: &ResolveOptions,
) -> Result<ResolvedOresOtelConfig, OresOtelConfigError> {
    let env = options.effective_env();
    let role = select_role(parsed, requested_role(&env, options.role)?)?;
    let role_layer = match role {
        OresOtelRole::Client => parsed.client.clone(),
        OresOtelRole::Server => parsed.server.clone(),
        OresOtelRole::Shared => None,
    };
    let layer = [
        parsed.common.clone(),
        role_layer,
        Some(env_layer(&env)?),
        options.overrides.clone(),
    ]
    .into_iter()
    .flatten()
    .fold(OresOtelFileLayer::default(), Overlay::overlay);

    let logging = layer.logging.unwrap_or_default();
    let tracing = layer.tracing.unwrap_or_default();
    let exporter = layer.exporter.unwrap_or_default();
    validate_resolved(ResolvedOresOtelConfig {
        version: ORES_OTEL_CONFIG_VERSION,
        role,
        enabled: layer.enabled.unwrap_or(true),
        service_name: layer.service_name,
        environment: layer.environment,
        logging: ResolvedLoggingConfig {
            enabled: logging.enabled.unwrap_or(true),
            level: logging.level.unwrap_or(OresOtelLogLevel::Info),
            console: logging.console.unwrap_or(true),
            auto_send: logging.auto_send.unwrap_or(false),
        },
        tracing: ResolvedTracingConfig {
            enabled: tracing.enabled.unwrap_or(true),
            sample_ratio: tracing.sample_ratio.unwrap_or(1.0),
            propagators: tracing.propagators.unwrap_or_else(|| {
                vec![
                    OresOtelPropagator::Tracecontext,
                    OresOtelPropagator::Baggage,
                ]
            }),
        },
        metrics: resolve_metrics(layer.metrics.unwrap_or_default()),
        exporter: ResolvedExporterConfig {
            protocol: exporter.protocol.unwrap_or(OresOtelExporterProtocol::None),
            endpoint_env: exporter.endpoint_env,
        },
    })
}

/// Returns the endpoint from the configured environment variable without
/// persisting it in the configuration value.
#[must_use]
pub fn resolve_exporter_endpoint(
    config: &ResolvedOresOtelConfig,
    env: &OresOtelEnv,
) -> Option<String> {
    config
        .exporter
        .endpoint_env
        .as_ref()
        .and_then(|name| env.get(name))
        .map(|value| js_trim(value).to_owned())
        .filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LoadOptions {
    pub resolve: ResolveOptions,
    /// Directory containing `.ores-otel.toml`; outranks `ORES_OTEL_CONFIG_FILE`
    /// and `ORES_OTEL_CONFIG_DIR`. See [`ores_otel_config_file_path`].
    pub cwd: Option<PathBuf>,
    /// Explicit file path; outranks every other lookup input.
    pub file_path: Option<PathBuf>,
}

impl LoadOptions {
    #[must_use]
    pub fn from_process_env() -> Self {
        Self {
            resolve: ResolveOptions::from_process_env(),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadedOresOtelConfig {
    pub config: ResolvedOresOtelConfig,
    pub parsed: OresOtelFileConfig,
    /// `None` when no file existed and defaults were used.
    pub file_path: Option<PathBuf>,
}

/// Picks the config file path. Precedence: `file_path`, `cwd`,
/// `ORES_OTEL_CONFIG_FILE`, `ORES_OTEL_CONFIG_DIR`, then `current_directory`.
///
/// Blank values are skipped, values are trimmed, and trailing directory
/// separators are stripped. `env` must already include flag overrides (see
/// [`ResolveOptions::effective_env`]). Non-UTF-8 argument paths are treated as
/// absent. `tests/fixtures/ores-otel-config-lookup.json` pins this order for
/// the TypeScript, Dart, and Rust SDKs.
#[must_use]
pub fn ores_otel_config_file_path(
    file_path: Option<&std::path::Path>,
    cwd: Option<&std::path::Path>,
    env: &OresOtelEnv,
    current_directory: &std::path::Path,
) -> PathBuf {
    fn non_blank(value: Option<&str>) -> Option<&str> {
        value.map(js_trim).filter(|value| !value.is_empty())
    }
    fn in_directory(directory: &str) -> PathBuf {
        PathBuf::from(format!(
            "{}/{ORES_OTEL_CONFIG_BASENAME}",
            directory.trim_end_matches(['/', '\\'])
        ))
    }
    let env_value = |name: &str| non_blank(env.get(name).map(String::as_str));
    non_blank(file_path.and_then(std::path::Path::to_str))
        .map(PathBuf::from)
        .or_else(|| non_blank(cwd.and_then(std::path::Path::to_str)).map(in_directory))
        .or_else(|| env_value(ENV_CONFIG_FILE).map(PathBuf::from))
        .unwrap_or_else(|| {
            in_directory(
                env_value(ENV_CONFIG_DIR)
                    .or_else(|| current_directory.to_str())
                    .unwrap_or("."),
            )
        })
}

fn config_file_path(
    options: &LoadOptions,
    env: &OresOtelEnv,
) -> Result<PathBuf, OresOtelConfigError> {
    let current = std::env::current_dir().map_err(|source| OresOtelConfigError::Io {
        path: PathBuf::from("."),
        source,
    })?;
    Ok(ores_otel_config_file_path(
        options.file_path.as_deref(),
        options.cwd.as_deref(),
        env,
        &current,
    ))
}

/// Reads `.ores-otel.toml` when present (a missing file resolves defaults, as
/// in TypeScript), then resolves role, environment, and overrides.
pub fn load_ores_otel_config(
    options: LoadOptions,
) -> Result<LoadedOresOtelConfig, OresOtelConfigError> {
    let env = options.resolve.effective_env();
    let path = config_file_path(&options, &env)?;
    let (parsed, file_path) = match std::fs::read_to_string(&path) {
        Ok(input) => (parse_ores_otel_toml(&input)?, Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (OresOtelFileConfig::default(), None)
        }
        Err(source) => return Err(OresOtelConfigError::Io { path, source }),
    };
    let config = resolve_ores_otel_config(&parsed, &options.resolve)?;
    Ok(LoadedOresOtelConfig {
        config,
        parsed,
        file_path,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> OresOtelEnv {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn toml_err_line(input: &str) -> usize {
        match parse_toml(input) {
            Err(OresOtelConfigError::Toml { line, .. }) => line,
            other => panic!("expected TOML error, got {other:?}"),
        }
    }

    #[test]
    fn toml_reads_tables_keys_and_scalars() {
        let table = parse_toml(
            "# leading comment\ntitle = \"a # not comment\" # trailing\n[a.\"b c\"]\nint = -42\nfloat = 2.5e-3\nyes = true\n\"quoted key\" = \"esc \\\"q\\\" \\\\ \\n\"\r\n",
        )
        .expect("valid subset");
        assert_eq!(
            table.get("title"),
            Some(&TomlValue::String("a # not comment".to_owned()))
        );
        let Some(TomlValue::Table(a)) = table.get("a") else {
            panic!("a must be a table")
        };
        let Some(TomlValue::Table(inner)) = a.get("b c") else {
            panic!("quoted header segment")
        };
        assert_eq!(inner.get("int"), Some(&TomlValue::Integer(-42)));
        assert_eq!(inner.get("float"), Some(&TomlValue::Float(2.5e-3)));
        assert_eq!(inner.get("yes"), Some(&TomlValue::Boolean(true)));
        assert_eq!(
            inner.get("quoted key"),
            Some(&TomlValue::String("esc \"q\" \\ \n".to_owned()))
        );
    }

    #[test]
    fn toml_reads_single_and_multi_line_arrays() {
        let table =
            parse_toml("s = [\"a,b\", \"c]\"]\nn = [\n  1, # one\n  2.5,\n  3,\n]\nempty = []\n")
                .expect("valid arrays");
        assert_eq!(
            table.get("s"),
            Some(&TomlValue::Array(vec![
                TomlValue::String("a,b".to_owned()),
                TomlValue::String("c]".to_owned())
            ]))
        );
        assert_eq!(
            table.get("n"),
            Some(&TomlValue::Array(vec![
                TomlValue::Integer(1),
                TomlValue::Float(2.5),
                TomlValue::Integer(3)
            ]))
        );
        assert_eq!(table.get("empty"), Some(&TomlValue::Array(Vec::new())));
    }

    #[test]
    fn toml_rejects_unsupported_constructs() {
        assert_eq!(toml_err_line("a = { b = 1 }"), 1);
        assert_eq!(toml_err_line("[[items]]"), 1);
        assert_eq!(toml_err_line("a = 1\na = 2"), 2);
        // The repeated header itself fails (shared parity rule), before the
        // duplicate key on line 4 is reached.
        assert_eq!(toml_err_line("[t]\na = 1\n[t]\na = 2"), 3);
        assert_eq!(toml_err_line("a = [1, \"x\"]"), 1);
        assert_eq!(toml_err_line("a = [true]"), 1);
        assert_eq!(toml_err_line("a = [\n1,\n2"), 1);
        assert_eq!(toml_err_line("a = 'single'"), 1);
        assert_eq!(toml_err_line("a = \"bad \\u0041\""), 1);
        assert_eq!(toml_err_line("a = 1_000"), 1);
        assert_eq!(toml_err_line("a = .5"), 1);
        assert_eq!(toml_err_line("bad key = 1"), 1);
        assert_eq!(toml_err_line("no equals"), 1);
        assert_eq!(toml_err_line("[unterminated"), 1);
        assert_eq!(toml_err_line("a = 1\n[a]"), 2);
        assert_eq!(toml_err_line("a ="), 1);
        assert_eq!(toml_err_line("a = 99999999999999999999"), 1);
    }

    #[test]
    fn parse_accepts_full_metrics_layer() {
        let parsed = parse_ores_otel_toml(
            "version = 1\n[server.metrics]\nexemplars = true\n[server.metrics.process]\nsample_interval_ms = 5000\nheap_bytes = false\n[server.metrics.filesystem]\npaths = [\"/\", \"/data\"]\nmin_free_bytes = 0\nmin_inode_free_ratio = 0.05\n[server.metrics.latency]\nhistogram_boundaries_ms = [1, 2.5]\n[server.metrics.runtime]\ngc_pause_ms = false\n[server.metrics.saturation]\ncpu_ratio_warning = 1\nqueue_depth_warning = 10\n",
        )
        .expect("valid config");
        assert!(
            parse_ores_otel_toml(
                "version = 1\n[server.metrics.process]\nsample_interval_ms = 5000.0\n"
            )
            .is_err(),
            "integer keys reject float spellings"
        );
        let metrics = parsed
            .server
            .and_then(|layer| layer.metrics)
            .expect("server metrics");
        assert_eq!(metrics.exemplars, Some(true));
        assert_eq!(
            metrics
                .process
                .and_then(|process| process.sample_interval_ms),
            Some(5000)
        );
        assert_eq!(
            metrics
                .latency
                .and_then(|latency| latency.histogram_boundaries_ms),
            Some(vec![1.0, 2.5])
        );
    }

    #[test]
    fn parse_rejects_contract_violations() {
        let cases = [
            "version = 1\n[common.metrics.process]\nsample_interval_ms = 100.5",
            "version = 1\n[common.metrics.process]\nsample_interval_ms = 3600001",
            "version = 1\n[common.metrics.filesystem]\npaths = []",
            "version = 1\n[common.metrics.filesystem]\npaths = [\"  \"]",
            "version = 1\n[common.metrics.filesystem]\npaths = [\"a\\\\\"]\nmin_free_bytes = -1",
            "version = 1\n[common.metrics.latency]\nhistogram_boundaries_ms = [0, 1]",
            "version = 1\n[common.metrics.latency]\nhistogram_boundaries_ms = [\"1\"]",
            "version = 1\n[common.metrics.saturation]\nqueue_depth_warning = 1.5",
            "version = 1\n[common.metrics]\nprocess = true",
            "version = 1\n[common.logging]\nlevel = \"verbose\"",
            "version = 1\n[common.tracing]\npropagators = [\"b3\"]",
            "version = 1\n[common.tracing]\npropagators = [\"baggage\", \"BAGGAGE\"]",
            "version = 1\n[common.exporter]\nendpoint_env = \"lower\"",
            "version = 1\n[common]\nservice_name = \"   \"",
            "version = 1\n[common]\nauthorization_mode = true",
            "version = 1\nextra = 1",
            "[common]\nenabled = true",
        ];
        cases.iter().for_each(|input| {
            assert!(
                parse_ores_otel_toml(input).is_err(),
                "expected error for {input:?}"
            );
        });
    }

    #[test]
    fn resolve_rejects_malformed_env_and_role() {
        let parsed = parse_ores_otel_toml("version = 1\n[client]\n[server]").expect("valid");
        let cases: [(&str, &str); 8] = [
            (ENV_METRICS_SAMPLE_INTERVAL_MS, "12.5"),
            (ENV_METRICS_MIN_FREE_BYTES, "-1"),
            (ENV_METRICS_MIN_FREE_RATIO, "1.1"),
            (ENV_METRICS_FILESYSTEM_PATHS, "[1]"),
            (ENV_METRICS_FILESYSTEM_PATHS, "/a,,/b"),
            (ENV_METRICS_HISTOGRAM_BOUNDARIES_MS, "5,1"),
            (ENV_PROPAGATORS, "tracecontext,tracecontext"),
            (ENV_ROLE, "worker"),
        ];
        cases.iter().for_each(|(name, value)| {
            let options = ResolveOptions::default()
                .with_role(RuntimeRole::Server)
                .with_env(env(&[(name, value)]));
            let options = if *name == ENV_ROLE {
                ResolveOptions {
                    role: None,
                    ..options
                }
            } else {
                options
            };
            assert!(
                resolve_ores_otel_config(&parsed, &options).is_err(),
                "expected error for {name}={value}"
            );
        });
        assert!(matches!(
            resolve_ores_otel_config(&parsed, &ResolveOptions::default()),
            Err(OresOtelConfigError::Role(_))
        ));
        let server_only = parse_ores_otel_toml("version = 1\n[server]").expect("valid");
        assert!(resolve_ores_otel_config(
            &server_only,
            &ResolveOptions::default().with_role(RuntimeRole::Client)
        )
        .is_err());
    }

    #[test]
    fn resolve_merges_layers_and_explicit_overrides_win() {
        let parsed = parse_ores_otel_toml(
            "version = 1\n[common.metrics.filesystem]\npaths = [\"/\"]\nmin_free_ratio = 0.3\n[server.metrics.filesystem]\nmin_free_bytes = 10\n",
        )
        .expect("valid");
        let options = ResolveOptions::default()
            .with_env(env(&[
                (ENV_METRICS_FILESYSTEM_PATHS, "/a, /b"),
                (ENV_EXPORTER_ENDPOINT_ENV, "MY_ENDPOINT"),
                ("MY_ENDPOINT", "  http://collector:4318 "),
            ]))
            .with_flag_overrides(env(&[(ENV_METRICS_FILESYSTEM_PATHS, "[\"/flag\"]")]))
            .with_overrides(OresOtelFileLayer {
                service_name: Some("explicit".to_owned()),
                ..OresOtelFileLayer::default()
            });
        let resolved = resolve_ores_otel_config(&parsed, &options).expect("resolves");
        assert_eq!(resolved.role, OresOtelRole::Server);
        assert_eq!(resolved.service_name.as_deref(), Some("explicit"));
        assert_eq!(resolved.metrics.filesystem.paths, vec!["/flag".to_owned()]);
        assert_eq!(resolved.metrics.filesystem.min_free_bytes, Some(10));
        assert_eq!(resolved.metrics.filesystem.min_free_ratio, Some(0.3));
        assert_eq!(
            resolve_exporter_endpoint(&resolved, &options.effective_env()).as_deref(),
            Some("http://collector:4318")
        );

        let bad_override = options.with_overrides(OresOtelFileLayer {
            metrics: Some(FileMetricsConfig {
                latency: Some(FileLatencyMetrics {
                    histogram_boundaries_ms: Some(vec![3.0, 2.0]),
                    ..FileLatencyMetrics::default()
                }),
                ..FileMetricsConfig::default()
            }),
            ..OresOtelFileLayer::default()
        });
        assert!(resolve_ores_otel_config(&parsed, &bad_override).is_err());
    }

    #[test]
    fn resolved_json_omits_unset_optionals() {
        let resolved =
            resolve_ores_otel_config(&OresOtelFileConfig::default(), &ResolveOptions::default())
                .expect("defaults");
        let json = resolved.to_json_value();
        assert_eq!(json["role"], "shared");
        assert_eq!(json["exporter"], serde_json::json!({"protocol": "none"}));
        assert!(json.get("service_name").is_none());
        assert!(json["metrics"]["filesystem"]
            .get("min_free_bytes")
            .is_none());
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        std::env::temp_dir().join(format!(
            "ores-otel-config-{tag}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn load_reads_file_from_config_dir_flag_and_falls_back_to_defaults() {
        let dir = unique_temp_dir("load");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join(ORES_OTEL_CONFIG_BASENAME);
        std::fs::write(
            &file,
            "version = 1\n[server]\nservice_name = \"api\"\n[server.metrics.process]\nsample_interval_ms = 2000\n",
        )
        .expect("write config");

        let dir_text = dir.to_string_lossy().into_owned();
        let loaded = load_ores_otel_config(LoadOptions {
            resolve: ResolveOptions::default()
                .with_flag_overrides(env(&[(ENV_CONFIG_DIR, dir_text.as_str())])),
            ..LoadOptions::default()
        })
        .expect("load from dir");
        assert_eq!(loaded.file_path.as_deref(), Some(file.as_path()));
        assert_eq!(loaded.config.role, OresOtelRole::Server);
        assert_eq!(loaded.config.metrics.process.sample_interval_ms, 2000);

        let file_text = file.to_string_lossy().into_owned();
        let by_file = load_ores_otel_config(LoadOptions {
            resolve: ResolveOptions::default().with_env(env(&[
                (ENV_CONFIG_FILE, file_text.as_str()),
                (ENV_CONFIG_DIR, "/definitely/not/here"),
            ])),
            ..LoadOptions::default()
        })
        .expect("load by file");
        assert_eq!(by_file.config.service_name.as_deref(), Some("api"));

        let missing = load_ores_otel_config(LoadOptions {
            cwd: Some(dir.join("missing")),
            ..LoadOptions::default()
        })
        .expect("missing file resolves defaults");
        assert_eq!(missing.file_path, None);
        assert_eq!(missing.config.role, OresOtelRole::Shared);

        std::fs::write(&file, "version = 1\n[common]\ntoken = \"x\"\n").expect("rewrite");
        assert!(load_ores_otel_config(LoadOptions {
            file_path: Some(file.clone()),
            ..LoadOptions::default()
        })
        .is_err());

        std::fs::remove_dir_all(&dir).expect("clean temp dir");
    }
}
