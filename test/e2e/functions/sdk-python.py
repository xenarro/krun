import time

from krun import run


def handle(input, ctx):
    ctx.status("loading", 0.1)
    action = input.get("action") if isinstance(input, dict) else None
    if action == "error":
        raise RuntimeError("sdk-fixture-error")
    if action == "heartbeat":
        time.sleep(75)
    return {"rows": 42}


if __name__ == "__main__":
    run(handle)
