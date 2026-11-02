# __KRUN_NAME__

A one-shot Node function using @krun/sdk ^__KRUN_VERSION__. Requires Node22+.
The SDK is the only dependency; no TypeScript, Effect or test-framework install.

## Local loop

    npm install
    npm test
    printf '%s\n' '{"name":"world"}' | node handler.js

Leave KRUN_GATEWAY_URL unset for local mode. Results go to stdout; status and
logs go to stderr. The handler starts only when invoked as the entrypoint.
A CPU-bound synchronous handler starves heartbeat timers: heartbeatTimeout must
exceed the longest gap between event-loop turns. The starter sends loading/0.1
and returns {"rows":42}; customize handle in handler.js.

For unpublished development, copy a packed SDK into vendor/ and run
`npm install ./vendor/krun-sdk-*.tgz` before npm test and docker build.
The whole project, including vendor/, is copied before dependency installation.
The generated Dockerfile installs from package-lock.json when present, disables
install scripts and runs as numeric65532:65532 with HOME=/tmp. Runtime writes
must stay under /tmp; the image supports a read-only root filesystem.

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
