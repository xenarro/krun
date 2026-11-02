from krun import run


def handle(input, ctx):
    ctx.status("loading", 0.1)
    return {"rows": 42}


if __name__ == "__main__":
    run(handle)
