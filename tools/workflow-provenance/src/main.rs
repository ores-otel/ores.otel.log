#![allow(
    clippy::needless_return,
    reason = "Shared policy requires explicit Rust returns."
)]

use serde_yaml::{Mapping, Value};
use std::io::Read;
use std::path::{Component, Path};

const MAX_BYTES: u64 = 1_048_576;

fn mapping<'a>(value: &'a Value, location: &str) -> Result<&'a Mapping, String> {
    return value
        .as_mapping()
        .ok_or_else(|| format!("{location}: expected a mapping"));
}

fn immutable(target: &str) -> bool {
    if target.is_empty() || target.chars().any(char::is_whitespace) {
        return false;
    }
    if let Some(local) = target.strip_prefix("./") {
        return !local.is_empty()
            && Path::new(local)
                .components()
                .all(|part| matches!(part, Component::Normal(_)));
    }
    if let Some(image) = target.strip_prefix("docker://") {
        return image.split_once("@sha256:").is_some_and(|(name, digest)| {
            return !name.is_empty()
                && !name.contains('@')
                && digest.len() == 64
                && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
        });
    }
    return target.rsplit_once('@').is_some_and(|(name, revision)| {
        return name.split('/').count() >= 2
            && name.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            })
            && revision.len() == 40
            && revision.bytes().all(|byte| byte.is_ascii_hexdigit());
    });
}

fn check_uses(object: &Mapping, location: &str) -> Result<(), String> {
    if let Some(value) = object.get(Value::String("uses".into())) {
        let target = value
            .as_str()
            .ok_or_else(|| format!("{location}.uses: expected a string"))?;
        if !immutable(target) {
            // Do not print arbitrary workflow values; a malformed value may be sensitive.
            return Err(format!(
                "{location}.uses: expected a local action, full commit SHA, or container digest"
            ));
        }
    }
    return Ok(());
}

fn validate(source: &str) -> Result<(), String> {
    if source.len() > MAX_BYTES as usize {
        return Err("workflow exceeds the one MiB input limit".into());
    }
    let mut workflow: Value = serde_yaml::from_str(source)
        .map_err(|error| format!("invalid YAML at {:?}", error.location()))?;
    workflow
        .apply_merge()
        .map_err(|_| "invalid YAML merge mapping".to_string())?;
    mapping(&workflow, "workflow")?;
    let jobs = mapping(
        workflow.get("jobs").ok_or("workflow: missing jobs")?,
        "jobs",
    )?;
    if jobs.is_empty() {
        return Err("workflow: jobs must not be empty".into());
    }
    for (index, (_, job)) in jobs.iter().enumerate() {
        let location = format!("jobs[{index}]");
        let job = mapping(job, &location)?;
        check_uses(job, &location)?;
        if let Some(steps) = job.get(Value::String("steps".into())) {
            let steps = steps
                .as_sequence()
                .ok_or_else(|| format!("{location}.steps: expected a sequence"))?;
            for (index, step) in steps.iter().enumerate() {
                let location = format!("{location}.steps[{index}]");
                check_uses(mapping(step, &location)?, &location)?;
            }
        }
    }
    return Ok(());
}

fn validate_path(raw: &str) -> Result<(), String> {
    let path = Path::new(raw);
    let parts = path.components().collect::<Vec<_>>();
    if parts.len() != 3
        || !path.starts_with(".github/workflows")
        || parts
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
        || !matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("yml" | "yaml")
        )
    {
        return Err("expected a direct .github/workflows YAML path".into());
    }
    let mut current = std::path::PathBuf::new();
    for part in parts {
        current.push(part);
        if std::fs::symlink_metadata(&current)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("workflow paths must not traverse symlinks".into());
        }
    }
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("workflow must be a regular file no larger than one MiB".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let source = std::str::from_utf8(&bytes).map_err(|_| "workflow must be UTF-8")?;
    return validate(source);
}

