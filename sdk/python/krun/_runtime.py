"""Standard-library implementation of the internal v1 function contract."""

from __future__ import annotations

import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from types import FrameType
from typing import NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

_VERSION = "0.0.0"


def _encode(value: object) -> bytes:
    return json.dumps(
        value, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def _invalid_constant(value: str) -> NoReturn:
    raise ValueError("input contains a non-JSON number")


def _decode(value: bytes | str) -> object:
    return json.loads(value, parse_constant=_invalid_constant)


def _diagnostic(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _line(value: object, local: bool) -> None:
    print(
        _encode(value).decode("utf-8"),
        file=sys.stderr if local else sys.stdout,
        flush=True,
    )


def _truncate(value: str, maximum: int) -> str:
    used = 2
    characters: list[str] = []
    for character in value:
        size = len(_encode(character)) - 2
        if used + size > maximum:
            break
        characters.append(character)
        used += size
    return "".join(characters)


def _status_payload(
    message: str, progress: float | None, data: object
) -> dict[str, object]:
    payload: dict[str, object] = {"message": _truncate(message or "status", 1024)}
    if progress is not None:
        if (
            not isinstance(progress, bool)
            and math.isfinite(progress)
            and 0 <= progress <= 1
        ):
            payload["progress"] = progress
        else:
            _diagnostic("status progress omitted: outside 0..1")
    if data is not None:
        try:
            encoded = _encode(data)
            snapshot = _decode(encoded)
            if isinstance(snapshot, dict) and len(encoded) <= 4096:
                payload["data"] = snapshot
            else:
                _diagnostic("status data omitted: invalid or above 4096 bytes")
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            _diagnostic("status data omitted: not JSON serializable")
    return payload


def _error_payload(cause: Exception) -> dict[str, object]:
    try:
        try:
            message = str(cause) or "error"
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            message = "function failed"
        try:
            kind = type(cause).__name__ or "Error"
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            kind = "Error"
        try:
            stack = "".join(traceback.format_exception(cause)).splitlines()[:20]
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            stack = []
        details = {"stack": stack}
        while len(_encode(details)) > 8192:
            stack.pop()
        return {
            "type": _truncate(kind, 128),
            "message": _truncate(message, 4096),
            "details": details,
        }
    except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
        return {"type": "Error", "message": "function failed", "details": {"stack": []}}


class ResultWriteError(Exception):
    """The non-void result could not be serialized or stored."""


def _serialize_result(value: object) -> bytes:
    try:
        body = _encode(value)
        if body != b"null":
            return body
    except Exception:  # noqa: BLE001 -- normalize arbitrary user serialization failures
        raise ResultWriteError("result is not a non-null JSON value") from None
    raise ResultWriteError("result is not a non-null JSON value")


class _RequestFailure(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"request rejected (HTTP {status})")
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    # urllib otherwise follows redirects and may forward a run's credentials.
    def redirect_request(
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


_workers: set[subprocess.Popen[bytes]] = set()
_workers_lock = threading.RLock()
_stopping = False
_launch_thread: int | None = None


def _stop_requests() -> None:
    global _stopping
    with _workers_lock:
        _stopping = True
        workers = list(_workers)
    for worker in workers:
        if worker.poll() is None:
            worker.kill()
    for worker in workers:
        worker.wait()


def _fatal() -> NoReturn:
    # A daemon's SystemExit would not cancel a blocked main-thread handler.
    _stop_requests()
    os._exit(1)


def _on_sigterm(signum: int, frame: FrameType | None) -> None:
    global _stopping
    _stopping = True
    # Do not exit between creating a process and registering its ownership.
    # A different launching thread holds the lock until registration finishes.
    if _launch_thread != threading.get_ident():
        _fatal()


def _attempt() -> None:
    """One private urllib attempt; credentials and payloads use pipes only."""
    spec = json.loads(sys.stdin.buffer.readline())
    body = sys.stdin.buffer.read() if spec["has_body"] else None
    try:
        request = Request(
            spec["url"], data=body, headers=spec["headers"], method=spec["method"]
        )
        try:
            response = build_opener(_NoRedirect()).open(
                request, timeout=spec["timeout"]
            )
        except HTTPError as error:
            status = error.code
            error.close()
            result: dict[str, object] = {"status": status}
            payload = b""
        else:
            with response:
                result = {"status": response.status}
                payload = (
                    bytes(response.read())
                    if response.status == spec["success"]
                    else b""
                )
    except (URLError, OSError, HTTPException):
        result, payload = {"failure": "connection"}, b""
    except Exception:  # noqa: BLE001 -- return only a sanitized private protocol failure
        result, payload = {"failure": "invalid"}, b""
    sys.stdout.buffer.write(_encode(result) + b"\n" + payload)
    sys.stdout.buffer.flush()


def _bounded_attempt(
    url: str,
    method: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout: float,
    success: int,
) -> bytes:
    global _launch_thread
    deadline = time.monotonic() + timeout
    message = (
        _encode(
            {
                "url": url,
                "method": method,
                "headers": headers,
                "timeout": timeout,
                "success": success,
                "has_body": body is not None,
            }
        )
        + b"\n"
        + (body or b"")
    )
    # Isolated mode avoids user startup hooks. Import this exact SDK, including
    # in a source checkout, without importing/re-executing the handler module.
    source = str(Path(__file__).resolve().parent.parent)
    code = f"import sys; sys.path.insert(0, {source!r}); from krun._runtime import _attempt; _attempt()"
    with _workers_lock:
        if _stopping:
            _fatal()
        _launch_thread = threading.get_ident()
        try:
            worker = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", code],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            _workers.add(worker)
        finally:
            _launch_thread = None
    if _stopping:
        _fatal()
    try:
        try:
            output, _ = worker.communicate(
                message, timeout=max(0, deadline - time.monotonic())
            )
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.communicate()
            raise TimeoutError("request attempt timed out") from None
        if worker.returncode != 0:
            raise URLError("request worker failed")
    finally:
        if worker.poll() is None:
            worker.kill()
        worker.wait()
        with _workers_lock:
            _workers.discard(worker)
        if worker.stdin:
            worker.stdin.close()
        if worker.stdout:
            worker.stdout.close()
    header, separator, payload = output.partition(b"\n")
    reply = _decode(header)
    if not separator or not isinstance(reply, dict):
        raise URLError("invalid request worker response")
    if reply.get("failure") == "connection":
        raise URLError("request failed")
    if reply.get("failure"):
        raise ValueError("invalid request")
    status = reply.get("status")
    if not isinstance(status, int):
        raise URLError("invalid request worker status")
    if status == 401:
        _fatal()
    if status != success:
        raise _RequestFailure(status)
    return payload


def _request(
    url: str,
    method: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout: float,
    retry: bool,
    success: int,
) -> bytes:
    endpoint = urlsplit(url)
    if (
        endpoint.scheme not in ("http", "https")
        or not endpoint.hostname
        or endpoint.username
        or endpoint.password
    ):
        raise ValueError("invalid HTTP endpoint")
    for attempt in range(4):
        try:
            return _bounded_attempt(url, method, body, headers, timeout, success)
        except (_RequestFailure, URLError, OSError, HTTPException) as cause:
            if _stopping:
                _fatal()
            retryable = (
                not isinstance(cause, _RequestFailure) or 500 <= cause.status <= 599
            )
            if not retry or not retryable or attempt == 3:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable retry state")


class _StatusGate:
    """One daemon owns status I/O; condition notifications coalesce updates."""

    def __init__(self, send: Callable[[bytes], bytes], period: float | None) -> None:
        self._send = send
        self._period = period
        self._heartbeat = time.monotonic() + period if period is not None else math.inf
        self._condition = threading.Condition()
        self._latest = b'{"message":"started"}'
        self._pending = False
        self._closed = False
        self._next_slot = 0.0
        self._waiters: list[threading.Event] = []
        self._thread = threading.Thread(
            target=self._work, name="krun-status", daemon=True
        )
        self._thread.start()

    def status(self, message: str, progress: float | None, data: object) -> None:
        try:
            body = _encode(_status_payload(message, progress, data))
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            _diagnostic("status omitted: invalid payload")
            return
        done = threading.Event()
        with self._condition:
            if self._closed:
                return
            self._latest = body
            self._pending = True
            self._waiters.append(done)
            self._condition.notify()
        done.wait(3)
        with self._condition:
            if done in self._waiters:
                self._waiters.remove(done)

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._pending = False
            for waiter in self._waiters:
                waiter.set()
            self._waiters.clear()
            self._condition.notify()
        # Never join: a status response may still be in flight. The thread is
        # daemonized and cannot keep the process alive after terminal I/O.

    def _work(self) -> None:
        while True:
            with self._condition:
                while True:
                    if self._closed:
                        return
                    now = time.monotonic()
                    if now >= self._heartbeat:
                        self._pending = True
                        self._heartbeat = now + (self._period or math.inf)
                    if self._pending and now >= self._next_slot:
                        body = self._latest
                        waiters, self._waiters = self._waiters, []
                        self._pending = False
                        break
                    due = min(
                        self._heartbeat, self._next_slot if self._pending else math.inf
                    )
                    # Condition.wait rejects delays above the platform's bound.
                    delay = min(threading.TIMEOUT_MAX, max(0, due - now))
                    self._condition.wait(None if math.isinf(due) else delay)
            pending = False
            try:
                self._send(body)
            except Exception as cause:  # noqa: BLE001 -- runtime boundary reports all handler/transport failures
                pending = isinstance(cause, _RequestFailure) and cause.status == 429
                with self._condition:
                    if not self._closed:
                        _diagnostic(
                            f"status dropped (HTTP {cause.status})"
                            if isinstance(cause, _RequestFailure)
                            else "status dropped: request failed or timed out"
                        )
            finally:
                with self._condition:
                    self._next_slot = time.monotonic() + 1
                    if not self._closed:
                        self._pending = self._pending or pending
                    for waiter in waiters:
                        waiter.set()


@dataclass(frozen=True)
class Context:
    """Per-run identifiers and output helpers supplied to the handler."""

    runId: str
    function: str
    _status: Callable[[str, float | None, object], None]
    _local: bool

    def status(
        self, message: str, progress: float | None = None, data: object = None
    ) -> None:
        """Replace the latest report; wait at most three seconds, never throw."""
        try:
            self._status(message, progress, data)
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            _diagnostic("status omitted: invalid payload")

    def log(self, value: object) -> None:
        """Write one JSON line (stderr locally, stdout in a function pod)."""
        _line(value, self._local)


Handler = Callable[[object, Context], object]


def _exit(code: int) -> NoReturn:
    _stop_requests()
    sys.stdout.flush()
    sys.stderr.flush()
    raise SystemExit(code)


def run(handler: Handler) -> NoReturn:
    """Run a synchronous handler once and exit; importing this module is inert."""
    signal.signal(signal.SIGTERM, _on_sigterm)
    run_id = os.environ.get("KRUN_RUN_ID")
    function = os.environ.get("KRUN_FUNCTION")
    gateway = os.environ.get("KRUN_GATEWAY_URL")
    token = os.environ.get("KRUN_TOKEN")
    maximum = os.environ.get("KRUN_MAX_RESULT_BYTES", "262144")
    window = os.environ.get("KRUN_HEARTBEAT_TIMEOUT", "")
    upload = os.environ.get("KRUN_RESULT_UPLOAD_URL")
    if not gateway:
        try:
            if len(sys.argv) > 1:
                value = _decode(Path(sys.argv[1]).read_bytes())
            else:
                value = _decode(sys.stdin.read())
            context = Context(
                run_id or "local",
                function or Path(sys.argv[0]).name,
                lambda message, progress, data: _line(
                    _status_payload(message, progress, data), True
                ),
                True,
            )
            result = handler(value, context)
            if result is not None:
                print(_serialize_result(result).decode("utf-8"), flush=True)
        except Exception as cause:  # noqa: BLE001 -- runtime boundary reports all handler/transport failures
            _line(_error_payload(cause), True)
            _exit(1)
        _exit(0)
    if not run_id or not function or not token:
        _diagnostic("missing required krun run environment")
        _exit(1)
    headers = {
        "Authorization": "Bearer " + token,
        "User-Agent": "krun-sdk-python/" + _VERSION,
        "Content-Type": "application/json",
    }
    base = gateway.rstrip("/") + "/internal/v1/runs/" + quote(run_id, safe="")
    try:
        seconds = float(window)
        period = seconds / 3 if math.isfinite(seconds) and seconds > 0 else None
    except ValueError:
        period = None
    gate = _StatusGate(
        lambda body: _request(base + "/status", "POST", body, headers, 3, False, 204),
        period,
    )

    def report(cause: Exception) -> None:
        try:
            _request(
                base + "/error",
                "PUT",
                _encode(_error_payload(cause)),
                headers,
                10,
                True,
                204,
            )
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            _diagnostic("error report failed")

    code = 1
    try:
        try:
            value = _decode(
                _request(base + "/input", "GET", None, headers, 10, True, 200)
            )
        except Exception:  # noqa: BLE001 -- contain arbitrary user serialization/error hooks
            _diagnostic("input request failed")
            _exit(1)
        try:
            result = handler(value, Context(run_id, function, gate.status, False))
        except Exception as cause:  # noqa: BLE001 -- runtime boundary reports all handler/transport failures
            _diagnostic("handler failed")
            report(cause)
            _exit(1)
        if result is not None:
            try:
                body = _serialize_result(result)
                cap = (
                    int(maximum) if maximum.isascii() and maximum.isdigit() else 262144
                )
                if len(body) <= cap:
                    _request(base + "/result", "PUT", body, headers, 10, True, 204)
                elif upload:
                    _request(
                        upload,
                        "PUT",
                        body,
                        {
                            "Content-Type": "application/json",
                            "Content-Length": str(len(body)),
                            "User-Agent": headers["User-Agent"],
                        },
                        300,
                        True,
                        200,
                    )
                else:
                    raise ResultWriteError(
                        "result exceeds the inline cap without an upload URL"
                    )
            except Exception as cause:  # noqa: BLE001 -- runtime boundary reports all handler/transport failures
                failure = ResultWriteError(
                    f"result write rejected (HTTP {cause.status})"
                    if isinstance(cause, _RequestFailure)
                    else "result serialization or write failed"
                )
                _diagnostic(str(failure))
                report(failure)
                _exit(1)
        code = 0
    finally:
        gate.close()
    _exit(code)
