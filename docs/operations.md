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

All ports bind to `127.0.0.1`. Nothing is reachable from the network unless you turn on Tailscale Funnel for share links and the portal login callback.

## Backup

**Back up all three:** the database, the stored files and `.ga/`. A backup holds all of your health records: keep it encrypted, for example on a FileVault disk or in an encrypted disk image, never in an unencrypted cloud folder. Run from the repo folder while GA is running:

```sh
mkdir -p ~/ga-backup && chmod 700 ~/ga-backup
docker compose exec -T postgres pg_dump -U medplum -Fc medplum > ~/ga-backup/ga-postgres.dump
docker run --rm -v ga-server_ga-binary:/b:ro -v ~/ga-backup:/out postgres:16 tar czf /out/ga-binary.tgz -C /b .
cp -Rp .ga ~/ga-backup/dot-ga
```

## Restore

On the same or a new Mac, after cloning the repo (don't run `setup.sh`: the backup already holds your patient and admin account):

```sh
cp -Rp ~/ga-backup/dot-ga .ga
npm install && npm link
docker compose up -d --wait
docker compose stop medplum-server ga-sync ga-share
docker compose exec -T postgres sh -c 'dropdb -U medplum medplum && createdb -U medplum medplum'
docker compose exec -T postgres pg_restore -U medplum -d medplum --no-owner < ~/ga-backup/ga-postgres.dump
docker run --rm -v ga-server_ga-binary:/b -v ~/ga-backup:/in postgres:16 sh -c 'cd /b && tar xzf /in/ga-binary.tgz && chown -R 1000:1000 /b'
docker compose up -d --wait
```

## Uninstall

```sh
docker compose down          # stops GA; your records stay in the Docker volumes
docker compose down -v       # also DELETES all records and stored files (back up first)
npm unlink -g ga-server      # removes the ga command
tailscale funnel reset       # stops exposing share links and the login callback
```

Then delete the repo folder, which includes `.ga/` with your keys and tokens. Also remove GA's access in each hospital's MyChart (or `ga disconnect <source>` first).

## Admin app

The FHIR server's admin app runs at http://localhost:3000. Log in as `admin@example.com` with the `adminPassword` from `.ga/config.json`: `ga setup` replaces the seeded default with a random password and stores it there (mode 0600). Re-running setup reuses it. **Back up `.ga/config.json`**: it holds the only copy of the admin password and client secret, and losing it locks you out of the admin account.
