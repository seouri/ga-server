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
# The containers run on UTC unless .env names the host's time zone; dates and "today" then follow your clock.
if ! grep -q '^TZ=' .env 2>/dev/null; then
  tz=$(readlink /etc/localtime 2>/dev/null | sed -n 's|.*zoneinfo/||p')
  if [ -n "$tz" ] && node -e 'new Intl.DateTimeFormat("en", { timeZone: process.argv[1] })' "$tz" 2>/dev/null; then
    [ -s .env ] && [ -n "$(tail -c1 .env)" ] && echo >> .env # a last line without newline would swallow TZ
    echo "TZ=$tz" >> .env
    echo "==> time zone $tz written to .env"
  else
    echo "Could not tell this computer's time zone: add TZ=<zone, e.g. America/New_York> to .env"
  fi
fi
# GA keeps its records in Medplum. GA's own SQLite store is not yet for use; a development install whose config says
# "store": "sqlite" gets the sqlite compose profile (ga-store) instead.
if [ -f .ga/config.json ] && grep -q '"store": *"sqlite"' .ga/config.json; then
  echo "==> docker compose --profile sqlite up -d ga-store (waits until GA's store is ready)"
  docker compose --profile sqlite up -d --wait --wait-timeout 120 ga-store
  echo "==> ga setup"
  GA_STORE=sqlite node src/cli.ts setup
  echo "==> docker compose --profile sqlite up -d"
  docker compose --profile sqlite up -d
else
  echo "==> docker compose up -d (waits until the FHIR server is healthy)"
  docker compose up -d --wait --wait-timeout 300
  echo "==> ga setup"
  node src/cli.ts setup
fi
echo "==> npm link (puts 'ga' on your PATH)"
npm link || echo "npm link failed; use 'node src/cli.ts' instead of 'ga'"

echo
echo "GA is ready. Start Claude Code in this folder:  claude"
