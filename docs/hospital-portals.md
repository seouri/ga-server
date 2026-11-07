# Hospital portals (SMART on FHIR)

Back to the [README](../README.md).

GA can fetch your records from Epic patient portals (MyChart) by itself, over SMART on FHIR, with read-only access. You register GA once as your own app with Epic, then connect each hospital once; after that the `ga-sync` service fetches daily. Tokens are encrypted in `.ga/smart/`; nothing leaves the machine except requests to the hospitals' own servers.

## 1. Register the app with Epic (once)

Follow [epic-setup.md](epic-setup.md): make GA's key (`ga keys`), publish its public half, create the app on fhir.epic.com (field-by-field values), answer the Data Use Questionnaire, and test in Epic's sandbox before production. You get two client IDs: the **Client ID** for real hospitals and the **Non-Production Client ID** for the sandbox.

**If Epic issues no refresh tokens.** If Epic issues no refresh token or caps access at about an hour, GA fetches only during `ga connect`: log in again whenever you want fresh data. Between logins the source shows `off`.

## 2. Connect each hospital

Find the hospital's FHIR R4 base URL in Epic's endpoint list (https://open.epic.com/MyApps/Endpoints), for example `https://fhir.example-hospital.org/api/FHIR/R4`.

```sh
ga connect https://fhir.example-hospital.org/api/FHIR/R4 --client-id <client ID> --name "Hospital A"
```

`--client-id` is needed only the first time: the **Client ID** for real hospitals, the **Non-Production Client ID** for Epic's sandbox. Real hospitals also need `--redirect-uri https://<machine>.<tailnet>.ts.net/callback` the first time (production Epic accepts only https; see [https callback](epic-setup.md#https-callback)). Your browser opens the MyChart login; choose the longest access duration offered. GA then runs a **dry run**: it fetches everything, prints per type how many records it fetched and how many would be created, linked to a record GA already holds, updated or flagged, and writes no records (only a status entry, so your agent knows the source is not enabled yet). Records from C-CDA or EHI imports are linked only where Epic shares an ID with the portal: if a type GA already holds from Epic shows `created`, those are likely duplicates of what you have, so leave that type disabled. Enable the types that link or are new to GA:

```sh
ga sync --enable Condition,Observation,MedicationRequest fhir-example-hospital-org
ga sync                 # fetch every connected source now (prints counts only)
ga sync --dry-run       # counts only, writes nothing
ga status               # per source: status, last success, STALE flag, enabled types
ga disconnect fhir-example-hospital-org   # deletes the tokens; records already fetched stay
```

A source's name for these commands is its key (the FHIR host with `-` for `.`, shown by `ga status`) or its `--name`. A source with no enabled types only ever dry-runs; `ga status` shows it `off (not_enabled)` until you enable types. Two syncs of one source never run at once: the second waits up to 30 seconds, then reports `busy` and changes nothing. After `ga disconnect`, `ga connect` reconnects it.

## 3. Daily sync

`docker compose up -d` also starts `ga-sync`, which runs `ga sync --daemon`: a sync at startup, then once 24 hours have passed (it checks hourly, so a sleeping Mac catches up on wake; an hour after a failed run), logging counts only (`docker compose logs ga-sync`). It runs as your user so files in `.ga/` stay yours; on Linux export your ids first (`UID=$(id -u) GID=$(id -g) docker compose up -d`, or put `UID` and `GID` in `.env`). Docker Desktop on macOS maps ownership itself.

## What syncs and what doesn't

Synced: every patient-scoped type the portal offers (problems, diagnoses, labs, vitals, medications, immunizations, allergies, procedures, encounters, reports, clinical notes and more). Records already in GA from C-CDA or EHI imports are linked, not copied; re-fetching unchanged data changes nothing.

Not synced: MyChart messages and some note types (they keep coming from EHI exports); Quest and LabCorp results not ordered through Epic; Apple Health (import its export); PDFs (`/ga-import`).

**Stale sources.** If a source is `off` (login needed), `error`, or not synced for over 48 hours, `ga status` marks it STALE and your agent says so in the first line of its answer. `off`: run `ga connect <url>`, except `off (not_enabled)`: enable types with `ga sync --enable <Type,...> <source>`. `error`: retried on the next run, or `ga sync` now.

**From chat.** Connected apps ([GA from chat apps](chat-apps.md)) can run `hospital_connect` (it returns the MyChart login link to open), `hospital_status`, `hospital_enable` (preview of the dry-run counts first, then you confirm on GA's confirm page), `hospital_sync` and `hospital_disconnect`. This needs the https redirect below; Epic's sandbox stays `ga connect` in Terminal.

**Troubleshooting `ga connect`.** The MyChart login returns to GA through the Endpoint URI registered with Epic: `https://<machine>.<tailnet>.ts.net/callback` (Tailscale Funnel) for real hospitals, `http://localhost:8765/callback` for Epic's sandbox. The https callback is received by `ga-gateway` (port 8110, must be running); the sandbox callback by a listener on 127.0.0.1:8765 that exists only while `ga connect` waits. A login that never returns: check `tailscale funnel status` shows `/` proxying to `127.0.0.1:8110`, that `docker compose ps ga-gateway` is up, and that a firewall on the Mac allows Tailscale. For the sandbox, check nothing else holds port 8765 (`lsof -i :8765`). Epic showing "The request is invalid" means it doesn't know that redirect address (a newly added one can take hours to reach Epic); "Something went wrong trying to authorize the client" means that hospital doesn't have GA's app yet. Failures are safe: the code is useless without GA's private key, PKCE verifier and state.
