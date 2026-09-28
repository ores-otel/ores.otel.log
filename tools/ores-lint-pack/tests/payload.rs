#![allow(
    clippy::needless_return,
    reason = "Shared policy requires explicit Rust returns."
)]

//! End-to-end tests: each one builds a `.ores-lint`-shaped payload in a
//! temporary directory and runs the real binary over it. The fixtures are
//! written here rather than read from `../../.ores-lint` on purpose, so the
//! suite keeps its meaning while the live payload is mid-repair.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ores-lint-pack-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(path.join(".ores-lint")).unwrap();
        return Self(path);
    }

    fn payload(&self) -> PathBuf {
        return self.0.join(".ores-lint");
    }

    fn write(&self, relative: &str, contents: &str) {
        let target = self.payload().join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(target, contents).unwrap();
    }

    fn remove(&self, relative: &str) {
        std::fs::remove_file(self.payload().join(relative)).unwrap();
    }

    fn run(&self, arguments: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ores-lint-pack"));
        command.arg(arguments[0]).arg(self.payload());
        for argument in &arguments[1..] {
            command.arg(argument);
        }
        return command.output().unwrap();
    }

    /// A minimally realistic, self-consistent payload shaped like the real one.
    fn consistent() -> Self {
        let fixture = Self::new();
        fixture.write("VERSION", "1.3.1\n");
        fixture.write(
            "config.sh",
            "#!/bin/sh\n\
             : \"${ORES_LINT_STRICT:=0}\"\n\
             ORES_LINT_CFG_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
             [ -f \"$ORES_LINT_CFG_DIR/local.sh\" ] && . \"$ORES_LINT_CFG_DIR/local.sh\"\n",
        );
        fixture.write(
            "lint.sh",
            "#!/bin/sh\n\
             DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
             ROOT=$(dirname \"$DIR\")\n\
             . \"$DIR/config.sh\"\n\
             echo \"ores-lint v$(cat \"$DIR/VERSION\")\"\n\
             sh \"$DIR/js.sh\" \"$ROOT\"\n",
        );
        fixture.write(
            "js.sh",
            "#!/bin/sh\n\
             DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
             . \"$DIR/config.sh\"\n\
             eslint --format \"$DIR/eslint/formatter.mjs\" \"$1\"\n",
        );
        fixture.write("eslint/formatter.mjs", "export default function format() {\n  return '';\n}\n");
        fixture.write("eslint/plugin.mjs", "export default { rules: {} };\n");
        fixture.write(
            "eslint/base.mjs",
            "import oresPlugin from './plugin.mjs';\nexport default oresPlugin;\n",
        );
        return fixture;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn stdout(output: &Output) -> String {
    return String::from_utf8_lossy(&output.stdout).to_string();
}

#[test]
fn a_self_consistent_payload_validates() {
    let fixture = Fixture::consistent();
    let output = fixture.run(&["validate"]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    assert!(text.contains("payload is self-consistent"), "{text}");
}

#[test]
fn a_shell_reference_to_a_missing_sibling_fails() {
    let fixture = Fixture::consistent();
    fixture.remove("js.sh");
    let output = fixture.run(&["validate"]);
    let text = stdout(&output);
    assert!(!output.status.success(), "{text}");
    assert!(text.contains("lint.sh references js.sh"), "{text}");
}

#[test]
fn the_selftest_fixture_gap_is_detected() {
    // The exact shape of the fleet-wide defect: selftest.sh calls three files
    // that 808 copies of the payload do not carry.
    let fixture = Fixture::consistent();
    fixture.write(
        "selftest.sh",
        "#!/bin/sh\n\
         DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
         . \"$DIR/config.sh\"\n\
         if [ -d \"$DIR/test-tools/node_modules\" ]; then export NODE_PATH=\"${DIR}/test-tools/node_modules\"; fi\n\
         node --test \"$DIR/require-send.test.mjs\" \"$DIR/eslint/plugin.test.mjs\"\n\
         node \"$DIR/tests/integration.mjs\"\n",
    );
    let output = fixture.run(&["validate"]);
    let text = stdout(&output);
    assert!(!output.status.success(), "{text}");
    for missing in [
        "require-send.test.mjs",
        "eslint/plugin.test.mjs",
        "tests/integration.mjs",
    ] {
        assert!(text.contains(missing), "expected {missing} in:\n{text}");
    }
    // The optional, environment-provided node install must not be reported.
    assert!(!text.contains("FAIL  - selftest.sh references test-tools"), "{text}");
}

#[test]
fn a_guarded_reference_is_optional() {
    let fixture = Fixture::consistent();
    fixture.write(
        "dart.sh",
        "#!/bin/sh\n\
         DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
         . \"$DIR/config.sh\"\n\
         if [ -f \"$DIR/optional.json\" ]; then cat \"$DIR/optional.json\"; fi\n",
    );
    let output = fixture.run(&["validate"]);
    assert!(output.status.success(), "{}", stdout(&output));
}

#[test]
fn a_reference_held_in_an_untested_variable_is_required() {
    let fixture = Fixture::consistent();
    fixture.write(
        "gleam.sh",
        "#!/bin/sh\n\
         DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
         NESTED_FILE=\"$DIR/nested-repos.json\"\n\
         cat \"$NESTED_FILE\"\n",
    );
    let output = fixture.run(&["validate"]);
    let text = stdout(&output);
    assert!(!output.status.success(), "{text}");
    assert!(text.contains("nested-repos.json"), "{text}");
}

#[test]
fn a_reference_held_in_a_tested_variable_is_optional() {
    let fixture = Fixture::consistent();
    fixture.write(
        "gleam.sh",
        "#!/bin/sh\n\
         DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n\
         NESTED_FILE=\"$DIR/nested-repos.json\"\n\
         if [ -f \"$NESTED_FILE\" ]; then cat \"$NESTED_FILE\"; fi\n",
    );
    let output = fixture.run(&["validate"]);
    assert!(output.status.success(), "{}", stdout(&output));
}

#[test]
fn a_relative_module_import_must_resolve() {
    let fixture = Fixture::consistent();
    fixture.remove("eslint/plugin.mjs");
    let output = fixture.run(&["validate"]);
    let text = stdout(&output);
    assert!(!output.status.success(), "{text}");
    assert!(text.contains("eslint/base.mjs references eslint/plugin.mjs"), "{text}");
}

#[test]
fn a_recorded_known_gap_does_not_fail_but_is_reported() {
    let fixture = Fixture::consistent();
    fixture.remove("js.sh");
    let gaps = fixture.0.join("known-gaps.tsv");
    std::fs::write(&gaps, "# recorded\nlint.sh\tjs.sh\n").unwrap();
    let output = fixture.run(&["validate", "--known-gaps", gaps.to_str().unwrap()]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    assert!(text.contains("known - lint.sh references js.sh"), "{text}");
}

#[test]
fn a_known_gap_that_now_resolves_is_called_stale() {
    let fixture = Fixture::consistent();
    let gaps = fixture.0.join("known-gaps.tsv");
    std::fs::write(&gaps, "lint.sh\tjs.sh\n").unwrap();
    let output = fixture.run(&["validate", "--known-gaps", gaps.to_str().unwrap()]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    assert!(text.contains("stale - known gap lint.sh -> js.sh"), "{text}");
}

#[test]
fn the_manifest_lists_managed_files_and_excludes_local_overrides() {
    let fixture = Fixture::consistent();
    fixture.write("local.sh", "ORES_LINT_STRICT=1\n");
    let output = fixture.run(&["manifest"]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    assert!(text.contains("\"schema\": \"ores-lint-payload-manifest/v1\""), "{text}");
    assert!(text.contains("\"version\": \"1.3.1\""), "{text}");
    assert!(text.contains("\"file_count\": 7"), "{text}");
    assert!(text.contains("\"unmanaged\": [\"local.sh\"]"), "{text}");
    assert!(!text.contains("\"path\": \"local.sh\""), "{text}");
}

#[test]
fn the_manifest_carries_the_standard_sha256_of_each_file() {
    let fixture = Fixture::new();
    fixture.write("VERSION", "1.3.1\n");
    fixture.write("abc.txt", "abc");
    let output = fixture.run(&["manifest"]);
    let text = stdout(&output);
    assert!(output.status.success(), "{text}");
    // FIPS 180-4 test vector for "abc".
    assert!(
        text.contains("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        "{text}"
    );
}

#[test]
fn a_manifest_is_refused_for_an_inconsistent_payload() {
    let fixture = Fixture::consistent();
    fixture.remove("js.sh");
    let output = fixture.run(&["manifest"]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("not self-consistent"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_manifest(fixture: &Fixture, at: &Path) {
    let output = fixture.run(&["manifest", "--out", at.to_str().unwrap()]);
    assert!(output.status.success(), "{}", stdout(&output));
}

#[test]
fn verify_accepts_an_intact_copy_and_rejects_a_tampered_one() {
    let fixture = Fixture::consistent();
    let manifest = fixture.0.join("manifest.json");
    write_manifest(&fixture, &manifest);

    let intact = fixture.run(&["verify", "--manifest", manifest.to_str().unwrap()]);
    assert!(intact.status.success(), "{}", stdout(&intact));
    assert!(stdout(&intact).contains("payload matches the manifest"));

    fixture.write("js.sh", "#!/bin/sh\n# drifted locally\n");
    let tampered = fixture.run(&["verify", "--manifest", manifest.to_str().unwrap()]);
    let text = stdout(&tampered);
    assert!(!tampered.status.success(), "{text}");
    assert!(text.contains("js.sh content differs"), "{text}");
}

#[test]
fn verify_reports_a_missing_file_and_an_unexpected_one() {
    let fixture = Fixture::consistent();
    let manifest = fixture.0.join("manifest.json");
    write_manifest(&fixture, &manifest);

    fixture.remove("eslint/formatter.mjs");
    fixture.write("stowaway.sh", "#!/bin/sh\necho hi\n");
    let output = fixture.run(&["verify", "--manifest", manifest.to_str().unwrap()]);
    let text = stdout(&output);
    assert!(!output.status.success(), "{text}");
    assert!(text.contains("missing eslint/formatter.mjs"), "{text}");
    assert!(text.contains("unexpected managed file stowaway.sh"), "{text}");
}

#[test]
fn verify_rejects_a_version_mismatch() {
    let fixture = Fixture::consistent();
    let manifest = fixture.0.join("manifest.json");
    write_manifest(&fixture, &manifest);
    fixture.write("VERSION", "1.3.0\n");
    let output = fixture.run(&["verify", "--manifest", manifest.to_str().unwrap()]);
    let text = stdout(&output);
    assert!(!output.status.success(), "{text}");
    assert!(text.contains("version mismatch"), "{text}");
}
