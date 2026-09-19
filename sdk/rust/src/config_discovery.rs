#![forbid(unsafe_code)]

//! Hardened filesystem discovery for the owner-side `.ores-otel.toml` loader.
//!
//! The pure cross-SDK resolver in `config.rs` remains unchanged. This module is
//! the server-facing filesystem layer: explicit files are exact, implicit
//! directory discovery is bounded and cannot cross a Git trust boundary, and
//! the existing parser/resolver remains the sole configuration authority.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use crate::config::{
    load_ores_otel_config, LoadOptions, LoadedOresOtelConfig, OresOtelConfigError, OresOtelEnv,
    ENV_CONFIG_DIR, ENV_CONFIG_FILE, ORES_OTEL_CONFIG_BASENAME,
};

pub const MAX_DISCOVERY_ANCESTORS: usize = ores_config_discovery::MAX_ANCESTORS;
pub const MAX_DISCOVERY_CONFIG_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OresOtelConfigStart {
    /// Operator-selected file. It is used exactly or the load fails.
    File(PathBuf),
    /// Directory-shaped source. The canonical config basename is searched upward.
    Directory(PathBuf),
}

fn non_blank_path(path: Option<&Path>) -> Option<PathBuf> {
    path.and_then(Path::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn non_blank_env(env: &OresOtelEnv, key: &str) -> Option<PathBuf> {
    env.get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Classifies the winning lookup source without touching disk.
///
/// Precedence intentionally matches `ores_otel_config_file_path`: explicit
/// `file_path`, explicit `cwd`, `ORES_OTEL_CONFIG_FILE`, `ORES_OTEL_CONFIG_DIR`,
/// then the actual current working directory.
pub fn ores_otel_config_start(
    options: &LoadOptions,
    env: &OresOtelEnv,
    current_directory: &Path,
) -> OresOtelConfigStart {
    if let Some(path) = non_blank_path(options.file_path.as_deref()) {
        return OresOtelConfigStart::File(path);
    }
    if let Some(path) = non_blank_path(options.cwd.as_deref()) {
        return OresOtelConfigStart::Directory(path);
    }
    if let Some(path) = non_blank_env(env, ENV_CONFIG_FILE) {
        return OresOtelConfigStart::File(path);
    }
    if let Some(path) = non_blank_env(env, ENV_CONFIG_DIR) {
        return OresOtelConfigStart::Directory(path);
    }
    OresOtelConfigStart::Directory(current_directory.to_path_buf())
}

/// Fleet placement evidence is intentionally stricter: only an adjacent `.git`
/// directory counts as repository-root placement.
#[must_use]
pub fn is_repo_root(directory: &Path) -> bool {
    directory.join(".git").is_dir()
}

fn checked_config_leaf(path: &Path) -> Result<(), OresOtelConfigError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| OresOtelConfigError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_DISCOVERY_CONFIG_BYTES
    {
        return Err(OresOtelConfigError::Io {
            path: path.to_path_buf(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "OTel config must be a regular non-symlink file no larger than 256 KiB",
            ),
        });
    }
    Ok(())
}

/// Maps a traversal refusal onto this SDK's error type, keeping the message a
/// caller of the native loop would have seen for an unsafe leaf.
fn discovery_io_error(
    error: ores_config_discovery::DiscoveryError,
    fallback: &Path,
) -> OresOtelConfigError {
    use ores_config_discovery::DiscoveryError;
    match error {
        DiscoveryError::Symlink(path) | DiscoveryError::NotRegularFile(path) => {
            OresOtelConfigError::Io {
                path,
                source: std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "OTel config must be a regular non-symlink file no larger than 256 KiB",
                ),
            }
        }
        DiscoveryError::Unreadable { path, kind } => OresOtelConfigError::Io {
            path,
            source: std::io::Error::from(kind),
        },
        other => OresOtelConfigError::Io {
            path: fallback.to_path_buf(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidInput, other.to_string()),
        },
    }
}

fn load_exact(
    mut options: LoadOptions,
    path: PathBuf,
) -> Result<LoadedOresOtelConfig, OresOtelConfigError> {
    checked_config_leaf(&path)?;
    options.file_path = Some(path);
    options.cwd = None;
    load_ores_otel_config(options)
}

/// Loads the owner-selected `.ores-otel.toml` using hardened filesystem
/// discovery while preserving the existing parser/resolver as authority.
///
/// Explicit file selection is exact and missing files fail rather than falling
/// back. Directory-shaped selection canonicalizes the starting point when
/// possible, searches at most 64 ancestors, rejects unsafe leaves, and stops
/// after checking the first Git boundary so it cannot silently consume another
/// repository's telemetry policy. If no implicit file exists before that
/// boundary, the historical OTel behavior is preserved: defaults are resolved
/// and `LoadedOresOtelConfig.file_path` is `None`.
pub fn load_ores_otel_config_upward(
    options: LoadOptions,
) -> Result<LoadedOresOtelConfig, OresOtelConfigError> {
    let env = options.resolve.effective_env();
    let current = std::env::current_dir().map_err(|source| OresOtelConfigError::Io {
        path: PathBuf::from("."),
        source,
    })?;

    match ores_otel_config_start(&options, &env, &current) {
        OresOtelConfigStart::File(path) => load_exact(options, path),
        OresOtelConfigStart::Directory(start) => {
            let start = fs::canonicalize(&start).unwrap_or(start);
            let first_candidate = start.join(ORES_OTEL_CONFIG_BASENAME);

            // The walk is the fleet-wide primitive (ores-config-discovery): at
            // most 64 ancestors, never past the first Git boundary of either
            // kind, symlinked leaves refused. This module keeps its own policy:
            // a non-regular leaf is an error, the 256 KiB cap, placement means
            // a `.git` *directory*, and absence resolves defaults below.
            match ores_config_discovery::Search::new(ORES_OTEL_CONFIG_BASENAME)
                .refuse_non_regular(true)
                .from(&start)
            {
                Ok(Some(located)) => {
                    checked_config_leaf(&located.path)?;
                    if !located.beside_git_directory() {
                        warn_unless_repo_root(&located.path);
                    }
                    return load_exact(options, located.path);
                }
                Ok(None) => {}
                Err(error) => return Err(discovery_io_error(error, &first_candidate)),
            }

            // Preserve the historical implicit-missing behavior (defaults) but
            // pin the attempted path to the first candidate so no second walk or
            // ambient parent lookup can occur inside the legacy loader.
            let mut exact = options;
            exact.file_path = Some(first_candidate);
            exact.cwd = None;
            load_ores_otel_config(exact)
        }
    }
}

fn warn_unless_repo_root(path: &Path) {
    let _ = discovery_logger()
        .warn(vec![crate::logger_core::json!({
            "event": "ores.config.not_at_repo_root",
            "ores.config.file": ORES_OTEL_CONFIG_BASENAME,
            "ores.config.path": path.display().to_string(),
            "ores.config.at_repo_root": false,
            "detail": "ores-otel configuration was selected without an adjacent .git directory; confirm this file is meant to govern the running service"
        })])
        .send();
}

fn discovery_logger() -> &'static crate::logger_core::Logger {
    static LOGGER: OnceLock<crate::logger_core::Logger> = OnceLock::new();
    LOGGER.get_or_init(|| {
        crate::logger_core::Logger::new(crate::logger_core::Options {
            app_name: "oresoftware-next-loggers".into(),
            name: Some("config-discovery".into()),
            ..crate::logger_core::Options::default()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ores-otel-hardened-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("root");
        root
    }

    fn options_with_cwd(cwd: PathBuf) -> LoadOptions {
        LoadOptions {
            cwd: Some(cwd),
            ..LoadOptions::default()
        }
    }

    #[test]
    fn nearest_config_is_owner_loaded_and_source_path_is_retained() {
        let root = scratch("nearest");
        let deep = root.join("services/api");
        fs::create_dir_all(root.join(".git")).expect("git dir");
        fs::create_dir_all(&deep).expect("deep");
        fs::write(root.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("config");

        let loaded = load_ores_otel_config_upward(options_with_cwd(deep)).expect("load");
        // Discovery canonicalises, so compare canonical paths: the temp dir is
        // reached through a symlink on macOS (/var -> /private/var).
        let expected = fs::canonicalize(root.join(ORES_OTEL_CONFIG_BASENAME)).expect("canonical");
        assert_eq!(loaded.file_path.as_deref(), Some(expected.as_path()));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn implicit_discovery_does_not_escape_repository_boundary() {
        let outer = scratch("boundary");
        let repo = outer.join("repo");
        let deep = repo.join("services/api");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::create_dir_all(&deep).expect("deep");
        fs::write(outer.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("outer config");

        let loaded = load_ores_otel_config_upward(options_with_cwd(deep)).expect("defaults");
        assert!(
            loaded.file_path.is_none(),
            "parent repository config must not be selected"
        );
        fs::remove_dir_all(outer).expect("cleanup");
    }

    #[test]
    fn explicit_missing_file_fails_instead_of_falling_back() {
        let root = scratch("explicit-missing");
        fs::write(root.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("parent config");
        let options = LoadOptions {
            file_path: Some(root.join("missing.toml")),
            ..LoadOptions::default()
        };
        let error = load_ores_otel_config_upward(options).expect_err("exact file must fail");
        assert!(matches!(error, OresOtelConfigError::Io { .. }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn git_file_is_a_boundary_but_not_root_placement_evidence() {
        let root = scratch("git-file");
        fs::write(root.join(".git"), "gitdir: /elsewhere\n").expect("git file");
        fs::write(root.join(ORES_OTEL_CONFIG_BASENAME), "version = 1\n").expect("config");
        assert!(!is_repo_root(&root));
        let loaded = load_ores_otel_config_upward(options_with_cwd(root.clone())).expect("load");
        assert!(loaded.file_path.is_some());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_leaf_is_rejected_before_read() {
        use std::os::unix::fs::symlink;
        let root = scratch("symlink");
        let real = root.join("real.toml");
        fs::write(&real, "version = 1\n").expect("real");
        symlink(&real, root.join(ORES_OTEL_CONFIG_BASENAME)).expect("symlink");
        let error = load_ores_otel_config_upward(options_with_cwd(root.clone()))
            .expect_err("symlink must fail closed");
        assert!(matches!(error, OresOtelConfigError::Io { .. }));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
