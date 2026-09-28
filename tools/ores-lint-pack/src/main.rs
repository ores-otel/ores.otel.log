#![allow(
    clippy::needless_return,
    reason = "Shared policy requires explicit Rust returns."
)]

//! `ores-lint-pack` - certify a `.ores-lint/` payload before it is distributed.
//!
//! `.ores-lint/` is vendored into hundreds of repositories by copying the
//! directory. Nothing at the destination re-checks it, so a payload that is
//! internally inconsistent - a script calling a file the copy does not carry -
//! installs cleanly and fails only when somebody runs it by hand. That is how
//! `selftest.sh` came to call three fixtures no consumer had.
//!
//! Subcommands:
//!
//!   validate <payload>            every required intra-payload reference resolves
//!   manifest <payload>            emit the exact file set, with a digest per file
//!   verify   <payload> --manifest  a received payload matches a manifest exactly
//!
//! `validate` is the gate that must pass before a payload is copied anywhere;
//! `manifest` is what the copy is described by; `verify` is what the consumer
//! (or an auditor walking the fleet) runs to prove the copy is intact.

mod payload;
mod sha256;

use payload::{is_managed, Payload, PayloadFile};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
usage:
  ores-lint-pack validate <payload-dir> [--known-gaps <file>]
  ores-lint-pack manifest <payload-dir> [--out <file>]
  ores-lint-pack verify   <payload-dir> --manifest <file>
";

const MANIFEST_SCHEMA: &str = "ores-lint-payload-manifest/v1";

struct Options {
    command: String,
    payload: PathBuf,
    known_gaps: Option<PathBuf>,
    out: Option<PathBuf>,
    manifest: Option<PathBuf>,
}

fn parse(arguments: &[String]) -> Result<Options, String> {
    let mut iterator = arguments.iter();
    let command = iterator.next().ok_or_else(|| return USAGE.to_string())?.clone();
    let payload = iterator.next().ok_or_else(|| return USAGE.to_string())?.clone();
    let mut options = Options {
        command,
        payload: PathBuf::from(payload),
        known_gaps: None,
        out: None,
        manifest: None,
    };
    while let Some(flag) = iterator.next() {
        let value = iterator
            .next()
            .ok_or_else(|| return format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--known-gaps" => options.known_gaps = Some(PathBuf::from(value)),
            "--out" => options.out = Some(PathBuf::from(value)),
            "--manifest" => options.manifest = Some(PathBuf::from(value)),
            other => return Err(format!("unknown flag {other}\n\n{USAGE}")),
        }
    }
    return Ok(options);
}

/// `source<TAB>target` per line; `#` comments and blank lines ignored.
fn read_known_gaps(path: &Path) -> Result<BTreeSet<(String, String)>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| return format!("cannot read {}: {error}", path.display()))?;
    let mut gaps = BTreeSet::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (source, target) = trimmed
            .split_once('\t')
            .ok_or_else(|| return format!("{}: expected 'source<TAB>target', got {trimmed:?}", path.display()))?;
        gaps.insert((source.trim().to_string(), target.trim().to_string()));
    }
    return Ok(gaps);
}

fn validate(options: &Options) -> Result<i32, String> {
    let loaded = Payload::read(&options.payload)?;
    let known = match &options.known_gaps {
        Some(path) => read_known_gaps(path)?,
        None => BTreeSet::new(),
    };

    println!(
        "ores-lint-pack validate :: {} (v{}, {} managed files)",
        options.payload.display(),
        loaded.version(),
        loaded.managed().len()
    );

    if loaded.file("VERSION").is_none() {
        println!("  FAIL - payload carries no VERSION file");
        return Ok(1);
    }

    let mut failures = 0;
    let mut satisfied_gaps = Vec::new();
    for reference in loaded.unresolved() {
        let key = (reference.from.clone(), reference.target.clone());
        let lines = reference
            .lines
            .iter()
            .map(|line| return line.to_string())
            .collect::<Vec<_>>()
            .join(",");
        if known.contains(&key) {
            println!(
                "  known - {} references {} (line {lines}) - recorded gap, not yet shipped",
                reference.from, reference.target
            );
            continue;
        }
        println!(
            "  FAIL  - {} references {} (line {lines}) but the payload does not carry it",
            reference.from, reference.target
        );
        failures += 1;
    }

    let unresolved: BTreeSet<(String, String)> = loaded
        .unresolved()
        .into_iter()
        .map(|reference| return (reference.from, reference.target))
        .collect();
    for gap in &known {
        if !unresolved.contains(gap) {
            satisfied_gaps.push(gap.clone());
        }
    }
    for (source, target) in &satisfied_gaps {
        println!("  stale - known gap {source} -> {target} now resolves; delete the entry");
    }

    for reference in loaded.references() {
        if reference.required || loaded.contains(&reference.target) {
            continue;
        }
        println!(
            "  note  - {} references {} but guards it; absent by design",
            reference.from, reference.target
        );
    }

    let resolved = loaded
        .references()
        .into_iter()
        .filter(|reference| return loaded.contains(&reference.target))
        .count();
    println!("  ok    - {resolved} intra-payload references resolve");

    if failures == 0 {
        println!("payload is self-consistent");
        return Ok(0);
    }
    println!("payload is NOT self-consistent ({failures} unresolved)");
    return Ok(1);
}

fn escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other if (other as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", other as u32)),
            other => escaped.push(other),
        }
    }
    return escaped;
}

struct Entry {
    path: String,
    bytes: usize,
    executable: bool,
    digest: String,
}

fn entries(files: &[&PayloadFile]) -> Vec<Entry> {
    return files
        .iter()
        .map(|file| {
            return Entry {
                path: file.path.clone(),
                bytes: file.bytes.len(),
                executable: file.executable,
                digest: sha256::hex_digest(&file.bytes),
            };
        })
        .collect();
}

