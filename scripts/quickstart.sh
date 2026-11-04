#!/bin/sh
# Disposable source-checkout rehearsal. Never use the ambient kube context.
set -eu
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: scripts/quickstart.sh embedded|postgres' >&2
  exit 1
fi
case "$1" in
  embedded|postgres) ;;
  *) printf '%s\n' 'Usage: scripts/quickstart.sh embedded|postgres' >&2; exit 1 ;;
esac
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$ROOT/scripts/quickstart.ts" "$1"
