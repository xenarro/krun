"""Real synchronous SDK handlers; stdin is a test-only server release barrier."""

from __future__ import annotations

import sys
from typing import cast
from urllib.parse import urlsplit

from krun import Context, _runtime, run


def mutate_media(mutation: str) -> None:
    """Change real SDK calls only in this isolated fixture, without editing SDKs."""
    original = _runtime._request

    def request(
        url: str,
        method: str,
        body: bytes | None,
        headers: dict[str, str],
        timeout: float,
        retry: bool,
        success: int,
    ) -> bytes:
        headers = dict(headers)
        if urlsplit(url).path.startswith("/internal/"):
            if (mutation == "media-writes" and method != "GET") or (
                mutation == "media-get" and method == "GET"
            ):
                headers["Content-Type"] = "text/plain"
            if mutation == "media-empty-get" and method == "GET":
                headers["Content-Type"] = ""
            if mutation == "media-parameters":
                headers["Content-Type"] = "Application/JSON; charset=UTF-8"
            if mutation == "media-omit":
                headers.pop("Content-Type", None)
        return original(url, method, body, headers, timeout, retry, success)

    _runtime._request = request


def handle(input: object, ctx: Context) -> object:
    handler, mutation = sys.argv[1:3]
    if handler == "echo":
        return input
    if handler == "void":
        return None
    if handler == "status_then_heartbeat":
        ctx.status("loading", 0.1)
        sys.stdin.readline()
        return {"rows": 42}
    if handler == "two_status":
        messages = (
            ["second", "first"] if mutation == "swap-statuses" else ["first", "second"]
        )
        for message in messages:
            ctx.status(message)
        return {"rows": 42}
    if handler == "slow_result":
        ctx.status("loading", 0.1)
        return {"rows": 42}
    if handler == "status_input":
        value = cast("dict[str, object]", input)
        ctx.status(
            str(value["message"]), cast("float", value["progress"]), value["data"]
        )
        return None
    if handler == "wait_void":
        sys.stdin.readline()
        return None
    if handler == "throws":
        value = cast("dict[str, object]", input)
        error = type(str(value["type"]), (Exception,), {})
        raise error(str(value["message"]))
    raise ValueError("unknown conformance handler")


if __name__ == "__main__":
    if sys.argv[2].startswith("media-"):
        mutate_media(sys.argv[2])
    run(handle)
