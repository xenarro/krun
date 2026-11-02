import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

from handler import handle

ROOT = Path(__file__).resolve().parents[1]


def test_handle():
    statuses = []
    ctx = SimpleNamespace(
        runId="local",
        function="__KRUN_NAME__",
        status=lambda *args: statuses.append(args),
        log=lambda *args: None,
    )
    assert handle({"name": "world"}, ctx) == {"rows": 42}
    assert statuses == [("loading", 0.1)]


def test_local_mode():
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("KRUN_")
    }
    result = subprocess.run(
        [sys.executable, "handler.py"],
        cwd=ROOT,
        env=env,
        input=json.dumps({"name": "world"}),
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"rows": 42}
    assert "loading" in result.stderr


def test_import_is_inert():
    script = """import krun, socket

def forbidden(*args, **kwargs):
    raise AssertionError("Import must not start the SDK or perform network I/O")

krun.run = forbidden
socket.socket = forbidden
import handler
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    assert result.stderr == ""
