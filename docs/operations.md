# Running GA: data, backup, uninstall

Back to the [README](../README.md).

## Where data lives

GA keeps your record in Medplum, a FHIR server with Postgres, which `./setup.sh` sets up. GA's own store, a SQLite file served by the `ga-store` service, is in development and **not yet for use**: GA switches to it once it supports the full FHIR spec ([GA's own store](#gas-own-store-not-yet-for-use) below). Until then `ga-store` does not run on a default install (it is in the `sqlite` compose profile).

| What | Where |
|---|---|
| Health records (FHIR database) | Docker volume `ga-server_ga-postgres` |
| Stored files (PDFs, notes, export archives) | Docker volume `ga-server_ga-binary` |
| Config, admin password, client secret | `.ga/config.json` (gitignored, mode 0600) |
| GA's own store (not yet for use): records, stored files, access token | `.ga/store/ga.db`, `.ga/store/binary/`, `.ga/store/token` |
| Portal signing key, client ID, sources, encrypted tokens | `.ga/smart/` |
| Shares and their encrypted link tokens | `.ga/share/` |
| Performance log: tool name, app, timing, size, request count per call (no arguments or records; 30 days; `ga perf`) | `.ga/perf.jsonl` |

On Linux, if your user id is not 1000, put `UID=` and `GID=` lines in `.env` with the numbers `id -u` and `id -g` print: the GA services run as that user so files under `.ga` stay yours (macOS Docker Desktop maps ownership on its own).

All ports bind to `127.0.0.1`. Nothing is reachable from the network unless you turn on Tailscale Funnel, which exposes one service, `ga-gateway` (port 8110): share links, the hospital login return `/callback` and, only if `GA_PUBLIC_URL` is set in `.env`, chat-app access (`/mcp`, login and upload pages; see [GA from chat apps](chat-apps.md)). GA's own store (`ga-store`, port 8120, when its profile is on), the FHIR server and the admin app are never exposed: the gateway does not pass `/fhir` through. Chat-app logins live in `.ga/` and come back with a restore.

`ga-sync` and `ga-gateway` use the time zone in `.env` (`TZ`) for dates: an import without its own zone, Apple Health daily totals, share dates and "today". `./setup.sh` writes your computer's zone there; an older install adds it once (on a Mac, `printf '\nTZ=%s\n' "$(readlink /etc/localtime | sed 's|.*zoneinfo/||')" >> .env`, or `printf '\nTZ=America/New_York\n' >> .env` with your zone), then `docker compose up -d`. Without it the containers use UTC.

After changing `.env`, run `docker compose up -d`. The services restart on their own after a reboot or Docker restart. Share links, chat apps and daily sync work only while the computer is awake and online: on a Mac, keep it plugged in and stop it sleeping (System Settings, Battery or Lock Screen, or run `caffeinate -s`).

## Backup

A backup holds all of your health records: keep it encrypted, for example on a FileVault disk or in an encrypted disk image, never in an unencrypted cloud folder.

Every night a backup service writes one dated folder to `./backups` (or `GA_BACKUP_DIR` in `.env`), newest 7 kept; on Linux run `mkdir -p backups` first (Docker would create it root-owned). The service is `ga-backup`: `ga-postgres.dump`, `ga-binary.tgz` (the `ga-binary` volume) and `dot-ga.tgz` (`.ga/` without `store/ga.db`). For a backup right now: `docker compose run --rm -e RUN_ONCE=1 ga-backup`.

GA's own store (development only, `sqlite` profile) has its own service, `ga-backup-store`: `ga.db` (a consistent copy taken while GA runs, with SQLite's `VACUUM INTO`), `ga-binary.tgz` (`.ga/store/binary/`) and `dot-ga.tgz` (the rest of `.ga/`). Each service skips the night when `.ga/config.json` names the other store. Never copy `.ga/store/ga.db` with `cp` while it runs: the copy can be inconsistent.

## Restore

From one of those folders: set `B=$PWD/backups/<date_time>` (absolute: `docker run -v` treats a relative path as a volume name). Don't run `setup.sh` first: the backup already holds your record and config. On the same or a new Mac, after cloning the repo:

```sh
mkdir -m 700 .ga && tar xzf $B/dot-ga.tgz -C .ga
npm install && npm link
docker compose up -d --wait medplum-server
docker compose stop medplum-server ga-sync ga-gateway
docker compose exec -T postgres sh -c 'dropdb -U medplum medplum && createdb -U medplum medplum'
docker compose exec -T postgres pg_restore -U medplum -d medplum --no-owner < $B/ga-postgres.dump
docker run --rm -v ga-server_ga-binary:/b -v $B:/in postgres:16 tar xzf /in/ga-binary.tgz -C /b
docker compose up -d
```

