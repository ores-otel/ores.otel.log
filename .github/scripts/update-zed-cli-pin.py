#!/usr/bin/env python3
"""Update or verify the repository's immutable zed-pkg CLI pin.

The updater intentionally consumes only the latest GitHub release metadata and
the release-published checksum asset.  It never executes the downloaded CLI;
the normal CI/package workflows perform the archive and exact-version checks
after a generated PR is reviewed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
RELEASE_URL = "https://api.github.com/repos/zed-pkg/zed-cli/releases/latest"
ARCHIVE = "zed-x86_64-unknown-linux-gnu.tar.gz"
CHECKSUM_ASSET = f"{ARCHIVE}.sha256"
TARGETS = (
    ROOT / ".github/workflows/ci.yml",
    ROOT / ".github/workflows/packaging.yml",
    ROOT / ".github/workflows/release-zed.yml",
    ROOT / "tests/zpkg.test.mjs",
)
VERSION_RE = re.compile(r"^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
SHA256_RE = re.compile(r"\b[0-9a-fA-F]{64}\b")


def get_json(url: str) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "ores-otel-zed-cli-pin-updater",
    }
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f"unable to read {url}: {error}") from error


def get_text(url: str) -> str:
    request = Request(
        url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "ores-otel-zed-cli-pin-updater",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f"unable to read {url}: {error}") from error


def latest_pin() -> tuple[str, str]:
    release = get_json(RELEASE_URL)
    tag = release.get("tag_name")
    if not isinstance(tag, str) or not VERSION_RE.fullmatch(tag):
        raise RuntimeError(f"latest release has an invalid semver tag: {tag!r}")

    assets = release.get("assets")
    if not isinstance(assets, list):
        raise RuntimeError("latest release has no asset list")
    checksum_url = next(
        (
            asset.get("browser_download_url")
            for asset in assets
            if asset.get("name") == CHECKSUM_ASSET
        ),
    )
    if not isinstance(checksum_url, str):
        raise RuntimeError(f"latest release is missing {CHECKSUM_ASSET}")
    checksum_text = get_text(checksum_url)
    checksum = SHA256_RE.search(checksum_text)
    if checksum is None:
        raise RuntimeError(f"{CHECKSUM_ASSET} does not contain a SHA-256 digest")
    return tag, checksum.group(0).lower()


def replace_pin(text: str, version: str, checksum: str, path: Path) -> str:
    updated, version_count = re.subn(
        r"(?m)^(\s*ZED_VERSION:\s*)v[^\s]+$",
        rf"\g<1>{version}",
        text,
    )
    updated, test_version_count = re.subn(
        r"(?m)^(\s*const zedCliVersion = ')[^']+(';)$",
        rf"\g<1>{version}\g<2>",
        updated,
    )
    updated, checksum_count = re.subn(
        r"(?m)^(\s*ZED_ARCHIVE_SHA256:\s*)[0-9a-fA-F]{64}$",
        rf"\g<1>{checksum}",
        updated,
    )
    updated, test_checksum_count = re.subn(
        r"(?m)^(\s*const zedCliArchiveSha256 = ')[^']+(';)$",
        rf"\g<1>{checksum}\g<2>",
        updated,
    )
    expected = 1
    if version_count + test_version_count != expected:
        raise RuntimeError(
            f"{path}: expected {expected} version pin, found "
            f"{version_count + test_version_count}"
        )
    if checksum_count + test_checksum_count != expected:
        raise RuntimeError(
            f"{path}: expected {expected} checksum pin, found "
            f"{checksum_count + test_checksum_count}"
        )
    return updated


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--write",
        action="store_true",
        help="write the latest release pin; otherwise verify it only",
    )
    mode.add_argument(
        "--check",
        action="store_true",
        help="verify that all checked-in pins match the latest release",
    )
    args = parser.parse_args()

    try:
        version, checksum = latest_pin()
        changed: list[Path] = []
        for path in TARGETS:
            original = path.read_text(encoding="utf-8")
            updated = replace_pin(original, version, checksum, path)
            if updated != original:
                changed.append(path)
                if args.write:
                    path.write_text(updated, encoding="utf-8")
        if changed and not args.write:
            print(
                f"zed-pkg latest is {version} ({checksum}); stale files: "
                + ", ".join(str(path.relative_to(ROOT)) for path in changed),
                file=sys.stderr,
            )
            return 1
        if args.write:
            print(
                f"zed-pkg latest pin: {version} {checksum}; "
                f"updated {len(changed)} file(s)"
            )
        else:
            print(f"zed-pkg pin is current: {version} {checksum}")
        return 0
    except (OSError, RuntimeError, ValueError) as error:
        print(f"zed-pkg pin update failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
