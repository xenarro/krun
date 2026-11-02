# __KRUN_NAME__

A one-shot Python function using krun ~=__KRUN_VERSION__. Requires Python3.11+ and uv.
The SDK is the only runtime dependency; pytest is development-only.
The Python project is named krun-function-__KRUN_NAME__ to avoid a self-dependency
when the Function is named krun. The Function name remains __KRUN_NAME__.

## Local loop

    uv sync
    uv run pytest
    printf '%s\n' '{"name":"world"}' | uv run python handler.py

Leave KRUN_GATEWAY_URL unset for local mode. Results go to stdout; status and
logs go to stderr. Importing handler does not start the SDK. Customize handle
in handler.py; the starter reports loading/0.1 and returns {"rows":42}.
A CPU-bound synchronous handler or a GIL-holding extension can starve the
heartbeat thread; heartbeatTimeout must exceed the longest such gap.

For unpublished development, build the SDK wheel, copy it into vendor/ and run
`uv add ./vendor/krun-*.whl` before `uv run pytest` and `docker build .`.
Keep the resulting uv.lock: the Dockerfile uses locked installation when it
exists, copying the whole project (including vendor/) before installation.
The image excludes development dependencies and runs as numeric65532:65532
with HOME=/tmp, no bytecode writes and unbuffered output. Runtime writes must
stay under /tmp; the image supports a read-only root filesystem.

## Deploy loop

    krun deploy --registry registry.example.com/team

Deploy is the CLI golden path (P8.7 in krun development); it builds/pushes,
writes the digest, validates, applies and waits Ready=True. Until that command
is available in your CLI build, use the manual steps below. The starter image
REPLACE_WITH_DIGEST is intentionally invalid and must never be applied as-is.

Manual steps behind deploy:

    docker build -t registry.example.com/team/__KRUN_NAME__:dev .
    docker push registry.example.com/team/__KRUN_NAME__:dev

Copy this invocation's digest from docker push output into spec.image as
`registry.example.com/team/__KRUN_NAME__@sha256:<digest>` in function.yaml, then:

    krun validate function.yaml
    kubectl apply -f function.yaml -n krun
    kubectl get kfn __KRUN_NAME__ -n krun -w

After Ready=True, set KRUN_API_URL and KRUN_API_KEY for the public API, then:

    curl -X POST "$KRUN_API_URL/v1/functions/__KRUN_NAME__/runs" \
      -H "Authorization: Bearer $KRUN_API_KEY" \
      -H "Content-Type: application/json" -d '{"input":{"name":"world"}}'

Keep the API key in the environment, never in source or function.yaml. The CLI
never uses KRUN_GATEWAY_URL; only the SDK uses that private-runtime setting.
