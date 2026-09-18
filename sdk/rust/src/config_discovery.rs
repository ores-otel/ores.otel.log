#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

use crate::config::{
    load_ores_otel_config, LoadOptions, LoadedOresOtelConfig, OresOtelConfigError,
    ORES_OTEL_CONFIG_BASENAME,
};
use crate::{json, LogLevel, Logger, Options};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredOresOtelConfig {
    pub path: PathBuf,
    pub at_repository_root: bool,
}

fn starting_directory(start: &Path) -> &Path {
    if start.is_file() {
        start.parent().unwrap_or(start)
    } else {
        start
    }
}

/// Finds the nearest `.ores-otel.toml`, walking from `start` toward the
/// filesystem root. The first match is authoritative.
pub fn discover_nearest_ores_otel_config(
    start: impl AsRef<Path>,
) -> Option<DiscoveredOresOtelConfig> {
    let start = starting_directory(start.as_ref());
    start
        .ancestors()
        .map(|directory| (directory, directory.join(ORES_OTEL_CONFIG_BASENAME)))
        .find(|(_, candidate)| candidate.is_file())
        .map(|(directory, path)| DiscoveredOresOtelConfig {
            path,
            at_repository_root: directory.join(".git").is_dir(),
        })
}

pub fn discover_nearest_ores_otel_config_from_cwd(
) -> Result<Option<DiscoveredOresOtelConfig>, std::io::Error> {
    std::env::current_dir().map(discover_nearest_ores_otel_config)
}

/// Emit the non-root warning through the canonical ORE Rust logger itself.
///
/// Config discovery happens before the application logger is necessarily
/// configured, so this uses a short-lived console logger with no transport or
/// recursive config dependency.
pub fn warn_non_root_config(config_name: &str, path: &Path) {
    let logger = Logger::new(Options {
        app_name: "ores-config-discovery".to_owned(),
        name: Some("config-discovery".to_owned()),
        max_level: LogLevel::Warn,
        ..Options::default()
    });
    let fields = [
        ("config".to_owned(), json!(config_name)),
        ("path".to_owned(), json!(path.display().to_string())),
    ]
    .into_iter()
    .collect();
    let _ = logger
        .warn(vec![json!("config is not adjacent to a .git directory; using nearest config")])
        .add_fields(fields)
        .not_otel()
        .send();
    let _ = logger.close();
}

/// Load the nearest config from cwd while preserving an explicitly supplied
/// `LoadOptions::file_path` as the highest-precedence caller override.
///
/// When neither an explicit file nor a nearest cwd file exists, the existing
/// loader retains its environment/default fallback behavior.
pub fn load_nearest_ores_otel_config(
    mut options: LoadOptions,
) -> Result<LoadedOresOtelConfig, OresOtelConfigError> {
    if let Some(path) = options.file_path.clone() {
        let directory = path.parent().unwrap_or_else(|| Path::new("."));
        if !directory.join(".git").is_dir() {
            warn_non_root_config(ORES_OTEL_CONFIG_BASENAME, &path);
        }
        return load_ores_otel_config(options);
    }

    let start = options
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok());
    if let Some(discovered) = start.and_then(discover_nearest_ores_otel_config) {
        if !discovered.at_repository_root {
            warn_non_root_config(ORES_OTEL_CONFIG_BASENAME, &discovered.path);
        }
        options.file_path = Some(discovered.path);
        options.cwd = None;
    }

    load_ores_otel_config(options)
}

pub fn load_nearest_ores_otel_config_from_process_env(
) -> Result<LoadedOresOtelConfig, OresOtelConfigError> {
    load_nearest_ores_otel_config(LoadOptions::from_process_env())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    fn scratch(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("ores-otel-{name}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn nearest_config_wins() {
        let root = scratch("nearest");
        let service = root.join("services/api");
        let cwd = service.join("src");
        fs::create_dir_all(root.join(".git")).expect("git dir");
        fs::create_dir_all(&cwd).expect("cwd");
        fs::write(root.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("root config");
        fs::write(service.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("service config");

        let found = discover_nearest_ores_otel_config(&cwd).expect("nearest");
        assert_eq!(found.path, service.join(ORES_OTEL_CONFIG_BASENAME));
        assert!(!found.at_repository_root);

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn root_config_is_recognized() {
        let root = scratch("root");
        let cwd = root.join("src/bin");
        fs::create_dir_all(root.join(".git")).expect("git dir");
        fs::create_dir_all(&cwd).expect("cwd");
        fs::write(root.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("config");

        let found = discover_nearest_ores_otel_config(&cwd).expect("root");
        assert_eq!(found.path, root.join(ORES_OTEL_CONFIG_BASENAME));
        assert!(found.at_repository_root);

        fs::remove_dir_all(root).expect("cleanup");
    }
}
