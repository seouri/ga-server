# GA Milestone 3: Automatic Sync from Hospital Portals (SMART on FHIR) — Design

Builds on `2026-11-05-ga-server-design.md` (milestone 1), `2026-11-06-ehi-import-design.md` (2a) and `2026-11-05-apple-health-import-design.md` (2b), all shipped. Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

## Intent

"GA always has all of my health data." **[user]** Today GA is only as current as the last export the user downloaded and imported by hand. This milestone connects GA to the user's hospital patient portals once. From then on, GA fetches new and changed records by itself. **[user: fetch by itself]**

**Success test [call]:** after both Epic hospitals are connected, a record that appears in a portal shows up in GA within a day without any manual step. `/ga What's new in my records this week?` answers with it, cited.

## Scope

- **In:** the user's two Epic organizations, through SMART on FHIR patient standalone launch. **[user]**
  - The Epic organization behind the EHI export (identified by its Epic org OID in GA).
  - The second Epic organization found in the Apple Health export (public R4 endpoint advertises `permission-offline` and `private_key_jwt`; base URL from the Apple ClinicalRecord `sourceURL`).
- **Out: Quest and LabCorp. [user]** Neither offers self-service patient app registration. LabCorp's FHIR server is DSTU2 and partner-only (recon); Quest has no public developer access.
  - Results ordered by Epic clinicians already arrive through Epic.
  - Everything else keeps arriving through Apple Health exports and `/ga-import` PDFs.
- **Not available through patient FHIR APIs, so out:** MyChart messages and some note types. These keep coming from occasional EHI exports.
- **Non-goals:** family members (one patient, as before); a web UI; other EHR vendors. Any other SMART R4 endpoint should work with the same code, but only Epic is tested. **[call]**

## Anti-goals

- **No silent staleness.** If a source can't fetch, the user hears about it the next time they use GA.
- **No PHI leaves the machine** except requests to the user's own hospitals' servers.
  - Tokens are encrypted at rest and never logged.
  - Logs and status hold counts and error codes only.
- **No write access.** Read-only scopes only.
- **No duplicates.** Records already in GA from C-CDA or EHI are linked, not copied. Re-fetching unchanged data changes nothing.
- **No new dependency for a few lines** (project rule). Use widely used open-source libraries where they replace real code. **[user]**

## How it works

### One-time setup (per user, then per hospital)

1. **Register the app (the user, once, guided by the README).**
   - Create a free developer account on fhir.epic.com.
   - Register GA as a **patient-facing, confidential (asymmetric key)** app with read-only USCDI R4 APIs and refresh tokens (persistent access).
   - Upload GA's public key, or give its JWKS URL.
   - Mark the app ready for production so Epic distributes the client ID to organizations.
   - **[check]**
     - Exact registration fields.
     - Whether `http://localhost:<port>/callback` is accepted as a production redirect URI.
     - Whether an auto-distributed confidential app with refresh tokens goes live at an organization without per-organization activation (reported as unclear: github.com/jwilleke/yourphr/issues/924).
     - How long distribution takes.
   - Record the answers in the README.
   - **Do this first, before other code.** These answers decide whether sync can be automatic.
   - **Fallback if Epic says no [user: A].** That is, if it refuses a localhost redirect for production, issues no refresh token, or caps access at about 1 hour. GA then fetches only right after each `ga connect`: the user logs in whenever they want fresh data, and the source shows `off` between logins. Never route the login through a hosted page.
2. **Key pair.** `ga keys` generates the RSA (RS384) key pair GA signs client assertions with. It prints the public JWKS to paste into Epic. The private key is stored in `.ga/` with mode 0600, next to `config.json`. **[call]**
3. **Connect each hospital.** `ga connect <name or FHIR base URL>`:
   - Finds the endpoint. Accepts a pasted URL, or searches Epic's published endpoint directory (open.epic.com R4 endpoints / SMART brands bundle) by organization name. **[check]** the directory's current URL and format.
   - Opens the browser for the MyChart login and consent, with PKCE.
   - Listens on a localhost callback.
   - Exchanges the code and stores the tokens, encrypted.
   - Runs the first sync immediately.
   - Tells the user to choose the longest access duration offered on the consent screen.

### Automatic fetching

