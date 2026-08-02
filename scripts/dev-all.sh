#!/usr/bin/env bash
#
# Local development: the three processes deployment runs, in one terminal.
#
# They are separate processes for a reason (see docs/deployment.md) — the web server never calls
# GitHub, and a backfill that takes hours cannot live inside an HTTP request. This script only
# saves the three terminals; it does not merge them into one program.
#
# Ctrl-C stops all three: the trap kills the whole process group, so no worker is left running
# against the database after the web server is gone.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example and fill in the GitHub App credentials." >&2
  exit 1
fi

pids=()

shutdown() {
  trap - INT TERM EXIT
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap shutdown INT TERM EXIT

# Prefixed so three interleaved logs stay readable. `fflush` keeps the prefixing from buffering a
# process's output into silence — awk behaves the same on macOS and Linux, where sed does not.
run() {
  local label=$1
  shift
  "$@" 2>&1 | awk -v label="$label" '{ print "[" label "] " $0; fflush() }' &
  pids+=($!)
}

echo "Applying any pending migrations…"
npm run --silent db:migrate

run web npm run --silent dev
run worker npm run --silent worker
run scheduler npm run --silent scheduler

echo "web · worker · scheduler running. Ctrl-C stops all three."
wait
