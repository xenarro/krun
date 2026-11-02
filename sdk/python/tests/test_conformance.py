"""The same wire table and Node HTTP fake used by the Node SDK suite."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

DIRECTORY = Path(__file__).resolve().parents[3] / "test" / "sdk-conformance"
SCENARIOS = json.loads((DIRECTORY / "scenarios.json").read_text())


def exercise(name: str, mutation: str = "none") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            os.environ.get("KRUN_TEST_NODE", "node"),
            str(DIRECTORY / "runner.ts"),
            "python",
            name,
            os.environ.get("KRUN_TEST_PYTHON", sys.executable),
            mutation,
        ],
        env={
            key: value
            for key, value in os.environ.items()
            if not key.startswith("KRUN_") and key != "NODE_OPTIONS"
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=55,
    )


@pytest.mark.parametrize("name", [scenario["name"] for scenario in SCENARIOS])
def test_shared_wire_table(name: str) -> None:
    result = exercise(name)
    assert result.returncode == 0, result.stdout or result.stderr
    assert json.loads(result.stdout)["ok"] is True


def test_reordered_real_python_calls_fail() -> None:
    result = exercise("two-immediate-statuses", "swap-statuses")
    assert result.returncode == 1
    value = json.loads(result.stdout)
    assert value["ok"] is False
    assert value["failure"] == "body mismatch at request 1"


@pytest.mark.parametrize("name", ["success", "two-immediate-statuses", "thrown-error"])
def test_invalid_internal_write_media_rejected(name: str) -> None:
    result = exercise(name, "media-writes")
    assert result.returncode == 1
    assert json.loads(result.stdout) == {
        "ok": False,
        "failure": "content type mismatch at 1",
    }


@pytest.mark.parametrize("name", ["success", "two-immediate-statuses", "thrown-error"])
def test_json_media_parameters_accepted(name: str) -> None:
    result = exercise(name, "media-parameters")
    assert result.returncode == 0, result.stdout or result.stderr
    assert json.loads(result.stdout)["ok"] is True


def test_unsupported_get_media_rejected() -> None:
    result = exercise("success", "media-get")
    assert result.returncode == 1
    assert json.loads(result.stdout) == {
        "ok": False,
        "failure": "content type mismatch at 0",
    }


def test_present_empty_get_media_rejected() -> None:
    result = exercise("success", "media-empty-get")
    assert result.returncode == 1
    assert json.loads(result.stdout) == {
        "ok": False,
        "failure": "content type mismatch at 0",
    }


def test_absent_get_media_allowed_but_write_requires_json() -> None:
    result = exercise("success", "media-omit")
    assert result.returncode == 1
    assert json.loads(result.stdout) == {
        "ok": False,
        "failure": "content type mismatch at 1",
    }


def test_shared_matcher_negative_controls() -> None:
    result = exercise("--self-test")
    assert result.returncode == 0, result.stdout or result.stderr
    assert json.loads(result.stdout)["ok"] is True