- **`ga sync [source]`** fetches every connected source now, or one source.
- **Automatic schedule:** a small service in GA's `compose.yaml` runs the same sync code once a day and once at startup, so it keeps working when GA later moves to a server. **[call]** A loop with a 24 h sleep is enough; no scheduler library unless the builder needs cron syntax. **[call]** The service runs the repo's code on the pinned Node image with the repo mounted; the bundled single image is milestone 6. **[check]** whether that image runs the repo the way `node src/cli.ts` does on the host.
- **Each sync, per source:**
  - Refresh the access token. Persist the new refresh token right away, because refresh tokens may rotate.
  - Query every patient-scoped type the server supports, read from its CapabilityStatement:
    - AllergyIntolerance
    - Condition, all categories
    - Observation, by each category Epic requires: laboratory, vital-signs, social-history, survey and others
    - MedicationRequest
    - Immunization
    - Procedure
    - DiagnosticReport
    - DocumentReference, with attachments
    - Encounter
    - CarePlan
    - CareTeam
    - Goal
    - Device
    - Patient
  - Page through all results. Full fetch every time. **[call]** It's small for one person, dedup makes unchanged data a no-op, and Epic's incremental-search support varies. The builder may add `_lastUpdated` where the server honours it.
  - **Clinical notes:** fetch each DocumentReference attachment's Binary.
    - Store HTML, RTF or plain text as an inline `text/plain` attachment, as the EHI notes are, so `fhir_read` shows it.
    - Keep the original content type alongside.
    - Store PDFs and images as Binaries.
  - Write through `importResources`, with a new `SourceInfo.kind = 'smart'`; `src/identity.ts` doesn't have it yet.
    - **Source date:** each resource's `meta.lastUpdated` when the server sends it. **[call]**
    - **When there's no `meta.lastUpdated`:**
      - A **new** record uses the fetch time.
      - For an **existing** record from another source, the portal copy only fills fields that record lacks. It never replaces its body, because a fetch time is not evidence the portal is newer. **[call]**

### Dedup [call; builder refines]

- **Stable identifier:** `urn:ga-server:id:smart:<organization key>` with value `<Type>/<server id>`. The organization key comes from the endpoint host, so two hospitals never collide.
- **Linking to existing records:** Epic resources carry the same Epic-native identifiers (OIDs under `urn:oid:1.2.840.114350.`) as the C-CDA and EHI records. The engine's existing link-by-Epic-identifier path therefore merges them into one record listing every source.
  - **[check]** Measure on real data, counts only: how many fetched resources link, create, update or are flagged, per type.
  - A flood of `possible-duplicate` flags is a defect to fix before shipping.
- **Precedence:** a newer source wins (existing `decide`), so a fresh portal fetch updates an older EHI record. **[check]** Portal resources are often thinner than EHI rows (fewer codes, less detail). Apply the same "a less-specific value never replaces a coded or precise one" fill rule the EHI path uses, so a sync never downgrades a record. Add a test.
- **Patient:** the portal's Patient collapses onto the GA patient (identifiers absorbed, demographics fill-only), as with every other source.
- **Re-sync:** unchanged data reports `created: 0, updated: 0`.
- **Record types with no shared Epic ID [call].** The EHI import attaches Epic link IDs only for orders, problem-list entries, immunizations, encounter CSNs and encounter diagnoses. Notes, vitals, lab components, procedures, allergies, care plans and similar records may have no shared identifier.
  - Before any sync writes to the real patient, run a dry sync into a **test patient** that already holds a copy of the real EHI and C-CDA records. Count create, link and flag per type (counts only).
  - **A type is enabled for the real patient only once its duplicate count is shown to be near zero.**
  - Where needed, add a per-type match key, in this order of preference:
    - an Epic identifier or OID the portal exposes;
    - code plus exact time for Observations;
    - type plus date plus author for DocumentReference;
    - code plus date for Procedure and AllergyIntolerance.
  - A type that can't be matched reliably stays **disabled**, listed in `ga status` and the README, until a later fix. Silent duplicates are not acceptable; flagged ones are acceptable only where the engine already flags them today.
- **Seen, unchanged and vanished records [call].**
  - Every sync stamps each record it fetched, changed or not, with `urn:ga-server:ext:last-seen` set to the sync time. This is a cheap update with no body change and no source-date change. It is the one write an unchanged re-sync makes; the `updated` count excludes it.
  - Records the portal no longer returns are **not** deleted or altered. Their `last-seen` simply falls behind.
  - The medication rule in AGENTS.md and the `/ga` skill becomes:
    - **Current:** an `active` MedicationRequest or MedicationStatement whose `last-seen` matches the newest sync of a connected source.
    - **Unconfirmed:** anything older, which may have been stopped.
  - Agents apply the same reading to other lists, such as problems and allergies.