GA's own store (development only): after the `.ga` line, `mkdir -p -m 700 .ga/store/binary && cp $B/ga.db .ga/store/ga.db && tar xzf $B/ga-binary.tgz -C .ga/store/binary`, then `docker compose --profile sqlite up -d`. Over a running install, `docker compose --profile sqlite stop ga-sync ga-gateway ga-store ga-backup-store` first and remove `.ga/store/ga.db-wal` and `ga.db-shm` before copying.

## Uninstall

```sh
docker compose --profile sqlite down     # stops GA; your records stay in the Docker volumes
docker compose --profile sqlite down -v  # also DELETES all records and stored files (back up first)
npm unlink -g ga-server                # removes the ga command
tailscale funnel reset                 # stops exposing GA to the internet
```

Then delete the repo folder, which includes `.ga/` with your keys and tokens (and GA's own store, if you tried it). Also remove GA's access in each hospital's MyChart (or `ga disconnect <source>` first).

## Concept layer

Run `node src/cli.ts concepts apply` after an upgrade. The learned maps are in GA's record, so backup and restore cover them. Details: [One test, one name](concepts.md).

## GA's own store (not yet for use)

GA switches from Medplum to its own store once that store supports the full FHIR spec (docs/superpowers/specs/2026-11-08-sqlite-store-design.md, "Next phase"). Until then `ga migrate-store --yes` refuses to switch. The dry run works: `ga migrate-store` (CLI only) stops `ga-sync`, `ga-gateway` and `ga-store`, copies your record from Medplum into `.ga/store/ga.db`, checks it (every record's version and patient, every stored file, and GA's read tools answering the same on both), writes a report of counts (no record contents) to `.ga/store/migrate-report.json` and starts `ga-sync` and `ga-gateway` again, still on Medplum (if it cannot stop or start them, it prints the command; then run it with `--services-stopped`). Medplum is only read. To run it again, move `.ga/store/ga.db` (and `ga.db-wal`, `ga.db-shm`, `binary/`) aside first.

GA's own store answers the FHIR requests GA and other FHIR clients make (read, search, create, update, patch, delete, history, batches, `Patient/$everything`). Some FHIR features are not supported yet and give an error instead of an answer: `_summary=true`/`data`/`text`, composite and special search parameters, the `:above`, `:below`, `:in`, `:not-in` and `:of-type` modifiers, chains more than one level deep, `_contained`, `_text`, `_content`, iterating includes, GraphQL, terminology operations and other operations. Where it differs from Medplum it refuses rather than guesses: a transaction is all or nothing, a reference to an undefined `urn:uuid` is an error, a deleted record can't be updated back, and a conditional update or delete needs a real search criterion.

## Admin app (Medplum only)

The FHIR server's admin app runs at http://localhost:3000. Log in as `admin@example.com` with the `adminPassword` from `.ga/config.json`: `ga setup` replaces the seeded default with a random password and stores it there (mode 0600). Re-running setup reuses it. **Back up `.ga/config.json`**: it holds the only copy of the admin password and client secret, and losing it locks you out of the admin account.

## GA's own project (Medplum only)

On Medplum, GA keeps your record in its own Medplum project, `Guardian Angel`. Its login (`ga-server-cli`) is an ordinary member limited by an access policy to health records: it cannot read logins, secrets or other projects. The admin account is only for the admin app; choose the `Guardian Angel` project there to see your record.

Installs set up before this change kept everything in Medplum's Super Admin project, where every login is a super admin; `ga setup` then stops with "run ga migrate". To move:

1. Back up first (above), and stop the services that write to GA: `docker compose stop ga-gateway ga-sync`. Then `ga migrate` re-imports from your original files (C-CDA, EHI and Apple Health folders, which must still be where you imported them from; PDF imports come from the copies GA stored) into the new project, copies the concept maps (agents' mappings and their review history) and the share and chat-app access logs, compares counts per record type and the vaccine result, and only then switches `.ga/config.json` (the old one is kept as `.ga/config.super-admin.json`). Share links keep working. On a mismatch it stops without switching; fix what it names and re-run (re-running is safe). Differences that come from today's importers (for example older duplicates now merged) can be accepted after reviewing the table: `ga migrate --accept` switches anyway, and `ga migrate --delete-old --accept` deletes despite them. A PDF whose results all merged into hospital records is not re-stored: import it again (`/ga-import <file>`) after switching.
2. Start them again (`docker compose start ga-gateway ga-sync`) and check GA.
3. `ga migrate --delete-old` deletes the old copy and the old login.

Hospital portal records are not migrated: `ga migrate` stops if there are any.