fn run() -> Result<(), String> {
    // A NUL-delimited Git file list on stdin is the only input: no public CLI options.
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES as usize || (!bytes.is_empty() && bytes.last() != Some(&0)) {
        return Err("expected a bounded NUL-terminated Git file list".into());
    }
    let paths = if bytes.is_empty() {
        Vec::new()
    } else {
        bytes[..bytes.len() - 1]
            .split(|byte| *byte == 0)
            .collect::<Vec<_>>()
    };
    if paths.len() > 1024 {
        return Err("too many workflow paths".into());
    }
    for (index, raw) in paths.iter().enumerate() {
        let path = std::str::from_utf8(raw).map_err(|_| "workflow path must be UTF-8")?;
        validate_path(path).map_err(|error| format!("workflow[{index}]: {error}"))?;
    }
    println!(
        "immutable dependencies verified in {} touched workflow(s)",
        paths.len()
    );
    return Ok(());
}

fn main() -> std::process::ExitCode {
    return match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mutable_actions_in_block_flow_and_quoted_keys() {
        for source in [
            "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7\n",
            "jobs: {test: {steps: [{uses: actions/checkout@v7}]}}",
            "jobs: {test: {steps: [{'uses': 'actions/checkout@v7'}]}}",
            "jobs: {test: {uses: owner/repo/.github/workflows/test.yml@main}}",
            "jobs: {test: {steps: [{uses: 'docker://alpine:latest'}]}}",
        ] {
            assert!(validate(source).is_err(), "accepted {source}");
        }
    }

    #[test]
    fn accepts_quoted_immutable_local_and_container_references() {
        let source = format!("jobs: {{test: {{steps: [{{'uses': 'actions/checkout@{}'}}, {{uses: './actions/check'}}, {{uses: 'docker://alpine@sha256:{}'}}]}}}}", "a".repeat(40), "b".repeat(64));
        assert!(validate(&source).is_ok());
        assert!(validate(&format!(
            "jobs: {{test: {{uses: owner/repo/.github/workflows/test.yml@{}}}}}",
            "a".repeat(40)
        ))
        .is_ok());
    }

    #[test]
    fn aliases_and_merge_keys_cannot_hide_mutable_actions() {
        assert!(validate(
            "jobs:\n  test:\n    steps:\n      - &bad {uses: actions/checkout@v7}\n      - *bad\n"
        )
        .is_err());
        assert!(validate("defaults: &bad {uses: actions/checkout@v7}\njobs:\n  test:\n    steps:\n      - <<: *bad\n").is_err());
    }

    #[test]
    fn rejects_duplicate_keys_and_malformed_or_non_string_uses() {
        for source in [
            "jobs: {test: {steps: [{uses: actions/checkout@v7, uses: ./safe}]}}",
            "jobs: {test: {steps: [{uses: 123}]}}",
            "jobs: {test: {steps: [{uses: null}]}}",
            "jobs: {test: {steps: [{uses: [./safe]}]}}",
            "jobs: {test: {steps: [{uses: ./safe}]}",
            "jobs: {}",
            "jobs: []",
            "jobs: {test: {steps: false}}",
            "name: no-jobs",
        ] {
            assert!(validate(source).is_err(), "accepted {source}");
        }
    }

    #[test]
    fn run_text_and_comments_are_not_action_references() {
        assert!(validate("jobs:\n  test:\n    steps:\n      - run: |\n          uses: actions/example@main\n          echo hello\n        # uses: actions/comment@main\n").is_ok());
    }

    #[test]
    fn rejects_invalid_reference_identities() {
        for target in [
            "./",
            "./../outside",
            "/outside",
            "actions/checkout@main",
            "actions/checkout@",
            "owner/repo@abc",
            "docker://@sha256:",
            "${{ env.ACTION }}",
        ] {
            assert!(!immutable(target));
        }
    }

    #[test]
    fn oversized_workflows_and_outside_paths_are_rejected() {
        assert!(validate(&" ".repeat(MAX_BYTES as usize + 1)).is_err());
        for path in [
            "../outside.yml",
            ".github/workflows/../outside.yml",
            ".github/workflows/nested/check.yml",
            ".github/workflows/check.json",
        ] {
            assert!(validate_path(path).is_err());
        }
    }
}
