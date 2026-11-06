#!/usr/bin/env bash
# Nightly backup (ga-backup compose service): database dump, stored files, .ga/ -> /backups/<YYYY-MM-DD_HHMM>/, keep the newest 7.
# Backups hold real health records: umask 077 (dirs 0700, files 0600).
# A failed run removes only its own partial directory, keeps every older backup, and exits non-zero;
# the loop reports it and tries again after the next 24 hours. RUN_ONCE=1 runs once and exits with that status.
set -euo pipefail
umask 077

backup() {
  local dir=/backups/$(date +%Y-%m-%d_%H%M)
  mkdir "$dir"
  if ! { pg_dump -h postgres -U medplum -Fc medplum > "$dir/ga-postgres.dump" &&
         tar czf "$dir/ga-binary.tgz" -C /ga-binary . &&
         tar czf "$dir/dot-ga.tgz" -C /dot-ga .; }; then
    rm -rf "$dir"
    return 1
  fi
  # shortcut: only dirs named like a backup are ever pruned; sorts oldest first by name
  ls -d /backups/????-??-??_???? | sort | head -n -7 | xargs -r rm -rf
  echo "backup ok: $dir ($(ls /backups | wc -l) kept)"
}

if [ -n "${RUN_ONCE:-}" ]; then backup; exit; fi
while :; do
  backup || echo "backup FAILED; older backups kept" >&2
  sleep 86400
done
