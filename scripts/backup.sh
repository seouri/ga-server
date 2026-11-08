#!/bin/sh
# Nightly backup -> $BACKUP_DIR/<YYYY-MM-DD_HHMM>/, keep the newest 7. Two compose services share this script, one per store:
#   ga-backup (postgres image, BACKUP_STORE=medplum): pg_dump, Medplum's stored files, .ga/
#   ga-backup-store (node image, BACKUP_STORE=sqlite): an online copy of .ga/store/ga.db (VACUUM INTO), .ga/store/binary, the rest of .ga/
# Each run reads .ga/config.json and does nothing when the install is on the other store (ga-backup-store runs only with the
# sqlite profile). Backups hold real health records: umask 077 (dirs 0700, files 0600).
# Written to $BACKUP_DIR/.tmp-<store> and renamed only when every file is done. A failed run removes only its own temp directory, keeps every older backup, and exits non-zero;
# the loop reports it and tries again after the next 24 hours. RUN_ONCE=1 runs once and exits with that status.
set -eu
umask 077
B=${BACKUP_DIR:-/backups} GA=${GA_DIR:-/dot-ga}

installed_store() { if grep -q '"store": *"sqlite"' "$GA/config.json" 2>/dev/null; then echo sqlite; else echo medplum; fi; }

sqlite_files() {
  # A second connection to the live WAL database (opened read-write: a reader writes ga.db-shm); VACUUM INTO is one read transaction.
  node -e '
    const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
    db.exec("pragma busy_timeout=5000");
    db.prepare("VACUUM INTO ?").run(process.argv[2]);
    db.close();' "$GA/store/ga.db" "$1/ga.db" &&
  # after the snapshot: a binary file is in place before its row is written, so every row in the copy has its file
  mkdir -p "$GA/store/binary" && tar czf "$1/ga-binary.tgz" -C "$GA/store/binary" . &&
  tar czf "$1/dot-ga.tgz" --exclude=./store/ga.db --exclude='./store/ga.db-*' --exclude=./store/binary -C "$GA" .
}

medplum_files() {
  pg_dump -h postgres -U medplum -Fc medplum > "$1/ga-postgres.dump" &&
  tar czf "$1/ga-binary.tgz" -C "${MEDPLUM_BINARY_DIR:-/ga-binary}" . &&
  # a migrate-store dry run's store (ga.db and its Binary copies) is not this install's data
  tar czf "$1/dot-ga.tgz" --exclude=./store/ga.db --exclude='./store/ga.db-*' --exclude=./store/binary -C "$GA" .
}

backup() {
  local store final tmp
  store=$(installed_store)
  # before touching $B: the other service's run must keep its temp dir
  if [ "${BACKUP_STORE:-$store}" != "$store" ]; then echo "skip: this install is on the $store store"; return 0; fi
  if [ "$store" = sqlite ] && [ ! -f "$GA/store/ga.db" ]; then echo "skip: no $GA/store/ga.db yet"; return 0; fi
  final=$B/$(date +%Y-%m-%d_%H%M) tmp=$B/.tmp-$store
  # a run killed midway leaves only a .tmp-* dir, which never counts toward the 7
  rm -rf "$tmp"
  [ ! -e "$final" ] || { echo "$final exists" >&2; return 1; }
  mkdir "$tmp" || return 1
  if ! { "${store}_files" "$tmp" && mv "$tmp" "$final"; }; then
    rm -rf "$tmp"
    return 1
  fi
  # shortcut: only dirs named like a backup are ever pruned; newest first by name, all past the 7th removed
  ls -d "$B"/????-??-??_???? | sort -r | tail -n +8 | xargs -r rm -rf
  echo "backup ok: $final ($(ls "$B" | wc -l | tr -d ' ') kept)"
}

chmod 700 "$B" 2>/dev/null || true
if [ -n "${RUN_ONCE:-}" ]; then backup; exit; fi
while :; do
  backup || echo "backup FAILED; older backups kept" >&2
  sleep 86400
done
