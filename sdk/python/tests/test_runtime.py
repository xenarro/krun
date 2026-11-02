"""Real HTTP/process acceptance; no clock, transport or timeout scaling."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import pairwise
from pathlib import Path

import pytest

SDK = Path(__file__).resolve().parents[1]
PYTHON = os.environ.get("KRUN_TEST_PYTHON", sys.executable)


@dataclass
class Call:
    method: str
    path: str
    body: bytes
    headers: dict[str, str]
    at: float

    def json(self) -> object:
        return json.loads(self.body)


@dataclass
class Fake:
    calls: list[Call] = field(default_factory=list)
    respond: Callable[[Call], tuple[int, bytes, float]] | None = None
    url: str = ""
    seen: threading.Event = field(default_factory=threading.Event)

    def matching(self, suffix: str) -> list[Call]:
        return [call for call in self.calls if call.path.endswith(suffix)]


@pytest.fixture
def fake() -> Iterator[Fake]:
    state = Fake()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def handle_call(self) -> None:
            call = Call(
                self.command,
                self.path,
                self.rfile.read(int(self.headers.get("Content-Length", "0"))),
                {k.lower(): v for k, v in self.headers.items()},
                time.monotonic(),
            )
            state.calls.append(call)
            state.seen.set()
            code, body, delay = (
                state.respond(call)
                if state.respond
                else (200, b'{"rows":42}', 0)
                if call.path.endswith("/input")
                else (200, b"", 0)
                if call.path.startswith("/upload")
                else (204, b"", 0)
            )
            time.sleep(delay)
            if code == 0:
                self.connection.close()
                return
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                if 300 <= code < 400:
                    self.send_header("Location", state.url + "/redirect-target")
                self.end_headers()
                self.wfile.write(body)
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


def environment(fake: Fake | None = None, **overrides: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("KRUN_")}
    env["PYTHONPATH"] = str(SDK)
    if fake:
        env.update(
            KRUN_GATEWAY_URL=fake.url,
            KRUN_RUN_ID="0199aaaa-0000-7000-8000-000000000001",
            KRUN_FUNCTION="krun-test-python",
            KRUN_TOKEN="krun-test-token",
            KRUN_MAX_RESULT_BYTES="262144",
        )
    env.update(overrides)
    return env


def program(body: str) -> str:
    return (
        "from krun import run\nimport sys, time, threading\ndef handle(input, ctx):\n"
        + "\n".join("    " + line for line in body.splitlines())
        + "\nrun(handle)\n"
    )


def execute(
    body: str, fake: Fake | None = None, stdin: str = "{}", **env: str
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [PYTHON, "-c", program(body)],
        input=stdin,
        check=False,
        capture_output=True,
        text=True,
        env=environment(fake, **env),
        timeout=75,
    )


def assert_ok(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 0, result.stderr


def compact(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def test_success_and_context(fake: Fake) -> None:
    result = execute(
        'ctx.log({"run": ctx.runId, "function": ctx.function})\nreturn input', fake
    )
    assert_ok(result)
    assert [c.method for c in fake.calls] == ["GET", "PUT"]
    assert [c.path.rsplit("/", 1)[-1] for c in fake.calls] == ["input", "result"]
    assert fake.calls[-1].json() == {"rows": 42}
    assert json.loads(result.stdout)["function"] == "krun-test-python"
    assert not fake.matching("/status")
    for call in fake.calls:
        assert call.headers.get("authorization") == "Bearer krun-test-token"
        assert call.headers.get("user-agent") == "krun-sdk-python/0.0.0"


def test_void_no_result(fake: Fake) -> None:
    assert_ok(execute("return None", fake))
    assert len(fake.calls) == 1


@pytest.mark.parametrize("value", ['{"x": 1}', "False", "0", '"hello"', "[]"])
def test_local_json_values(value: str) -> None:
    result = execute("return " + value)
    assert_ok(result)
    assert json.loads(result.stdout) == json.loads(
        "false" if value == "False" else value
    )


def test_local_stream_separation() -> None:
    result = execute(
        'ctx.status("loading", 0.1, {"n": 1})\nctx.log({"log": True})\nreturn input',
        stdin='{"ok":true}',
    )
    assert_ok(result)
    assert result.stdout == '{"ok":true}\n'
    assert [json.loads(line) for line in result.stderr.splitlines()] == [
        {"message": "loading", "progress": 0.1, "data": {"n": 1}},
        {"log": True},
    ]
    assert execute("return None").stdout == ""


def test_local_input_file_and_inert_import(tmp_path: Path) -> None:
    handler = tmp_path / "handler.py"
    handler.write_text(
        'from krun import run\ndef handle(input, ctx):\n    return input\nif __name__ == "__main__":\n    run(handle)\n'
    )
    imported = subprocess.run(
        [PYTHON, "-c", "import handler"],
        cwd=tmp_path,
        env={**environment(), "PYTHONPATH": os.pathsep.join([str(SDK), str(tmp_path)])},
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert_ok(imported)
    assert imported.stdout == imported.stderr == ""
    source = tmp_path / "input.json"
    source.write_text('{"file":true}')
    result = subprocess.run(
        [PYTHON, str(handler), str(source)],
        env=environment(),
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert_ok(result)
    assert json.loads(result.stdout) == {"file": True}


@pytest.mark.parametrize("stdin", ["broken", "NaN", "Infinity"])
def test_local_invalid_input(stdin: str) -> None:
    result = execute("return input", stdin=stdin)
    assert result.returncode == 1
    assert result.stdout == ""


def test_two_status_calls_one_second_apart(fake: Fake) -> None:
    assert_ok(
        execute('ctx.status("one", 0.1)\nctx.status("two", 0.2)\nreturn input', fake)
    )
    statuses = fake.matching("/status")
    assert [c.json() for c in statuses] == [
        {"message": "one", "progress": 0.1},
        {"message": "two", "progress": 0.2},
    ]
    assert statuses[1].at - statuses[0].at >= 0.99


def test_status_429_pending_at_next_slot(fake: Fake) -> None:
    def response(call: Call) -> tuple[int, bytes, float]:
        if call.path.endswith("/status"):
            return (429 if len(fake.matching("/status")) == 1 else 204, b"", 0)
        return (200, b"{}", 0) if call.path.endswith("/input") else (204, b"", 0)

    fake.respond = response
    assert_ok(execute('ctx.status("latest", 0.4)\ntime.sleep(1.4)\nreturn input', fake))
    statuses = fake.matching("/status")
    assert len(statuses) == 2
    assert statuses[0].body == statuses[1].body
    assert statuses[1].at - statuses[0].at >= 0.99


@pytest.mark.parametrize("target", ["/input", "/result", "/error"])
def test_503_three_retries_real_backoff(fake: Fake, target: str) -> None:
    def response(call: Call) -> tuple[int, bytes, float]:
        if call.path.endswith(target) and len(fake.matching(target)) < 4:
            return 503, b"", 0
        return (200, b"{}", 0) if call.path.endswith("/input") else (204, b"", 0)

    fake.respond = response
    result = execute(
        'raise ValueError("bad")' if target == "/error" else "return input", fake
    )
    assert result.returncode == (1 if target == "/error" else 0)
    calls = fake.matching(target)
    assert len(calls) == 4
    for earlier, later, minimum in zip(calls, calls[1:], [1, 2, 4]):
        assert later.at - earlier.at >= minimum - 0.02


def test_input_timeout_retries_without_scaling(fake: Fake) -> None:
    fake.respond = lambda call: (200, b"{}", 60)
    started = time.monotonic()
    result = execute("return input", fake)
    duration = time.monotonic() - started
    assert result.returncode == 1
    assert 46.9 <= duration < 65
    assert len(fake.matching("/input")) == 4
    assert not fake.matching("/result")
    assert not fake.matching("/error")


@pytest.mark.parametrize(
    "target,code",
    [
        ("/input", 400),
        ("/input", 302),
        ("/result", 413),
        ("/result", 302),
        ("/error", 400),
        ("/error", 307),
        ("/status", 400),
        ("/status", 503),
    ],
)
def test_non_retryable_and_one_attempt_status(
    fake: Fake, target: str, code: int
) -> None:
    fake.respond = lambda call: (
        (code, b"", 0)
        if call.path.endswith(target)
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    body = (
        'raise ValueError("bad")'
        if target == "/error"
        else 'ctx.status("one")\nreturn input'
        if target == "/status"
        else "return input"
    )
    result = execute(body, fake)
    assert result.returncode == (0 if target == "/status" else 1)
    assert len(fake.matching(target)) == 1
    assert not fake.matching("/redirect-target")
    if target == "/result":
        assert json.loads(fake.matching("/error")[0].body)["type"] == "ResultWriteError"


@pytest.mark.parametrize(
    "target", ["/input", "/result", "/error", "/status", "/upload"]
)
def test_401_immediate_exit(fake: Fake, target: str) -> None:
    fake.respond = lambda call: (
        (401, b"", 0)
        if call.path.endswith(target)
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    body = (
        'raise ValueError("bad")'
        if target == "/error"
        else "time.sleep(30)\nreturn input"
        if target == "/status"
        else 'return {"large": "x" * 100}'
    )
    started = time.monotonic()
    result = execute(
        body,
        fake,
        KRUN_MAX_RESULT_BYTES="1" if target == "/upload" else "262144",
        KRUN_RESULT_UPLOAD_URL=fake.url + "/upload",
        KRUN_HEARTBEAT_TIMEOUT="3" if target == "/status" else "",
    )
    assert result.returncode == 1
    assert time.monotonic() - started < 4
    assert len(fake.matching(target)) == 1
    assert not fake.matching("/error") if target != "/error" else True


def test_status_timeout_is_bounded_and_does_not_throw(fake: Fake) -> None:
    fake.respond = lambda call: (
        (204, b"", 10)
        if call.path.endswith("/status")
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    started = time.monotonic()
    result = execute('ctx.status("slow")\nreturn input', fake)
    assert_ok(result)
    assert 2.9 <= time.monotonic() - started < 5
    assert len(fake.matching("/status")) == 1


def test_heartbeat_latest_during_slow_input_and_result(fake: Fake) -> None:
    fake.respond = lambda call: (
        (200, b"{}", 1.3)
        if call.path.endswith("/input")
        else (204, b"", 2.3)
        if call.path.endswith("/result")
        else (204, b"", 0)
    )
    assert_ok(
        execute(
            'ctx.status("loading", 0.1)\nreturn input', fake, KRUN_HEARTBEAT_TIMEOUT="3"
        )
    )
    statuses = fake.matching("/status")
    assert len(statuses) >= 3
    assert statuses[0].json() == {"message": "started"}
    assert statuses[0].at - fake.calls[0].at >= 0.9
    assert statuses[-1].json() == {"message": "loading", "progress": 0.1}
    assert statuses[-1].at > fake.matching("/result")[0].at + 1
    assert all(b.at - a.at >= 0.99 for a, b in pairwise(statuses))


@pytest.mark.parametrize("window", ["3", "9000000000000", "garbage", "0", "NaN"])
def test_timer_never_delays_exit_or_posts_started_eagerly(
    fake: Fake, window: str
) -> None:
    started = time.monotonic()
    assert_ok(execute("return None", fake, KRUN_HEARTBEAT_TIMEOUT=window))
    assert time.monotonic() - started < 1
    assert not fake.matching("/status")


def test_daemon_thread_in_handler(fake: Fake) -> None:
    assert_ok(
        execute(
            'assert any(t.daemon and t.name == "krun-status" for t in threading.enumerate())\nreturn input',
            fake,
            KRUN_HEARTBEAT_TIMEOUT="3",
        )
    )


def test_upload_utf8_length_no_bearer_no_inline(fake: Fake) -> None:
    result = execute(
        'return {"large": "🦀" * 20}',
        fake,
        KRUN_MAX_RESULT_BYTES="40",
        KRUN_RESULT_UPLOAD_URL=fake.url + "/upload",
    )
    assert_ok(result)
    upload = fake.matching("/upload")[0]
    assert upload.json() == {"large": "🦀" * 20}
    assert int(upload.headers["content-length"]) == len(upload.body)
    assert not {
        "authorization",
        "transfer-encoding",
        "x-amz-checksum-sha256",
        "content-md5",
    }.intersection(upload.headers)
    assert upload.headers["content-type"] == "application/json"
    assert not fake.matching("/result")


@pytest.mark.parametrize("code", [403, 302, 204])
def test_upload_failure_reports_result_write_error(fake: Fake, code: int) -> None:
    fake.respond = lambda call: (
        (code, b"", 0)
        if call.path.endswith("/upload")
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    result = execute(
        'return {"large": "x" * 100}',
        fake,
        KRUN_MAX_RESULT_BYTES="1",
        KRUN_RESULT_UPLOAD_URL=fake.url + "/upload",
    )
    assert result.returncode == 1
    assert len(fake.matching("/upload")) == 1
    assert json.loads(fake.matching("/error")[0].body)["type"] == "ResultWriteError"
    assert not fake.matching("/redirect-target")
    assert not fake.matching("/result")


def test_oversize_without_upload(fake: Fake) -> None:
    result = execute('return {"large": "x" * 100}', fake, KRUN_MAX_RESULT_BYTES="1")
    assert result.returncode == 1
    assert not fake.matching("/result")
    assert json.loads(fake.matching("/error")[0].body)["type"] == "ResultWriteError"


@pytest.mark.parametrize(
    "value",
    ['float("nan")', 'float("inf")', '{"x": float("nan")}', "set([1])", "object()"],
)
@pytest.mark.parametrize("local", [True, False])
def test_invalid_result_parity(fake: Fake, value: str, local: bool) -> None:
    result = execute("return " + value, None if local else fake)
    assert result.returncode == 1
    error = (
        json.loads(result.stderr.splitlines()[-1])
        if local
        else json.loads(fake.matching("/error")[0].body)
    )
    assert error["type"] == "ResultWriteError"
    assert not fake.matching("/result")


def test_unicode_escaped_byte_limits_and_invalid_progress(fake: Fake) -> None:
    assert_ok(
        execute(
            'ctx.status("🦀\\"\\n" * 1000, float("nan"), {"large": "x" * 5000})\nreturn input',
            fake,
        )
    )
    status = json.loads(fake.matching("/status")[0].body)
    assert 1010 <= len(compact(status["message"])) <= 1024
    assert "progress" not in status and "data" not in status
    assert "omitted" in execute('ctx.status("one", 2, [1])\nreturn None').stderr


def test_status_detaches_mutable_data(fake: Fake) -> None:
    assert_ok(
        execute(
            'data = {"value": 1}\nctx.status("one", data=data)\ndata["value"] = 2\ntime.sleep(1.3)\nreturn input',
            fake,
            KRUN_HEARTBEAT_TIMEOUT="3",
        )
    )
    assert all(
        json.loads(c.body)["data"] == {"value": 1} for c in fake.matching("/status")
    )


def test_error_stack_and_utf8_limits(fake: Fake) -> None:
    result = execute(
        'class VeryLongError(Exception):\n    pass\nVeryLongError.__name__ = "🦀" * 100\nraise VeryLongError("🦀\\n\\"" * 3000)',
        fake,
    )
    assert result.returncode == 1
    error = json.loads(fake.matching("/error")[0].body)
    assert len(compact(error["message"])) <= 4096
    assert len(compact(error["type"])) <= 128
    assert len(compact(error["details"])) <= 8192
    assert len(error["details"]["stack"]) <= 20
    assert not fake.matching("/result")


def test_broken_exception_string_still_reports(fake: Fake) -> None:
    result = execute(
        'class Broken(Exception):\n    def __str__(self):\n        raise RuntimeError("broken str")\nraise Broken()',
        fake,
    )
    assert result.returncode == 1
    error = json.loads(fake.matching("/error")[0].body)
    assert error["type"] == "Broken"
    assert error["message"]


def test_sigterm_exit_one(fake: Fake) -> None:
    child = subprocess.Popen(
        [PYTHON, "-c", program("time.sleep(30)\nreturn input")],
        env=environment(fake),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert fake.seen.wait(5)
        child.send_signal(signal.SIGTERM)
        child.communicate(timeout=3)
        assert child.returncode == 1
        assert not fake.matching("/result")
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()


def test_upload_503_retry_and_heartbeat_during_slow_upload(fake: Fake) -> None:
    def response(call: Call) -> tuple[int, bytes, float]:
        if call.path.endswith("/upload"):
            return (
                (503, b"", 0) if len(fake.matching("/upload")) == 1 else (200, b"", 2.2)
            )
        return (200, b"{}", 0) if call.path.endswith("/input") else (204, b"", 0)

    fake.respond = response
    assert_ok(
        execute(
            'return {"large": "x" * 100}',
            fake,
            KRUN_MAX_RESULT_BYTES="1",
            KRUN_RESULT_UPLOAD_URL=fake.url + "/upload",
            KRUN_HEARTBEAT_TIMEOUT="3",
        )
    )
    uploads = fake.matching("/upload")
    assert len(uploads) == 2
    assert uploads[1].at - uploads[0].at >= 0.99
    assert any(c.at > uploads[-1].at + 1 for c in fake.matching("/status"))
    assert not fake.matching("/result")


def test_heartbeat_continues_during_error_write(fake: Fake) -> None:
    fake.respond = lambda call: (
        (204, b"", 2.2)
        if call.path.endswith("/error")
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    result = execute(
        'ctx.status("before error", 0.5)\nraise ValueError("bad")',
        fake,
        KRUN_HEARTBEAT_TIMEOUT="3",
    )
    assert result.returncode == 1
    assert fake.matching("/status")[-1].at > fake.matching("/error")[0].at + 1
    assert all(
        c.body == fake.matching("/status")[0].body for c in fake.matching("/status")
    )


def test_concurrent_status_updates_coalesce_and_stop_after_terminal(fake: Fake) -> None:
    fake.respond = lambda call: (
        (204, b"", 0.5)
        if call.path.endswith("/status")
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    body = (
        'worker = threading.Thread(target=lambda: ctx.status("first"))\nworker.start()\ntime.sleep(0.1)\n'
        'second = threading.Thread(target=lambda: ctx.status("discarded"))\nsecond.start()\ntime.sleep(0.1)\n'
        'ctx.status("latest")\nworker.join()\nsecond.join()\nreturn input'
    )
    assert_ok(execute(body, fake))
    statuses = fake.matching("/status")
    assert [json.loads(c.body)["message"] for c in statuses] == ["first", "latest"]
    assert statuses[1].at - statuses[0].at >= 1.49


def test_retries_exhausted_result_reports_error(fake: Fake) -> None:
    fake.respond = lambda call: (
        (503, b"", 0)
        if call.path.endswith("/result")
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    result = execute("return input", fake)
    assert result.returncode == 1
    assert len(fake.matching("/result")) == 4
    assert json.loads(fake.matching("/error")[0].body)["type"] == "ResultWriteError"


def test_connection_reset_retries(fake: Fake) -> None:
    fake.respond = lambda call: (
        (0, b"", 0)
        if call.path.endswith("/input") and len(fake.matching("/input")) == 1
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    assert_ok(execute("return input", fake))
    calls = fake.matching("/input")
    assert len(calls) == 2
    assert calls[1].at - calls[0].at >= 0.99


@pytest.mark.parametrize("delta", [0, 1])
def test_exact_inline_utf8_boundary(fake: Fake, delta: int) -> None:
    value = {"text": "🦀"}
    size = len(compact(value))
    assert_ok(
        execute(
            'return {"text": "🦀"}',
            fake,
            KRUN_MAX_RESULT_BYTES=str(size - delta),
            KRUN_RESULT_UPLOAD_URL=fake.url + "/upload",
        )
    )
    assert len(fake.matching("/result")) == 1 - delta
    assert len(fake.matching("/upload")) == delta


def test_invalid_status_never_throws_in_either_mode(fake: Fake) -> None:
    body = 'ctx.status(object())\nctx.status("bad data", data={"x": object()})\nreturn input'
    assert_ok(execute(body, fake))
    assert_ok(execute(body))
    assert json.loads(fake.matching("/status")[0].body) == {"message": "bad data"}


def test_missing_run_environment_has_no_http_calls(fake: Fake) -> None:
    result = execute("return input", fake, KRUN_TOKEN="")
    assert result.returncode == 1
    assert not fake.calls


def test_transport_diagnostics_do_not_echo_url_response_or_token(fake: Fake) -> None:
    fake.respond = lambda call: (
        (403, b"krun-test-private-response", 0)
        if call.path.startswith("/upload")
        else (200, b"{}", 0)
        if call.path.endswith("/input")
        else (204, b"", 0)
    )
    result = execute(
        'return "large"',
        fake,
        KRUN_MAX_RESULT_BYTES="1",
        KRUN_RESULT_UPLOAD_URL=fake.url + "/upload?krun-test-private-query",
    )
    assert result.returncode == 1
    output = result.stdout + result.stderr + fake.matching("/error")[0].body.decode()
    assert fake.url not in output
    assert "krun-test-token" not in output
    assert "krun-test-private" not in output
