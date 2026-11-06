#!/bin/sh
# One-time GA setup on a new Mac: checks prerequisites, then installs, starts and initializes GA. Safe to re-run.
set -e
cd "$(dirname "$0")"

missing=0
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed: https://docs.docker.com/desktop/setup/install/mac-install/"
  missing=1
elif ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running: open Docker Desktop, wait until it says running, then re-run ./setup.sh"
  missing=1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node 26 (with npm) is not installed: https://nodejs.org/en/download"
  missing=1
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 26 ]; then
  echo "Node $(node -v) is too old; GA needs Node 26 or newer: https://nodejs.org/en/download"
  missing=1
fi
[ "$missing" -eq 0 ] || exit 1

echo "==> npm install"
npm install
echo "==> docker compose up -d (waits until the FHIR server is healthy)"
docker compose up -d --wait --wait-timeout 300
echo "==> ga setup"
node src/cli.ts setup
echo "==> npm link (puts 'ga' on your PATH)"
npm link || echo "npm link failed; use 'node src/cli.ts' instead of 'ga'"

echo
echo "GA is ready. Start Claude Code in this folder:  claude"
