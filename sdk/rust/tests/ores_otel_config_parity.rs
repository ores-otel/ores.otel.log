//! Cross-language `.ores-otel.toml` parity: every fixture case under
//! `tests/fixtures/ores-otel-config/` is parsed and resolved by the Rust loader
//! and compared to the shared expected JSON (numbers compare numerically).

use next_loggers::config::{
    parse_ores_otel_toml, parse_toml, resolve_ores_otel_config, OresOtelConfigError,
    ResolveOptions, ResolvedOresOtelConfig, RuntimeRole, TomlValue, ORES_OTEL_ENV_VARS,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const MINIMUM_CASES: usize = 14;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn string_map(value: &Value, field: &str) -> BTreeMap<String, String> {
    match value.get(field) {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(key, value)| {
                let text = value
                    .as_str()
                    .unwrap_or_else(|| panic!("{field}.{key} must be a string"));
                (key.clone(), text.to_owned())
            })
            .collect(),
        Some(other) => panic!("{field} must be an object, got {other}"),
    }
}

fn resolve_options(options: &Value) -> ResolveOptions {
    let role = match options.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(role)) => {
            Some(RuntimeRole::parse(role).unwrap_or_else(|| panic!("bad fixture role {role}")))
        }
        Some(other) => panic!("role must be null or a string, got {other}"),
    };
    ResolveOptions {
        role,
        env: string_map(options, "env"),
        flag_overrides: string_map(options, "flag_overrides"),
        overrides: None,
    }
}

fn load_case(dir: &Path) -> Result<ResolvedOresOtelConfig, OresOtelConfigError> {
    let options: Value =
        serde_json::from_str(&read(&dir.join("options.json"))).expect("options.json is JSON");
    let parsed = parse_ores_otel_toml(&read(&dir.join("input.toml")))?;
    resolve_ores_otel_config(&parsed, &resolve_options(&options))
}

/// Structural JSON equality where numbers compare as f64 (so `1` == `1.0`).
fn json_matches(actual: &Value, expected: &Value, path: &str) -> Result<(), String> {
    match (actual, expected) {
        (Value::Number(a), Value::Number(e)) => {
            let (a, e) = (a.as_f64(), e.as_f64());
            if a.is_some() && a == e {
                Ok(())
            } else {
                Err(format!("{path}: {a:?} != {e:?}"))
            }
        }
        (Value::Array(a), Value::Array(e)) => {
            if a.len() != e.len() {
                return Err(format!("{path}: length {} != {}", a.len(), e.len()));
            }
            a.iter()
                .zip(e)
                .enumerate()
                .try_for_each(|(index, (a, e))| json_matches(a, e, &format!("{path}[{index}]")))
        }
        (Value::Object(a), Value::Object(e)) => {
            let actual_keys = a.keys().collect::<BTreeSet<_>>();
            let expected_keys = e.keys().collect::<BTreeSet<_>>();
            if actual_keys != expected_keys {
                return Err(format!(
                    "{path}: keys {actual_keys:?} != expected {expected_keys:?}"
                ));
            }
            e.iter().try_for_each(|(key, e)| {
                json_matches(&a[key.as_str()], e, &format!("{path}.{key}"))
            })
        }
        (a, e) if a == e => Ok(()),
        (a, e) => Err(format!("{path}: {a} != {e}")),
    }
}

#[test]
fn every_ores_otel_config_fixture_matches() {
    let fixtures = repo_root().join("tests/fixtures/ores-otel-config");
    let cases = std::fs::read_dir(&fixtures)
        .unwrap_or_else(|error| panic!("read {}: {error}", fixtures.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<BTreeSet<_>>();
    assert!(
        cases.len() >= MINIMUM_CASES,
        "expected at least {MINIMUM_CASES} fixture cases, found {}",
        cases.len()
    );

    let failures = cases
        .iter()
        .filter_map(|dir| {
            let name = dir
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let expected: Value = serde_json::from_str(&read(&dir.join("expected.json")))
                .expect("expected.json is JSON");
            let expects_error = expected.get("error") == Some(&Value::Bool(true));
            match (load_case(dir), expects_error) {
                (Err(_), true) => None,
                (Ok(config), true) => Some(format!(
                    "{name}: expected an error, resolved {}",
                    config.to_json_value()
                )),
                (Err(error), false) => Some(format!("{name}: unexpected error: {error}")),
                (Ok(config), false) => json_matches(&config.to_json_value(), &expected, "$")
                    .err()
                    .map(|diff| format!("{name}: {diff}")),
            }
        })
        .collect::<Vec<_>>();
    assert!(
        failures.is_empty(),
        "fixture mismatches:\n{}",
        failures.join("\n")
    );
}

#[test]
fn loader_env_names_match_flags_2_env_contract() {
    let contract = parse_toml(&read(
        &repo_root().join("contracts/ores-otel.cli-flags.toml"),
    ))
    .expect("cli-flags contract parses with the strict reader");
    let Some(TomlValue::Table(flags)) = contract.get("flags") else {
        panic!("contract has no [flags] table");
    };
    let declared = flags
        .iter()
        .map(|(flag, table)| match table {
            TomlValue::Table(table) => match table.get("env") {
                Some(TomlValue::String(env)) => env.clone(),
                _ => panic!("flags.{flag}.env must be a string"),
            },
            _ => panic!("flags.{flag} must be a table"),
        })
        .collect::<BTreeSet<_>>();
    let honoured = ORES_OTEL_ENV_VARS
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(declared, honoured);
    assert_eq!(
        honoured.len(),
        ORES_OTEL_ENV_VARS.len(),
        "duplicate env names"
    );
}
