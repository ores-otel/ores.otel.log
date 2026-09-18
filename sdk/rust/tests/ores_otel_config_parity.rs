//! Cross-language `.ores-otel.toml` parity: every fixture case under
//! `tests/fixtures/ores-otel-config/` is parsed and resolved by the Rust loader
//! and compared to the shared expected JSON (numbers compare numerically).
//! `tests/fixtures/ores-otel-apm-disk-pressure.json` pins the
//! `ores.apm.resource.pressure` disk series shared with TypeScript and Dart.

use next_loggers::apm::{
    evaluate_resource_snapshot, resource_metric_points, FilesystemSnapshot, MetricKind,
    ResourceSnapshot, ResourceThresholds, METRIC_RESOURCE_PRESSURE,
};
use next_loggers::config::{
    ores_otel_config_file_path, parse_ores_otel_toml, parse_toml, resolve_ores_otel_config,
    OresOtelConfigError, ResolveOptions, ResolvedOresOtelConfig, RuntimeRole, TomlValue,
    ORES_OTEL_ENV_VARS,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const MINIMUM_CASES: usize = 18;
const MINIMUM_LOOKUP_CASES: usize = 9;

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

/// `tests/fixtures/ores-otel-config-lookup.json`: the file-lookup order shared
/// with the TypeScript and Dart loaders.
#[test]
fn every_ores_otel_config_lookup_case_matches() {
    let corpus: Value = serde_json::from_str(&read(
        &repo_root().join("tests/fixtures/ores-otel-config-lookup.json"),
    ))
    .expect("lookup corpus is JSON");
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= MINIMUM_LOOKUP_CASES,
        "expected at least {MINIMUM_LOOKUP_CASES} lookup cases, found {}",
        cases.len()
    );
    let optional_path = |case: &Value, field: &str| case[field].as_str().map(PathBuf::from);
    let failures = cases
        .iter()
        .filter_map(|case| {
            let env = string_map(case, "env")
                .into_iter()
                .chain(string_map(case, "flag_overrides"))
                .collect::<BTreeMap<_, _>>();
            let actual = ores_otel_config_file_path(
                optional_path(case, "file_path").as_deref(),
                optional_path(case, "cwd").as_deref(),
                &env,
                Path::new(
                    case["current_directory"]
                        .as_str()
                        .expect("current_directory"),
                ),
            );
            let expected = case["expected"].as_str().expect("expected");
            (actual != Path::new(expected)).then(|| {
                format!(
                    "{}: {} != {expected}",
                    case["name"].as_str().unwrap_or("?"),
                    actual.display()
                )
            })
        })
        .collect::<Vec<_>>();
    assert!(
        failures.is_empty(),
        "lookup mismatches:\n{}",
        failures.join("\n")
    );
}

#[test]
fn table_headers_may_appear_once_but_implicit_parents_may_be_defined() {
    assert!(parse_toml("[a]\nx = 1\n[a]\ny = 2\n").is_err());
    assert!(parse_toml("[a.b]\nx = 1\n[a.b]\ny = 2\n").is_err());
    assert!(parse_toml("[a.b]\nx = 1\n[a]\ny = 2\n").is_ok());
    assert!(parse_ores_otel_toml("version = 1.0\n").is_err());
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

const MINIMUM_DISK_PRESSURE_CASES: usize = 6;

fn optional_u64(value: &Value, field: &str) -> Option<u64> {
    value.get(field).map(|raw| {
        raw.as_u64()
            .unwrap_or_else(|| panic!("{field} must be a non-negative integer"))
    })
}

fn optional_f64(value: &Value, field: &str) -> Option<f64> {
    value.get(field).map(|raw| {
        raw.as_f64()
            .unwrap_or_else(|| panic!("{field} must be a number"))
    })
}

/// Mirrors how `sample_filesystem` derives ratios: a ratio with a zero or
/// unknown denominator is not a measurement.
fn filesystem_from_fixture(measurement: &Value) -> FilesystemSnapshot {
    let capacity_bytes = optional_u64(measurement, "capacity_bytes").expect("capacity_bytes");
    let available_bytes = optional_u64(measurement, "available_bytes").expect("available_bytes");
    let inode_total = optional_u64(measurement, "total_inodes");
    let inode_free = optional_u64(measurement, "available_inodes");
    FilesystemSnapshot {
        path: PathBuf::from(measurement["path"].as_str().expect("path")),
        capacity_bytes,
        free_bytes: available_bytes,
        available_bytes,
        free_ratio: if capacity_bytes == 0 {
            0.0
        } else {
            available_bytes as f64 / capacity_bytes as f64
        },
        inode_total: inode_total.unwrap_or(0),
        inode_free: inode_free.unwrap_or(0),
        inode_free_ratio: match (inode_free, inode_total) {
            (Some(free), Some(total)) if total > 0 => Some(free as f64 / total as f64),
            _ => None,
        },
    }
}

#[test]
fn every_disk_pressure_series_matches() {
    let corpus: Value = serde_json::from_str(&read(
        &repo_root().join("tests/fixtures/ores-otel-apm-disk-pressure.json"),
    ))
    .expect("disk-pressure corpus is JSON");
    assert_eq!(corpus["metric"], METRIC_RESOURCE_PRESSURE);
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= MINIMUM_DISK_PRESSURE_CASES,
        "expected at least {MINIMUM_DISK_PRESSURE_CASES} disk-pressure cases, found {}",
        cases.len()
    );
    let failures = cases
        .iter()
        .filter_map(|case| {
            let name = case["name"].as_str().unwrap_or("?");
            let thresholds = &case["thresholds"];
            let snapshot = ResourceSnapshot {
                filesystems: vec![filesystem_from_fixture(&case["measurement"])],
                ..ResourceSnapshot::default()
            };
            let health = evaluate_resource_snapshot(
                &snapshot,
                &ResourceThresholds {
                    max_rss_bytes: None,
                    min_free_bytes: optional_u64(thresholds, "min_free_bytes"),
                    min_free_ratio: optional_f64(thresholds, "min_free_ratio"),
                    min_inode_free_ratio: optional_f64(thresholds, "min_inode_free_ratio"),
                },
            );
            let series = resource_metric_points(&snapshot, &health)
                .into_iter()
                .filter(|point| point.name == METRIC_RESOURCE_PRESSURE)
                .map(|point| {
                    assert_eq!(point.unit, corpus["unit"].as_str().expect("unit"));
                    assert_eq!(point.kind, MetricKind::Gauge);
                    serde_json::json!({
                        "value": point.value,
                        "attributes": point
                            .attributes
                            .iter()
                            .map(|(key, value)| ((*key).to_owned(), Value::String(value.clone())))
                            .collect::<serde_json::Map<_, _>>(),
                    })
                })
                .collect::<Vec<_>>();
            json_matches(&Value::Array(series), &case["expected"], "$")
                .err()
                .map(|diff| format!("{name}: {diff}"))
        })
        .collect::<Vec<_>>();
    assert!(
        failures.is_empty(),
        "disk-pressure mismatches:\n{}",
        failures.join("\n")
    );
}
