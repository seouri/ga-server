# Running GA: data, backup, uninstall

Back to the [README](../README.md).

## Where data lives

| What | Where |
|---|---|
| Health records (FHIR database) | Docker volume `ga-server_ga-postgres` |
| Stored files (PDFs, notes, export archives) | Docker volume `ga-server_ga-binary` |
| Config, admin password, client secret | `.ga/config.json` (gitignored, mode 0600) |
| Portal signing key, client ID, sources, encrypted tokens | `.ga/smart/` |
| Shares and their encrypted link tokens | `.ga/share/` |

All ports bind to `127.0.0.1`. Nothing is reachable from the network unless you turn on Tailscale Funnel, which exposes one service, `ga-gateway` (port 8110): share links, the hospital login return `/callback` and, only if `GA_PUBLIC_URL` is set in `.env`, chat-app access (`/mcp`, login and upload pages; see [GA from chat apps](chat-apps.md)). The FHIR server and admin app are never exposed. Chat-app logins live in `.ga/` and come back with a restore.

`ga-sync` and `ga-gateway` use the time zone in `.env` (`TZ`) for dates: an import without its own zone, Apple Health daily totals, share dates and "today". `./setup.sh` writes your computer's zone there; an older install adds it once (on a Mac, `echo TZ=$(readlink /etc/localtime | sed 's|.*zoneinfo/||') >> .env`, or `echo TZ=America/New_York >> .env` with your zone), then `docker compose up -d`. Without it the containers use UTC.

After changing `.env`, run `docker compose up -d`. The services restart on their own after a reboot or Docker restart. Share links, chat apps and daily sync work only while the computer is awake and online: on a Mac, keep it plugged in and stop it sleeping (System Settings, Battery or Lock Screen, or run `caffeinate -s`).

## Backup

**Back up all three:** the database, the stored files and `.ga/`. A backup holds all of your health records: keep it encrypted, for example on a FileVault disk or in an encrypted disk image, never in an unencrypted cloud folder. Run from the repo folder while GA is running:

```sh
mkdir -p ~/ga-backup && chmod 700 ~/ga-backup
docker compose exec -T postgres pg_dump -U medplum -Fc medplum > ~/ga-backup/ga-postgres.dump
docker run --rm -v ga-server_ga-binary:/b:ro -v ~/ga-backup:/out postgres:16 tar czf /out/ga-binary.tgz -C /b .
cp -Rp .ga ~/ga-backup/dot-ga
```

The `ga-backup` compose service does this every night into `./backups` (or `GA_BACKUP_DIR`), one dated folder per run, newest 7 kept; on Linux run `mkdir -p backups` first (Docker would create it root-owned). To restore from one of those folders, set `B=$PWD/backups/<date_time>` (absolute: `docker run -v` treats a relative path as a volume name) and use `$B/ga-postgres.dump`, `$B/ga-binary.tgz` (in place of `~/ga-backup/...`), and for `.ga` run `mkdir .ga && tar xzf $B/dot-ga.tgz -C .ga` instead of the `cp` line below.

## Restore

On the same or a new Mac, after cloning the repo (don't run `setup.sh`: the backup already holds your patient and admin account):

```sh
cp -Rp ~/ga-backup/dot-ga .ga
npm install && npm link
docker compose up -d --wait
docker compose stop medplum-server ga-sync ga-gateway
docker compose exec -T postgres sh -c 'dropdb -U medplum medplum && createdb -U medplum medplum'
docker compose exec -T postgres pg_restore -U medplum -d medplum --no-owner < ~/ga-backup/ga-postgres.dump
docker run --rm -v ga-server_ga-binary:/b -v ~/ga-backup:/in postgres:16 tar xzf /in/ga-binary.tgz -C /b
docker compose up -d --wait
```

## Uninstall

```sh
docker compose down          # stops GA; your records stay in the Docker volumes
docker compose down -v       # also DELETES all records and stored files (back up first)
npm unlink -g ga-server      # removes the ga command
tailscale funnel reset       # stops exposing GA to the internet
```

Then delete the repo folder, which includes `.ga/` with your keys and tokens. Also remove GA's access in each hospital's MyChart (or `ga disconnect <source>` first).

## Concept layer

Run `node src/cli.ts concepts apply` after an upgrade. The learned maps are in the FHIR server, so backup and restore cover them. Details: [One test, one name](concepts.md).

## Admin app

The FHIR server's admin app runs at http://localhost:3000. Log in as `admin@example.com` with the `adminPassword` from `.ga/config.json`: `ga setup` replaces the seeded default with a random password and stores it there (mode 0600). Re-running setup reuses it. **Back up `.ga/config.json`**: it holds the only copy of the admin password and client secret, and losing it locks you out of the admin account.

## GA's own project

GA keeps your record in its own Medplum project, `Guardian Angel`. Its login (`ga-server-cli`) is an ordinary member limited by an access policy to health records: it cannot read logins, secrets or other projects. The admin account is only for the admin app; choose the `Guardian Angel` project there to see your record.

Installs set up before this change kept everything in Medplum's Super Admin project, where every login is a super admin; `ga setup` then stops with "run ga migrate". To move:

1. Back up first (above), and stop the services that write to GA: `docker compose stop ga-gateway ga-sync`. Then `ga migrate` re-imports from your original files (C-CDA, EHI and Apple Health folders, which must still be where you imported them from; PDF imports come from the copies GA stored) into the new project, copies the share and chat-app access logs, compares counts per record type and the vaccine result, and only then switches `.ga/config.json` (the old one is kept as `.ga/config.super-admin.json`). Share links keep working. On a mismatch it stops without switching; fix what it names and re-run (re-running is safe). Differences that come from today's importers (for example older duplicates now merged) can be accepted after reviewing the table: `ga migrate --accept` switches anyway, and `ga migrate --delete-old --accept` deletes despite them. A PDF whose results all merged into hospital records is not re-stored: import it again (`/ga-import <file>`) after switching.
2. Start them again (`docker compose start ga-gateway ga-sync`) and check GA.
3. `ga migrate --delete-old` deletes the old copy and the old login.

Hospital portal records are not migrated: `ga migrate` stops if there are any.