### Status and notification [user: option 1]

- **Status is stored in Medplum** as one FHIR `Endpoint` resource per connected source, so agents can read it with the existing tools. **[call]** It holds:
  - `status`: `active`, `error`, or `off` when login is needed.
  - `address`: the FHIR base URL.
  - The organization name.
  - Extensions for last successful sync, last attempt, last error code and access expiry, if known.
- Tokens are **not** stored there.
- **`ga status`** prints each source with its state and last successful sync.
- **Warnings in answers:** the `/ga` skill and the MCP server instructions tell the agent to check `Endpoint` status first. When any source is `off`, `error`, or not synced in more than 2 days, the answer starts with one line saying so, for example "Hospital A needs login (last synced Nov 2): run `ga connect <name>`". **[call]**
- **Failure states:**
  - **Expired or revoked refresh token:** the source is marked `off` and stays off until the user runs `ga connect` again.
  - **Network or server errors:** marked `error`, and retried on the next run.

### Security [call]

- **Tokens:** stored encrypted with AES-256-GCM (Node `crypto`). The key file sits in `.ga/` with mode 0600. Same trust boundary as the Medplum admin password already kept in `.ga/config.json`. OS keychain storage was considered and rejected: it doesn't carry over to a server.
- **Scopes:** read-only patient scopes plus `offline_access` (amended in implementation: openid/fhirUser dropped — id_token unused and its validation broke refresh). Never request write scopes.
- **Callback listener:** binds 127.0.0.1 only. It's open only during `ga connect`, and checks `state` and PKCE.
- **Logs:** never contain tokens, names or resource content.

## Libraries [user: widely used open source]

- **OAuth/OIDC client:** [`openid-client`](https://github.com/panva/openid-client), the standard, heavily used Node OAuth library. It provides discovery, PKCE, authorization code, `private_key_jwt` client authentication and refresh. **[call]**
  - Over `fhirclient` (the official SMART JS client), because GA's fetching is server-side and long-running, and needs `private_key_jwt` and refresh-token persistence handled directly.
  - The builder may choose `fhirclient` instead if it covers confidential-asymmetric refresh on Node more simply. Record the reason.
- **FHIR calls:** `@medplum/core` `MedplumClient`, already a dependency, pointed at the hospital base URL with the access token, or plain `fetch`. No new FHIR client.
- **Keys and JWT:** `jose` if `openid-client` doesn't already cover JWK generation and export; it's openid-client's own dependency. Otherwise Node `crypto`.
- **Browser opening:** `open` (widely used), or macOS `open` via `child_process`, whichever is smaller.

## Interfaces

- **CLI:**
  - `ga keys`
  - `ga connect <name|url>`
  - `ga sync [source]`
  - `ga status`
  - `ga disconnect <source>`: deletes the tokens and marks the Endpoint `off`. Records already fetched stay.
- **MCP:** no new tool; `fhir_search Endpoint` reads status. Update the MCP server instructions, `AGENTS.md`, the `/ga` skill and the README:
  - setup steps, including the Epic registration walkthrough;
  - what syncs and what doesn't;
  - the stale-source warning.
- **compose:** one new `ga-sync` service.

## Acceptance

1. Unit tests on synthetic data:
   - token store round-trip, encrypted on disk;
   - refresh-token rotation persisted;
   - Binary note conversion;
   - stale-status rule;
   - fill rule (a sync never downgrades an EHI record);
   - Endpoint status updates.
2. Integration tests against the public SMART sandbox (`launch.smarthealthit.org`) or Epic's sandbox with its test patients: connect, sync twice (the second run reports `created: 0, updated: 0`, with `last-seen` advanced), simulated token expiry → `off`.
3. Real data, counts only:
   - Both hospitals connected.
   - First sync: per-type created, linked and updated counts, with possible-duplicates near zero and each one explained.
   - Second sync: `created: 0, updated: 0`.
   - Every type enabled for the real patient has its dry-run duplicate count recorded.
4. `ga status` and a `/ga` answer show the stale-source warning when a source is forced `off`.
5. Success test above, checked manually by the user.

## Left to the builder

- Exact resource-type list per server (from its CapabilityStatement), paging and retry details.
- Where sync code lives (`src/smart/`, following `src/ehi/` and `src/apple/`).
- Whether the daily schedule needs a library.
