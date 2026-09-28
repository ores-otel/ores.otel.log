//! Reading a `.ores-lint/` payload and working out what it references.
//!
//! The toolkit is distributed by copying this directory into a consumer
//! repository, so every path it names at runtime has to be a path it carries.
//! Two kinds of reference matter:
//!
//!   * shell scripts addressing a sibling as `"$DIR/<path>"`, where `DIR` is the
//!     payload root the script computes from `dirname "$0"`;
//!   * ES modules importing a sibling with a relative specifier.
//!
//! A reference the script itself existence-tests anywhere (`[ -f … ]`, `[ -d … ]`,
//! directly or through a variable) is optional: the guard is the author saying the
//! payload degrades when that file is absent, and uses inside the guarded branch
//! are covered by it. Anything else is required.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// Directory names never carried by a payload: local installs and build output.
const SKIPPED_DIRECTORIES: [&str; 4] = ["node_modules", "target", ".git", "dist"];

/// Files that live inside a payload directory but are not distributed with it.
/// `local.sh` is the documented per-repository override the rollout must never
/// overwrite; `test-tools/` is a local, optional node install.
const UNMANAGED: [&str; 2] = ["local.sh", "test-tools/"];

const TEST_OPERATORS: [&str; 6] = ["-f", "-d", "-e", "-r", "-s", "-x"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// Payload-relative path of the file making the reference.
    pub from: String,
    /// Payload-relative path being referenced.
    pub target: String,
    /// `false` when the referring file existence-tests the target somewhere.
    pub required: bool,
    /// 1-based line numbers of each occurrence, for a useful error.
    pub lines: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct PayloadFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub executable: bool,
}

#[derive(Debug)]
pub struct Payload {
    pub files: Vec<PayloadFile>,
    pub directories: BTreeSet<String>,
}

pub fn is_managed(path: &str) -> bool {
    return !UNMANAGED
        .iter()
        .any(|entry| return path == *entry || path.starts_with(entry));
}

fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    return parts.join("/");
}

