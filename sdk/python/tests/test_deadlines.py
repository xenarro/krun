"""Whole-attempt deadlines use real, unscaled slow-progress HTTP peers."""

from __future__ import annotations

import json
import signal
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from test_runtime import PYTHON, Fake, environment, execute, program


@dataclass
class Peer:
    target: str = "input"
    phase: str = "body"
    slow: bool = True
    always: bool = False
    calls: list[tuple[str, float]] = field(default_factory=list)
    url: str = ""
    status_seen: threading.Event = field(default_factory=threading.Event)


@pytest.fixture
def peer() -> Iterator[Peer]:
    state = Peer()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def handle_call(self) -> None:
            operation = self.path.rsplit("/", 1)[-1]
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            state.calls.append((operation, time.monotonic()))
            if operation == "status":
                state.status_seen.set()
            first = sum(op == operation for op, _ in state.calls) == 1
            slow = state.slow and operation == state.target and (first or state.always)
            data = b'{"payload":"' + b"x" * 40 + b'"}' if operation == "input" else b""
            code = 200 if operation in ("input", "upload") else 204
            try:
                if slow and state.phase == "headers":
                    self.connection.sendall(f"HTTP/1.0 {code} OK\r\nX-Drip: ".encode())
                    for _ in range(9 if operation == "status" else 24):
                        time.sleep(0.5)
                        self.connection.sendall(b"x")
                    self.connection.sendall(
                        f"\r\nContent-Length: {len(data)}\r\n\r\n".encode()
                    )
                else:
                    self.send_response(code)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                for byte in data:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    if slow and state.phase == "body":
                        time.sleep(0.23)
            except (BrokenPipeError, ConnectionResetError):
                pass

        do_GET = handle_call
        do_POST = handle_call
        do_PUT = handle_call

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


@pytest.mark.parametrize(
    "target,phase",
    [
        ("input", "body"),
        ("input", "headers"),
        ("result", "headers"),
        ("error", "headers"),
    ],
)
def test_whole_attempt_deadline_retries_slow_progress(
    peer: Peer, target: str, phase: str
) -> None:
    peer.target, peer.phase = target, phase
    # The existing helper only needs the fake's URL to construct the environment.
    started = time.monotonic()
    result = execute(
        'raise ValueError("bad")' if target == "error" else "return input",
        Fake(url=peer.url),
    )
    assert result.returncode == (1 if target == "error" else 0), result.stderr
    calls = [at for operation, at in peer.calls if operation == target]
    assert len(calls) == 2
    assert 10.8 <= calls[1] - calls[0] < 11.9
    assert time.monotonic() - started < 13


@pytest.mark.parametrize("slow", [True, False])
def test_status_whole_attempt_deadline_and_worker_cleanup(
    peer: Peer, slow: bool
) -> None:
    peer.target, peer.phase, peer.slow = "status", "headers", slow
    source = (
        "import json,time,threading; import krun._runtime as r\n"
        "before = {t.ident for t in threading.enumerate()}\n"
        "started = time.monotonic()\n"
        "timed_out = False\n"
        "try:\n"
        f' r._request({peer.url + "/status"!r}, "POST", b\'{{"message":"one"}}\', {{}}, 3, False, 204)\n'
        "except TimeoutError:\n timed_out = True\n"
        'print(json.dumps({"timed_out":timed_out,"elapsed":time.monotonic()-started,"workers":len(r._workers),"threads_same":before=={t.ident for t in threading.enumerate()}}))\n'
    )
    result = subprocess.run(
        [PYTHON, "-c", source],
        env=environment(),
        capture_output=True,
        text=True,
        timeout=8,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    observed = json.loads(result.stdout)
    assert observed["timed_out"] is slow
    assert observed["elapsed"] < (3.8 if slow else 2)
    if slow:
        assert observed["elapsed"] >= 2.9
    assert observed["workers"] == 0
    assert observed["threads_same"]
    assert len(peer.calls) == 1


def test_daemon_recovers_after_slow_header_deadline(peer: Peer) -> None:
    peer.target, peer.phase = "status", "headers"
    result = execute(
        'ctx.status("one")\nctx.status("two")\nreturn input', Fake(url=peer.url)
    )
    assert result.returncode == 0, result.stderr
    statuses = [at for op, at in peer.calls if op == "status"]
    assert len(statuses) == 2
    assert 3.9 <= statuses[1] - statuses[0] < 4.9


@pytest.mark.skipif(
    not Path("/proc/self/task").exists(), reason="Linux process ownership witness"
)
@pytest.mark.parametrize("cancel", [True, False])
def test_terminal_and_sigterm_reap_inflight_attempt(peer: Peer, cancel: bool) -> None:
    peer.target, peer.phase = "status", "headers"
    body = "time.sleep(30)\nreturn input" if cancel else "time.sleep(2)\nreturn None"
    child = subprocess.Popen(
        [PYTHON, "-c", program(body)],
        env=environment(Fake(url=peer.url), KRUN_HEARTBEAT_TIMEOUT="3"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert peer.status_seen.wait(5)
        pids = {
            int(value)
            for path in Path(f"/proc/{child.pid}/task").glob("*/children")
            for value in path.read_text().split()
        }
        assert pids, "the HTTP attempt must have a live owned subprocess"
        for pid in pids:
            arguments = Path(f"/proc/{pid}/cmdline").read_bytes()
            assert b"krun-test-token" not in arguments
            assert peer.url.encode() not in arguments
        if cancel:
            child.send_signal(signal.SIGTERM)
        child.communicate(timeout=4)
        assert child.returncode == (1 if cancel else 0)
        assert all(not Path(f"/proc/{pid}").exists() for pid in pids)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()
