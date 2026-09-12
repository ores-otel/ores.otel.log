#![allow(
    clippy::needless_return,
    reason = "Shared policy requires explicit Rust returns."
)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Checkout(PathBuf);

impl Checkout {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "workflow-provenance-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::create_dir_all(path.join(".github/workflows")).unwrap();
        return Self(path);
    }

    fn admit(&self, paths: &[u8]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_workflow-provenance"))
            .current_dir(&self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(paths).unwrap();
        return child.wait_with_output().unwrap();
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn git_file_list_admits_quoted_pins_and_rejects_flow_mapping_tags() {
    let checkout = Checkout::new();
    let workflow = checkout.0.join(".github/workflows/with spaces.yaml");
    let list = b".github/workflows/with spaces.yaml\0";
    std::fs::write(
        &workflow,
        format!(
            "jobs: {{test: {{steps: [{{'uses': 'actions/checkout@{}'}}]}}}}",
            "a".repeat(40)
        ),
    )
    .unwrap();
    assert!(checkout.admit(list).status.success());
    std::fs::write(
        &workflow,
        "jobs: {test: {steps: [{uses: actions/checkout@v7}]}}",
    )
    .unwrap();
    assert!(!checkout.admit(list).status.success());
}

#[test]
fn deletion_only_diff_is_valid_but_missing_files_and_bad_lists_fail() {
    let checkout = Checkout::new();
    assert!(checkout.admit(b"").status.success());
    for list in [
        &b".github/workflows/missing.yml\0"[..],
        &b".github/workflows/missing.yml"[..],
        &b"\0"[..],
        &b".github/workflows/\xff.yml\0"[..],
    ] {
        assert!(!checkout.admit(list).status.success());
    }
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_substitute_files_outside_the_checkout() {
    use std::os::unix::fs::symlink;
    let checkout = Checkout::new();
    std::fs::write(
        checkout.0.join("outside.yml"),
        "jobs: {test: {steps: [{run: true}]}}",
    )
    .unwrap();
    symlink(
        "../../outside.yml",
        checkout.0.join(".github/workflows/linked.yml"),
    )
    .unwrap();
    assert!(!checkout
        .admit(b".github/workflows/linked.yml\0")
        .status
        .success());
    std::fs::create_dir(checkout.0.join("outside")).unwrap();
    std::fs::rename(
        checkout.0.join(".github/workflows"),
        checkout.0.join("outside/saved"),
    )
    .unwrap();
    symlink("../outside/saved", checkout.0.join(".github/workflows")).unwrap();
    assert!(!checkout
        .admit(b".github/workflows/linked.yml\0")
        .status
        .success());
}