fn walk(root: &Path, prefix: &str, files: &mut Vec<PayloadFile>, dirs: &mut BTreeSet<String>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(root.join(prefix))
        .map_err(|error| return format!("cannot read {}/{prefix}: {error}", root.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| return format!("cannot read {}/{prefix}: {error}", root.display()))?;
    entries.sort_by_key(|entry| return entry.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry
            .file_type()
            .map_err(|error| return format!("cannot stat {relative}: {error}"))?;
        if kind.is_dir() {
            dirs.insert(relative.clone());
            if SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            walk(root, &relative, files, dirs)?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let bytes = fs::read(entry.path())
            .map_err(|error| return format!("cannot read {relative}: {error}"))?;
        let executable = executable_bit(&entry.path());
        files.push(PayloadFile {
            path: relative,
            bytes,
            executable,
        });
    }
    return Ok(());
}

#[cfg(unix)]
fn executable_bit(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    return fs::metadata(path).is_ok_and(|meta| return meta.permissions().mode() & 0o111 != 0);
}

#[cfg(not(unix))]
fn executable_bit(_path: &Path) -> bool {
    return false;
}

impl Payload {
    pub fn read(root: &Path) -> Result<Self, String> {
        if !root.is_dir() {
            return Err(format!("{} is not a directory", root.display()));
        }
        let mut files = Vec::new();
        let mut directories = BTreeSet::new();
        walk(root, "", &mut files, &mut directories)?;
        files.sort_by(|left, right| return left.path.cmp(&right.path));
        return Ok(Self {
            files,
            directories,
        });
    }

    pub fn version(&self) -> String {
        return self
            .file("VERSION")
            .map(|file| {
                return String::from_utf8_lossy(&file.bytes).trim().to_string();
            })
            .filter(|value| return !value.is_empty())
            .unwrap_or_else(|| return "unknown".to_string());
    }

    pub fn file(&self, path: &str) -> Option<&PayloadFile> {
        return self.files.iter().find(|file| return file.path == path);
    }

    pub fn managed(&self) -> Vec<&PayloadFile> {
        return self
            .files
            .iter()
            .filter(|file| return is_managed(&file.path))
            .collect();
    }

    pub fn contains(&self, path: &str) -> bool {
        return self.file(path).is_some() || self.directories.contains(path);
    }

    /// Every intra-payload reference, deduplicated by (source file, target).
    pub fn references(&self) -> Vec<Reference> {
        let mut found: BTreeMap<(String, String), (bool, Vec<usize>)> = BTreeMap::new();
        for file in &self.files {
            if !is_managed(&file.path) {
                continue;
            }
            let text = String::from_utf8_lossy(&file.bytes);
            let occurrences = if file.path.ends_with(".sh") || looks_like_shell(&text) {
                shell_references(&text)
            } else if file.path.ends_with(".mjs") || file.path.ends_with(".js") {
                module_references(&file.path, &text)
            } else {
                Vec::new()
            };
            for (target, line, guarded) in occurrences {
                let entry = found
                    .entry((file.path.clone(), target))
                    .or_insert((false, Vec::new()));
                entry.0 = entry.0 || guarded;
                entry.1.push(line);
            }
        }
        return found
            .into_iter()
            .map(|((from, target), (guarded, lines))| {
                return Reference {
                    from,
                    target,
                    required: !guarded,
                    lines,
                };
            })
            .collect();
    }

    /// Required references that the payload does not carry.
    pub fn unresolved(&self) -> Vec<Reference> {
        return self
            .references()
            .into_iter()
            .filter(|reference| return reference.required && !self.contains(&reference.target))
            .collect();
    }
}

fn looks_like_shell(text: &str) -> bool {
    return text.starts_with("#!/bin/sh") || text.starts_with("#!/usr/bin/env sh") || text.starts_with("#!/bin/bash");
}

fn path_character(value: char) -> bool {
    return value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-' | '/');
}

/// Variables assigned from `dirname "$0"`, i.e. the payload root.
fn root_variables(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.contains("dirname") || !trimmed.contains("$0") {
            continue;
        }
        if let Some((name, _)) = trimmed.split_once('=') {
            if !name.is_empty() && name.chars().all(|value| return value.is_ascii_alphanumeric() || value == '_') {
                names.insert(name.to_string());
            }
        }
    }
    return names;
}

fn guarded_at(line: &str, index: usize) -> bool {
    let prefix = &line[..index];
    return TEST_OPERATORS.iter().any(|operator| {
        let needle = format!(" {operator} ");
        return prefix.contains(&needle) && (prefix.contains('[') || prefix.contains("test "));
    });
}

/// Returns `(target, line number, guarded)` for each `$ROOT/<path>` occurrence.
fn shell_references(text: &str) -> Vec<(String, usize, bool)> {
    let roots = root_variables(text);
    if roots.is_empty() {
        return Vec::new();
    }
    // (target, line, guarded, variable the occurrence was assigned to)
    let mut occurrences: Vec<(String, usize, bool, Option<String>)> = Vec::new();

    for (number, line) in text.lines().enumerate() {
        for root in &roots {
            for form in [format!("${root}/"), format!("${{{root}}}/")] {
                let mut search = 0usize;
                while let Some(offset) = line[search..].find(&form) {
                    let start = search + offset;
                    let tail = start + form.len();
                    let target: String = line[tail..].chars().take_while(|value| return path_character(*value)).collect();
                    search = tail.max(search + 1);
                    if target.is_empty() {
                        continue;
                    }
                    let target = normalize(&target);
                    if target.is_empty() {
                        continue;
                    }
                    let guarded = guarded_at(line, start);
                    let assigned = assigned_variable(line, start);
                    occurrences.push((target, number + 1, guarded, assigned));
                }
            }
        }
    }

    // A reference captured in a variable counts as guarded only if that variable
    // is existence-tested somewhere in the same script.
    for occurrence in occurrences.iter_mut() {
        let Some(name) = occurrence.3.clone() else {
            continue;
        };
        occurrence.2 = text.lines().any(|line| {
            return TEST_OPERATORS.iter().any(|operator| {
                return line.contains(&format!("{operator} \"${name}\""))
                    || line.contains(&format!("{operator} ${name}"))
                    || line.contains(&format!("{operator} \"${{{name}}}\""));
            });
        });
    }
    return occurrences
        .into_iter()
        .map(|(target, line, guarded, _)| return (target, line, guarded))
        .collect();
}

/// `NAME="$DIR/x"` - the variable the reference at `index` is assigned to.
fn assigned_variable(line: &str, index: usize) -> Option<String> {
    let prefix = line[..index].trim_start();
    let (name, rest) = prefix.split_once('=')?;
    if name.is_empty() || !name.chars().all(|value| return value.is_ascii_alphanumeric() || value == '_') {
        return None;
    }
    if rest.trim_start_matches('"').trim_start_matches('\'').is_empty() {
        return Some(name.to_string());
    }
    return None;
}

fn module_references(from: &str, text: &str) -> Vec<(String, usize, bool)> {
    let directory = match from.rsplit_once('/') {
        Some((head, _)) => head.to_string(),
        None => String::new(),
    };
    let mut occurrences = Vec::new();
    for (number, line) in text.lines().enumerate() {
        for quote in ['\'', '"'] {
            let mut search = 0usize;
            while let Some(offset) = line[search..].find(quote) {
                let start = search + offset + 1;
                let end = match line[start..].find(quote) {
                    Some(value) => start + value,
                    None => break,
                };
                search = end + 1;
                let specifier = &line[start..end];
                if !specifier.starts_with("./") && !specifier.starts_with("../") {
                    continue;
                }
                let before = line[..start - 1].trim_end();
                if !before.ends_with("from")
                    && !before.ends_with("import")
                    && !before.ends_with("import(")
                    && !before.ends_with("require(")
                {
                    continue;
                }
                let joined = if directory.is_empty() {
                    specifier.to_string()
                } else {
                    format!("{directory}/{specifier}")
                };
                let target = normalize(&joined);
                if !target.is_empty() {
                    occurrences.push((target, number + 1, false));
                }
            }
        }
    }
    return occurrences;
}
