#!/usr/bin/env bash
# Nightly backup (ga-backup compose service): database dump, stored files, .ga/ -> /backups/<YYYY-MM-DD_HHMM>/, keep the newest 7.
# Backups hold real health records: umask 077 (dirs 0700, files 0600).
# Written to /backups/.tmp-<pid> and renamed only when all three files are done. A failed run removes only its own temp directory, keeps every older backup, and exits non-zero;
# the loop reports it and tries again after the next 24 hours. RUN_ONCE=1 runs once and exits with that status.
set -euo pipefail
umask 077

backup() {
  local final=/backups/$(date +%Y-%m-%d_%H%M) tmp=/backups/.tmp-$$
  # a run killed midway leaves only a .tmp-* dir, which never counts toward the 7
  rm -rf /backups/.tmp-*
  [ ! -e "$final" ] || { echo "$final exists" >&2; return 1; }
  mkdir "$tmp" || return 1
  if ! { pg_dump -h postgres -U medplum -Fc medplum > "$tmp/ga-postgres.dump" &&
         tar czf "$tmp/ga-binary.tgz" -C /ga-binary . &&
         tar czf "$tmp/dot-ga.tgz" -C /dot-ga . &&
         mv "$tmp" "$final"; }; then
    rm -rf "$tmp"
    return 1
  fi
  # shortcut: only dirs named like a backup are ever pruned; sorts oldest first by name
  ls -d /backups/????-??-??_???? | sort | head -n -7 | xargs -r rm -rf
  echo "backup ok: $final ($(ls /backups | wc -l) kept)"
}

chmod 700 /backups 2>/dev/null || true
if [ -n "${RUN_ONCE:-}" ]; then backup; exit; fi
while :; do
  backup || echo "backup FAILED; older backups kept" >&2
  sleep 86400
done