/// One digest for the whole file set: sha256 over `digest mode path` lines.
fn payload_digest(entries: &[Entry]) -> String {
    let mut canonical = String::new();
    for entry in entries {
        let mode = if entry.executable { "755" } else { "644" };
        canonical.push_str(&format!("{} {mode} {}\n", entry.digest, entry.path));
    }
    return sha256::hex_digest(canonical.as_bytes());
}

fn render_manifest(loaded: &Payload) -> String {
    let managed = loaded.managed();
    let listed = entries(&managed);
    let digest = payload_digest(&listed);
    let unmanaged: Vec<String> = loaded
        .files
        .iter()
        .filter(|file| return !is_managed(&file.path))
        .map(|file| return file.path.clone())
        .collect();

    let mut text = String::new();
    text.push_str("{\n");
    text.push_str(&format!("  \"schema\": \"{MANIFEST_SCHEMA}\",\n"));
    text.push_str(&format!("  \"version\": \"{}\",\n", escape(&loaded.version())));
    text.push_str(&format!("  \"payload_digest\": \"{digest}\",\n"));
    text.push_str(&format!("  \"file_count\": {},\n", listed.len()));
    text.push_str("  \"files\": [\n");
    for (index, entry) in listed.iter().enumerate() {
        let comma = if index + 1 == listed.len() { "" } else { "," };
        text.push_str(&format!(
            "    {{ \"path\": \"{}\", \"bytes\": {}, \"executable\": {}, \"sha256\": \"{}\" }}{comma}\n",
            escape(&entry.path),
            entry.bytes,
            entry.executable,
            entry.digest
        ));
    }
    text.push_str("  ],\n");
    text.push_str("  \"unmanaged\": [");
    text.push_str(
        &unmanaged
            .iter()
            .map(|path| return format!("\"{}\"", escape(path)))
            .collect::<Vec<_>>()
            .join(", "),
    );
    text.push_str("]\n}\n");
    return text;
}

fn manifest(options: &Options) -> Result<i32, String> {
    let loaded = Payload::read(&options.payload)?;
    if !loaded.unresolved().is_empty() {
        eprintln!("refusing to emit a manifest for a payload that is not self-consistent; run validate");
        return Ok(1);
    }
    let text = render_manifest(&loaded);
    match &options.out {
        Some(path) => {
            std::fs::write(path, &text)
                .map_err(|error| return format!("cannot write {}: {error}", path.display()))?;
            println!("wrote {}", path.display());
        }
        None => print!("{text}"),
    }
    return Ok(0);
}

/// Minimal reader for the manifests this tool writes: `"path"` / `"sha256"`
/// pairs. Deliberately not a general JSON parser - it only has to read back
/// what `render_manifest` emitted.
fn read_manifest(path: &Path) -> Result<(String, Vec<(String, String)>), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| return format!("cannot read {}: {error}", path.display()))?;
    let field = |line: &str, key: &str| -> Option<String> {
        let marker = format!("\"{key}\": \"");
        let start = line.find(&marker)? + marker.len();
        let end = line[start..].find('"')? + start;
        return Some(line[start..end].to_string());
    };
    let mut version = String::new();
    let mut files = Vec::new();
    for line in text.lines() {
        if line.contains("\"version\"") && version.is_empty() {
            if let Some(value) = field(line, "version") {
                version = value;
            }
            continue;
        }
        if let (Some(entry), Some(digest)) = (field(line, "path"), field(line, "sha256")) {
            files.push((entry, digest));
        }
    }
    if files.is_empty() {
        return Err(format!("{}: no file entries found", path.display()));
    }
    return Ok((version, files));
}

fn verify(options: &Options) -> Result<i32, String> {
    let manifest_path = options
        .manifest
        .as_ref()
        .ok_or_else(|| return "verify needs --manifest <file>".to_string())?;
    let (version, expected) = read_manifest(manifest_path)?;
    let loaded = Payload::read(&options.payload)?;

    println!(
        "ores-lint-pack verify :: {} against {}",
        options.payload.display(),
        manifest_path.display()
    );

    let mut failures = 0;
    if !version.is_empty() && version != loaded.version() {
        println!(
            "  FAIL  - version mismatch: manifest {version}, payload {}",
            loaded.version()
        );
        failures += 1;
    }

    let mut seen = BTreeSet::new();
    for (path, digest) in &expected {
        seen.insert(path.clone());
        match loaded.file(path) {
            None => {
                println!("  FAIL  - missing {path}");
                failures += 1;
            }
            Some(file) => {
                let actual = sha256::hex_digest(&file.bytes);
                if &actual == digest {
                    continue;
                }
                println!("  FAIL  - {path} content differs (expected {digest}, got {actual})");
                failures += 1;
            }
        }
    }
    for file in loaded.managed() {
        if seen.contains(&file.path) {
            continue;
        }
        println!("  FAIL  - unexpected managed file {}", file.path);
        failures += 1;
    }

    if failures == 0 {
        println!("  ok    - {} files match", expected.len());
        println!("payload matches the manifest");
        return Ok(0);
    }
    println!("payload does NOT match the manifest ({failures} problems)");
    return Ok(1);
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse(&arguments) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let outcome = match options.command.as_str() {
        "validate" => validate(&options),
        "manifest" => manifest(&options),
        "verify" => verify(&options),
        other => Err(format!("unknown command {other}\n\n{USAGE}")),
    };
    return match outcome {
        Ok(0) => ExitCode::SUCCESS,
        Ok(code) => ExitCode::from(code as u8),
        Err(message) => {
            eprintln!("ores-lint-pack: {message}");
            ExitCode::from(2)
        }
    };
}
