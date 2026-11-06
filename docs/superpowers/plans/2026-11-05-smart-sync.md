# SMART Sync (Milestone 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA connects to the user's Epic patient portals over SMART on FHIR once (`ga connect`), then fetches every record the portal offers by itself, daily. It deduplicates against the existing C-CDA, EHI and Apple data, and reports stale sources inside GA.

**Architecture:** New `src/smart/` module (following `src/ehi/` and `src/apple/`):
- an encrypted token and key store;
- OAuth with `openid-client` v6: standalone launch, PKCE, `private_key_jwt`, refresh with rotation;
- a fetcher that reads each server's CapabilityStatement and pages through every patient-scoped type;
- a sync orchestrator that writes through the shared `importResources` engine with a new `kind: 'smart'`.

Status lives in Medplum as one `Endpoint` resource per source. A dry-run mode (a write-capturing client wrapper) gives per-type create/flag counts, and types are enabled for the real patient only after that. A `ga-sync` compose service runs `ga sync` daily.

**Tech Stack:** TypeScript on Node 26 (runs .ts natively, strip-only), vitest, `@medplum/core` 5.2.14, Medplum via `compose.yaml`. New dependencies: `openid-client@6.8.9` and `jose@6.2.15` (openid-client's own dependency, used directly for keys). Nothing else.

**Spec:** `docs/superpowers/specs/2026-11-05-smart-sync-design.md`

## Global Constraints

**Dependencies**
- Only `openid-client@6.8.9` and `jose@6.2.15`, pinned exactly.
- No browser-opening library: use `child_process.execFile('open', [url])` on macOS and print the URL elsewhere.
- No scheduler library: a loop with a 24 h sleep.

**Node**
- Node runs `.ts` with **strip-only types**: no parameter properties, enums, namespaces or other non-erasable TypeScript syntax. `npm test` includes `tests/llm.test.ts`, which spawns the CLI and catches this.

**Privacy and security**
- No PHI in the repo or logs. Fixtures are synthetic. Logs, status and reports hold counts, type names and error codes only. Never log tokens, names or resource content.
- Nothing leaves the machine except requests to the configured hospital FHIR and OAuth endpoints.
- Read-only scopes only: `offline_access launch/patient patient/*.read` (amended in implementation: openid/fhirUser dropped — id_token unused and its validation broke refresh). For a server advertising `permission-v2`, `patient/*.rs` is acceptable.
- The callback listener binds `127.0.0.1` only, on port `8765`, path `/callback`; redirect URI `http://localhost:8765/callback`. It checks `state` and uses PKCE S256.

**Files**

| Path | Contents | Mode |
|---|---|---|
| `.ga/smart/key.bin` | 32 random bytes, the AES-256-GCM key | 0600 |
| `.ga/smart/private.jwk.json` | signing private key | 0600 |
| `.ga/smart/public.jwks.json` | signing public JWKS | — |
| `.ga/smart/app.json` | `{ clientId }` | — |
| `.ga/smart/sources.json` | non-secret source list | — |
| `.ga/smart/tokens/<source>.enc` | encrypted tokens | 0600 |

- All paths are under `dirname(defaultConfigPath())` (`src/config.ts`).
- The signing key is RS384.

**Identifiers, tags and extensions**
- Identifier system: `urn:ga-server:id:smart:<sourceKey>`, value `<ResourceType>/<server id>`.
  - `sourceKey` = the FHIR base URL host, lower-cased, with `.` replaced by `-`.
  - The original resource identifiers (Epic OIDs) are kept after it, for linking.
- Source tag: `src-smart`, via `stamp`.
- New extension: `urn:ga-server:ext:last-seen` (`valueDateTime`).
- Status resource: `Endpoint` with `identifier` `urn:ga-server:id:smart-source|<sourceKey>`. Its extensions:
  - `urn:ga-server:ext:smart-last-success`
  - `urn:ga-server:ext:smart-last-attempt`
  - `urn:ga-server:ext:smart-last-error` (`valueCode`)
  - `urn:ga-server:ext:smart-access-expires`
  - `urn:ga-server:ext:smart-enabled-types` (`valueString`, comma list)

**Rules and commands**
- Stale rule: a source is stale if its Endpoint status is `off` or `error`, or its last success is older than 48 h.
- Never write to the real patient in tests (`createTestPatient` / `cleanupTestPatient` from `tests/integration/helpers.ts`).
- Unit tests: `npm test`. Integration tests (need `docker compose up -d`): `npm run test:int -- <file>`. Typecheck: `npm run typecheck`.

## Review Focus

1. **Rotating refresh tokens.** A server returns a new refresh token on every refresh. The old one must never be used again, and a crash between refresh and save must not lock the user out: persist before use. Test in Task 3.
2. **A server that omits `meta.lastUpdated`.** It must never overwrite a richer EHI record; it only fills missing fields. Test in Task 1.
3. **An unchanged second sync** reports `created: 0, updated: 0`, and every fetched record's `last-seen` advances. Test in Task 5.
4. **References to resources the portal didn't return** (Practitioner, Organization, Location) must not break the write or dangle. They become `display`-only. Test in Task 4.
5. **An expired or revoked refresh token** (`invalid_grant`) sets the Endpoint `off` with error code `invalid_grant`, and sync of the other sources continues. Test in Task 5.

---

### Task 1: Engine — `smart` source kind, per-resource dates, fill-only, last-seen

**Files:**
- Modify: `src/identity.ts` (`SourceInfo`, `stableIdentifier`, `stamp`)
- Modify: `src/engine.ts` (`importResources`)
- Test: `tests/identity.test.ts`, `tests/integration/engine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SourceInfo = {
    kind: 'ccda' | 'pdf' | 'ehi' | 'apple-health' | 'smart';
    file: string; date: string; writer: 'importer' | 'agent'; llm?: boolean;
    dateOf?: (r: Resource) => string | undefined; // per-resource source date; falls back to `date`
    fillOnly?: (r: Resource) => boolean;          // true: may only add fields an existing other-source record lacks
    seenAt?: string;                               // stamp/refresh urn:ga-server:ext:last-seen on every record this import touches or skips
  };
  export const LAST_SEEN = 'urn:ga-server:ext:last-seen';
  ```
- For `kind: 'smart'`, `stableIdentifier` returns the resource's first identifier when its system starts with `urn:ga-server:id:smart:`. Otherwise it throws `GaError('<type> has no SMART identifier')`. Extend the existing EHI/Apple branch rather than adding a fourth copy.

**Engine behaviour:**
- `stamp` uses `s.dateOf?.(r) ?? s.date` for the source-date extension, and sets `LAST_SEEN` to `s.seenAt` when given.
- In `importResources`, when an incoming `smart` resource finds an existing record by stable identifier, by link, or by exact Observation match, and `fillOnly(incoming)` is true and the existing record has no identifier in the incoming stable system:
  - write only the top-level fields the existing record lacks, plus the incoming identifiers;
  - count it as `merged` if anything was added, otherwise `skipped`.
- On any path where an existing record is kept (`skip`, identifier-only merge, fill-only, Apple skip), when `seenAt` is set and the existing record's `LAST_SEEN` differs:
  - update just that extension, adding it if missing;
  - don't count it in `updated`; add `report.seen` (a new counter, `ImportReport.seen: number`) instead.
- **Not in scope:** Apple, EHI, C-CDA and PDF behaviour is unchanged (none set `dateOf`, `fillOnly` or `seenAt`).
- **Review amendments (binding):**
  - **`body()` (engine.ts ~line 58) also strips `urn:ga-server:ext:last-seen`.** Otherwise every re-sync counts as `updated`.
  - **Fill-only trigger, permanent.** Use fill-only when `fillOnly(incoming)` is true and the existing record carries any identifier from another GA source system (`urn:ga-server:id:ehi:`, `urn:ga-server:id:ccda`, `urn:ga-server:id:pdf`, `urn:ga-server:id:apple-health`). The trigger is not "lacks the smart identifier": that would expire after the first sync.
  - **`fillFrom` also runs for `kind: 'smart'`.** It returns early only for kinds other than `ehi` and `smart`. A newer-dated portal copy therefore never replaces a coded value with a weaker one.
  - **Seen-only and fill-only writes go through `protect()`.** A `conflict` decision gets no `last-seen` stamp.
  - **`ImportReport.seen` is optional (`seen?: number`)**, so `src/ccda.ts:195` and existing `toEqual` tests are unchanged.
  - **`ImportReport.byType?: Record<string, { created: number; linked: number; updated: number; flagged: number; seen: number }>`** is filled when `SourceInfo.kind === 'smart'`. Task 5's dry run reads it.
- **Extra tests:**
  - **Fill-only test:** import the smart Condition **twice**, with different `date`s and no `lastUpdated`. Expect the coded `code` and `note` to survive both runs.
  - **Newer-date test:** a newer-dated **text-only** code must keep the coded EHI code.
  - **Re-import test:** use a different `date` per run and a resource without `lastUpdated`.

- [ ] **Step 1: Failing unit tests (`tests/identity.test.ts`).**
  - `stableIdentifier` for `kind: 'smart'` returns `{system: 'urn:ga-server:id:smart:fhir-example-org', value: 'Observation/1'}`.
  - A smart resource without that identifier throws `/no SMART identifier/`.
  - `stamp` with `dateOf: () => '2026-01-02T00:00:00Z'` writes that source date.
  - `stamp` with `seenAt: '2026-11-05T00:00:00Z'` writes `LAST_SEEN`.
- [ ] **Step 2: Failing integration tests (`tests/integration/engine.test.ts`).** Use a test patient and synthetic Epic-OID identifiers.
  - `fill-only smart never replaces an EHI body`:
    - Start from an EHI Condition with coded `code` and a `note`.
    - A smart Condition with the same Epic link identifier, text-only code, an extra `onsetDateTime`, and `fillOnly: () => true`.
    - Expect: the record keeps the coded `code` and the note, gains `onsetDateTime` and the smart identifier, `merged: 1`.
  - `smart with a real newer date updates`: same setup with `fillOnly: () => false` and `dateOf` newer than the EHI date. Expect `updated: 1`.
  - `unchanged re-import only advances last-seen`:
    - Import a smart batch twice with `seenAt` T1, then T2.
    - Expect the second report `{created: 0, updated: 0, seen: n}`, every record's `LAST_SEEN` = T2, and no body change.
  - Existing Apple, EHI and C-CDA engine tests still pass unchanged.
- [ ] **Step 3: Run.** `npm test -- tests/identity.test.ts` and `npm run test:int -- tests/integration/engine.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run.** `npm test && npm run typecheck && npm run test:int -- tests/integration/engine.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: smart source kind — per-resource dates, fill-only, last-seen`

---

### Task 2: Encrypted store and signing keys

**Files:**
- Modify: `package.json` / `package-lock.json` (add `openid-client@6.8.9`, `jose@6.2.15`, exact versions)
- Create: `src/smart/store.ts`
- Test: `tests/smart-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const smartDir: (cfgPath?: string) => string;                      // <dir of config>/smart
  export function saveSecret(dir: string, name: string, data: unknown): void; // AES-256-GCM, file mode 0600, atomic (write tmp + rename)
  export function loadSecret<T>(dir: string, name: string): T | undefined;   // undefined if absent; GaError('token store unreadable') if tampered
  export function deleteSecret(dir: string, name: string): void;
  export async function ensureKeys(dir: string): Promise<{ publicJwks: { keys: object[] }; publicPem: string; created: boolean }>; // RS384 via jose generateKeyPair('RS384', { extractable: true }) + exportJWK/exportSPKI, kid = JWK thumbprint
  export async function signingKey(dir: string): Promise<{ key: CryptoKey; kid: string }>;
  export type SourceRec = { key: string; name: string; fhirBase: string; patient?: string; enabledTypes?: string[] };
  export function readSources(dir: string): SourceRec[];
  export function writeSources(dir: string, s: SourceRec[]): void;
  ```
- Storage layout:
  - `key.bin` is created on first use.
  - Encrypted file format: `iv(12) | tag(16) | ciphertext`.
  - Secrets live under `tokens/<name>.enc`.

- [ ] **Step 1: Failing tests.** Use temp dirs.
  - Round-trip of `{refresh_token:'r1'}`.
  - The file on disk doesn't contain `r1`.
  - The file mode is 0600.
  - A flipped byte → `/token store unreadable/`.
  - `ensureKeys` is idempotent: the second call has `created: false` and the same `kid`, and the public JWKS has no `d` field.
  - `signingKey` can sign and verify a JWT with `jose`.
- [ ] **Step 2: Run** `npm test -- tests/smart-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with Node `crypto` (AES-GCM) and `jose` (keys).
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS, including `tests/llm.test.ts`.
- [ ] **Step 5: Commit** `feat: encrypted SMART token store and signing keys`

---

### Task 3: OAuth — connect and refresh, against a mock SMART server

**Files:**
- Create: `src/smart/auth.ts`
- Create: `tests/smart/mock-server.ts`. This is a reusable synthetic SMART + FHIR server on `127.0.0.1`, random port, built on Node `http`:
  - `/.well-known/smart-configuration` advertising `permission-offline`, `client-confidential-asymmetric`, `private_key_jwt`, PKCE S256;
  - an `/authorize` that auto-approves and redirects with `code` and `state`;
  - a `/token` that verifies the client assertion against the registered JWKS, issues `patient`, and **rotates** refresh tokens. A used refresh token returns `invalid_grant`, and a test hook can revoke all tokens.
  - FHIR routes serve fixture Bundles (Task 4 adds them).
- Test: `tests/smart-auth.test.ts`

**Interfaces:**
- Consumes: Task 2 (`saveSecret`, `loadSecret`, `signingKey`, `readSources`, `writeSources`).
- Produces:
  ```ts
  export type Tokens = { access_token: string; refresh_token?: string; expires_at: number; patient: string; scope?: string };
  export async function discover(dir: string, fhirBase: string, clientId: string): Promise<import('openid-client').Configuration>; // reads <fhirBase>/.well-known/smart-configuration; client auth PrivateKeyJwt with signingKey
  export async function connect(dir: string, fhirBase: string, clientId: string, open: (url: string) => void | Promise<void>, opts?: { name?: string; port?: number }): Promise<SourceRec>;
  //   PKCE S256 + state; serves 127.0.0.1:8765/callback once; exchanges code; saves tokens under source key; upserts sources.json; returns the record
  export async function accessToken(dir: string, src: SourceRec, clientId: string): Promise<string>;
  //   returns a valid access token; refreshes when <60s left; saves the rotated refresh token BEFORE returning; throws GaError('invalid_grant') when refresh is refused
  export const sourceKey: (fhirBase: string) => string; // host, lower-case, '.'→'-'
  ```
- Use `openid-client` v6 functions:
  - build the configuration with `new Configuration(serverMetadata, clientId, {}, PrivateKeyJwt(key, { kid }))` from the SMART configuration JSON, which is not OIDC discovery;
  - `buildAuthorizationUrl`, `authorizationCodeGrant`, `refreshTokenGrant`, `randomPKCECodeVerifier`, `calculatePKCECodeChallenge`, `randomState`.
  - Pass the `aud` = fhirBase authorize parameter (SMART requires it).
  - Allow insecure HTTP only when the host is `127.0.0.1` or `localhost` (`allowInsecureRequests` for tests).
- The callback port is 8765. Tests pass an `open` that fetches the URL itself (follows the redirect into the listener), so no browser is needed.
- **Review amendments (binding):**
  - **Client assertion:** `PrivateKeyJwt({ key, kid }, { [modifyAssertion]: (h, p) => { p.aud = <token_endpoint> } })`. The `kid` goes in the key argument. `aud` must be the token endpoint URL (Epic's issuer differs). Confirm against the installed openid-client/oauth4webapi source.
  - **The mock `/token` verifies** the RS384 signature, the `kid` header, `aud === token endpoint`, `iss === sub === clientId` and a unique `jti`.
  - **Callback and redirect:** the listener binds 127.0.0.1, while `redirect_uri` and the `currentUrl` passed to `authorizationCodeGrant` use `http://localhost:<port>/callback`, so they match the registration. The port is an option, so tests can use port 0 or a random port.
  - **Missing fields:** when a refresh response lacks `refresh_token` or `patient`, keep the stored values.
  - **Concurrent refresh:**
    - Wrap refresh and save in an exclusive lock: `.ga/smart/<key>.lock` created with `O_EXCL`, retried briefly, and removed in `finally`; a lock older than 2 minutes is stale.
    - After acquiring the lock, re-read the tokens, because another process may already have refreshed.
    - Test: two concurrent `accessToken` calls cause one refresh and leave a valid token.
  - **Fallback A, no refresh token:** `accessToken` throws `GaError('no_refresh_token')` once the access token expires, and sync marks the source `off` with that code.

- [ ] **Step 1: Failing tests** against the mock server.
  - `connect` stores tokens. The encrypted file exists, and `sources.json` holds `{key, fhirBase, patient}`.
  - The client assertion is RS384-signed with the registered key, verified by the mock.
  - `accessToken` after forced expiry refreshes, and the stored refresh token changes to the new one (rotation persisted).
  - A second refresh with the old token is never attempted: the mock counts reuse = 0.
  - Mock revoke → `accessToken` throws `/invalid_grant/`.
  - A state mismatch on the callback is rejected.
- [ ] **Step 2: Run** `npm test -- tests/smart-auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: SMART standalone launch with private_key_jwt and rotating refresh`

---

### Task 4: Fetch and map

**Files:**
- Create: `src/smart/fetch.ts`
- Create: `tests/fixtures/smart/` with synthetic Epic-shaped Bundles:
  - CapabilityStatement;
  - Patient;
  - Condition (problem-list-item with an Epic OID identifier);
  - Observation (laboratory with an `encounter` ref, vital-signs);
  - Encounter;
  - DocumentReference whose attachment is `Binary/n1` (`text/html`), plus another with `text/rtf`;
  - MedicationRequest with a `requester` → Practitioner (not returned);
  - a paged Observation result (2 pages).
- Modify: `tests/smart/mock-server.ts` to serve them.
- Test: `tests/smart-fetch.test.ts`

**Interfaces:**
- Consumes: Task 3 `accessToken`.
- Produces:
  ```ts
  export const OBS_CATEGORIES = ['laboratory', 'vital-signs', 'social-history', 'survey', 'exam', 'imaging', 'procedure', 'activity', 'therapy'];
  export async function fetchAll(fhirBase: string, token: string, patient: string, types?: string[]):
    Promise<{ resources: Resource[]; byType: Record<string, number>; skipped: Record<string, string> }>;
  export function mapForGa(rs: Resource[], src: SourceRec): Resource[];
  ```

**Fetching:**
- Types = patient-scoped types listed in the server's CapabilityStatement with a `search-type` interaction, intersected with `types` when given.
- Always include `Patient/<patient>`.
- Observation is searched once per category. A 4xx for a category is recorded in `skipped` and the sync continues.
- Follow `link[relation=next]` to the end.
- Fetch DocumentReference attachments whose `url` is a `Binary/` reference.
- **Review amendments (binding):**
  - **Condition** is searched per category too: `problem-list-item`, `encounter-diagnosis`, `health-concern`. A category the server rejects is recorded in `skipped`.
  - **De-duplicate** fetched resources by `Type/id` (category searches overlap, and Patient is read and searched).
  - **Medications:** read each `Medication` referenced by `medicationReference` into the batch, so the RxNorm coding isn't lost (the engine links Medication as SHARED).
  - **Fixtures** include a MedicationRequest with `medicationReference` and an Observation carrying two categories.

**Mapping (`mapForGa`):**
- Prepend the identifier `{system: 'urn:ga-server:id:smart:<key>', value: 'Type/id'}` and keep existing identifiers.
- Keep `id` = the server id so batch references resolve. The Patient keeps its id and collapses (engine).
- References to types not in the batch become `{display}` only, or are dropped if there's no display.
- Notes:
  - `text/html` becomes plain text (strip tags, decode entities, collapse whitespace).
  - `text/rtf` becomes text via the existing `rtfToText` (`src/ehi/rtf.ts`, or wherever `rtfToText` lives).
  - Plain text is kept as is.
  - All of these are stored as an inline `text/plain; charset=utf-8` attachment, with the original content type recorded on `attachment.title` as `"<title> (original: <type>)"`.
  - PDFs and images are stored as Binaries. `mapForGa` returns them as pending uploads, Task 5 creates them with `client.createBinary` (as in `src/document.ts`), and the attachment `url` becomes `Binary/<id>`. They are never inlined: Medplum's max JSON size is 1 MB.
- `meta` is removed except `lastUpdated`, which Task 5's `dateOf` reads. Store it on a non-FHIR side map rather than in the resource if the engine would otherwise write it; the implementer picks.

- [ ] **Step 1: Failing tests** against the mock with fixtures.
  - `fetchAll` returns every fixture resource, and both Observation pages.
  - `byType` counts are right.
  - An Observation category the mock rejects with 400 lands in `skipped`.
  - `mapForGa`:
    - the first identifier is the SMART one and the Epic OID identifier is kept;
    - the MedicationRequest `requester` is display-only (Review Focus 4);
    - the HTML and RTF notes become readable text containing the fixture sentence;
    - the Observation `encounter` reference is unchanged (in batch).
- [ ] **Step 2: Run** `npm test -- tests/smart-fetch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fetch every patient-scoped type from a SMART server and map for GA`

---

### Task 5: Sync, dry-run, status

**Files:**
- Create: `src/smart/sync.ts`
- Test: `tests/integration/smart-sync.test.ts` (mock server + Medplum + test patient)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  ```ts
  export type SyncResult = { source: string; status: 'active' | 'error' | 'off'; report?: ImportReport; perType?: Record<string, { created: number; flagged: number }>; error?: string; skipped?: Record<string, string> };
  export async function syncSource(client: MedplumClient, dir: string, src: SourceRec, patientId: string, opts?: { dryRun?: boolean; now?: Date }): Promise<SyncResult>;
  export async function syncAll(client: MedplumClient, dir: string, patientId: string, opts?: { dryRun?: boolean }): Promise<SyncResult[]>; // one failure never stops the others
  export async function readStatus(client: MedplumClient, patientId: string): Promise<{ source: string; name: string; status: string; lastSuccess?: string; stale: boolean; enabledTypes: string[] }[]>;
  export const isStale: (status: string, lastSuccess: string | undefined, now: Date) => boolean; // off|error, or lastSuccess older than 48 h
  ```

**`syncSource`:**
1. Get an access token. On `invalid_grant`, mark the source `off`; on other errors, mark it `error`.
2. `fetchAll(types = src.enabledTypes)` when `enabledTypes` is set. In a dry run, fetch all types.
3. `mapForGa`.
4. `importResources(client, resources, source, patientId, '')` with:
   - `kind: 'smart'`, `file: fhirBase`, `date: now`, `writer: 'importer'`;
   - `dateOf: r => lastUpdated(r)`;
   - `fillOnly: r => !lastUpdated(r)`;
   - `seenAt: now`.
5. Upsert the Endpoint status resource: `status`, `address` = fhirBase, `name`, and the extensions from Global Constraints.

**Dry run:**
- Pass `importResources` a wrapper around the client whose `createResource` returns `{...r, id: randomUUID()}` and whose `updateResource` / `patchResource` return their input. Every other method passes through.
- Count creates per type, and creates tagged `possible-duplicate` as `flagged`.
- Nothing is written, including the Endpoint.

**Enabling types:** no `enabledTypes` (first connect) means the source is **not synced for real** until types are enabled. `ga sync` prints "dry run only: enable types after reviewing counts" (Task 6 adds `--enable`).
- **Review amendments (binding):**
  - **Dry-run counts:** per-type counts come from `ImportReport.byType` (created, linked, updated, flagged, seen). The wrapper only prevents writes, and it also stubs `createBinary`. The dry-run test checks that the Patient's `meta.versionId` is unchanged.
  - **Endpoint validity:** the Endpoint resource sets `connectionType` `{system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest'}` and `payloadType: [{text: 'FHIR R4'}]`, both required in R4.
  - **One timestamp:** `smart-last-success` uses the same `now` as `seenAt`.
  - **Binaries:** pending Binaries from `mapForGa` are created before `importResources`, then attachment URLs are set.
  - **Two-run link test:** the link test runs two syncs, and the EHI coded code and note survive both.

- [ ] **Step 1: Failing integration tests.** Use the mock server and a test patient; the test patient's identifier set and cleanup are as usual.
  - Dry run: `perType` counts match the fixtures and nothing is written (the test patient's compartment count is unchanged).
  - With all types enabled, the first sync creates the resources and the Endpoint is `active`.
  - The second sync reports `created: 0, updated: 0` with `seen` > 0, and `LAST_SEEN` advanced (Review Focus 3).
  - Mock revoke → `status: 'off'`, `lastError` `invalid_grant`, and a second configured source still syncs (Review Focus 5).
  - `isStale` unit cases: `active` 47 h → false, 49 h → true, `off` → true.
  - `readStatus` lists the source with `stale` correct.
  - Fixture Condition with an Epic OID identifier matching a pre-created EHI-style Condition on the test patient → linked, not created (`merged`), and the coded EHI code is kept when the fixture has no `lastUpdated`.
- [ ] **Step 2: Run** `npm run test:int -- tests/integration/smart-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run test:int -- tests/integration/smart-sync.test.ts tests/integration/engine.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: SMART sync with dry-run counts, last-seen and Endpoint status`

---

### Task 6: CLI, compose service, docs and agent guidance

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/config.ts`: `GA_BASE_URL` env overrides `cfg.baseUrl`, for the container.
- Modify: `compose.yaml`: service `ga-sync`.
- Modify: `src/mcp.ts`: server instructions.
- Modify: `.claude/skills/ga/SKILL.md`, `AGENTS.md`, `README.md`
- Test: `tests/smart-cli.test.ts` (spawns the CLI against a temp `GA_CONFIG` for argument and usage errors), plus one integration run through `ga sync --dry-run` against the mock.

**CLI:**

| Command | Behaviour |
|---|---|
| `ga keys` | `ensureKeys`; prints the public JWKS JSON and the instruction to paste it into the Epic app registration |
| `ga connect <fhir-base-url> [--client-id <id>] [--name <label>]` | Saves `clientId` to `app.json` when given (required the first time). Opens the browser with macOS `open`, otherwise prints the URL. Then runs a **dry run** and prints per-type counts with the next step. |
| `ga sync [--dry-run] [--enable <Type,...>\|all] [source]` | `--enable` stores `enabledTypes` and syncs. Prints counts only. |
| `ga status` | One line per source: name, status, last success, stale flag, enabled types |
| `ga disconnect <source>` | Deletes the tokens; marks the Endpoint `off` with error `disconnected` |

- Usage errors are `GaError`.
- **Review amendments (binding):**
  - **`ga keys`** prints the public JWKS JSON **and** the SPKI PEM. The README says to upload whichever Epic's registration form accepts. If Epic only takes a JWK Set URL, host `public.jwks.json` at any public static URL: it's a public key, never health data.
  - **`ga connect`** runs a dry run when `enabledTypes` is unset. Otherwise it runs a real sync. Under fallback A, `ga connect` is the only time data is fetched.
  - **`GA_PATIENT_ID`:** the CLI honours `GA_PATIENT_ID` (tests only, as in `mcp.ts`). CLI integration tests use `createTestPatient`, never the real patient.
  - **`ga status`** reads `sources.json` first and prints `no sources connected` without contacting Medplum.
  - **`ga-sync` container user:** the service sets `user:` to the host user's uid:gid (`${UID:-1000}:${GID:-1000}`), and the README notes it, so files under `.ga/` stay writable from the host.
  - **Live sandbox test:** an env-gated test (`GA_SMART_SANDBOX=1`) runs connect, two syncs and forced expiry against `https://launch.smarthealthit.org`. It's skipped when unset, or when the sandbox doesn't support asymmetric client auth; record that in the test.
- **Endpoint directory lookup by name:** not built. **Ruling:** the user pastes the FHIR base URL; the README explains where to find it (Epic's open.epic.com endpoint list). Reason: the directory format is unverified, and two hospitals don't need a search.

**`compose.yaml` `ga-sync` service:**
- `image: node:26-alpine` (pin the exact Node 26 tag already used or available).
- `working_dir: /ga`, volumes `.:/ga:ro` and `./.ga:/ga/.ga`.
- `GA_CONFIG=/ga/.ga/config.json` and `GA_BASE_URL=http://medplum-server:8103/`.
- `command: ['node', 'src/cli.ts', 'sync', '--daemon']`, `depends_on` medplum-server healthy, `restart: unless-stopped`.
- `ga sync --daemon` loops `syncAll` (non-dry) → sleep 24 h, logging counts only.
- **[check]** Whether `.ga` is the config location (`defaultConfigPath`), and whether the repo's `node_modules` (macOS-built) runs on Alpine. All deps are pure JS, so it should. If not, use `node:26-slim`.

**Docs:**
- **README** "Hospital portals (SMART)" section:
  - the Epic registration walkthrough (fhir.epic.com account; patient-facing confidential app; USCDI R4 read APIs; refresh tokens; redirect `http://localhost:8765/callback`; paste `ga keys` output; ready for production; client ID);
  - fallback A (fetch only after each `ga connect` if Epic gives no refresh token);
  - dry run, then `--enable`;
  - what doesn't sync (messages, some notes; Quest and LabCorp via Epic, Apple Health, PDFs);
  - `ga status`.
- **`AGENTS.md`, the `/ga` skill and the MCP server instructions:**
  - Before answering, `fhir_search Endpoint` for `urn:ga-server:id:smart-source`. If any source is stale per the rule, start the answer with one line naming it and the fix (`ga connect <url>`).
  - Medication currency rule: current means `active` with `last-seen` equal to its source's newest sync; otherwise unconfirmed. This replaces the old C-CDA source-date rule where `last-seen` exists, and keeps it for records without `last-seen`.

- [ ] **Step 1: Failing tests.**
  - `ga sync --enable` without a connected source → exit 1 with a usage message.
  - `ga status` with no sources prints `no sources connected`.
  - The `GA_BASE_URL` override is honoured by `loadConfig`.
  - Integration: `ga connect` against the mock with the open hook replaced (inject via env `GA_OPEN=fetch` for tests only, documented in code as test-only), then a dry run prints per-type counts.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement CLI, config override, compose service and docs.**
- [ ] **Step 4: Run.**
  - `npm test && npm run typecheck`.
  - The integration files one at a time.
  - `docker compose config` validates.
  - `docker compose up -d ga-sync` starts and logs "no sources connected" without crashing.
  - Expected: all PASS.
- [ ] **Step 5: Commit** `feat: ga keys/connect/sync/status/disconnect, ga-sync service, docs`

---

### Task 7: Hand-off checklist for the user (no code)

Spec deviations, recorded:
- The pre-enable gate is a **dry run through a read-only client wrapper against the real patient**, not a test patient holding a copy of the data. It is equivalent, because no writes happen, and far cheaper.
- **Search by hospital name is dropped:** the user pastes the FHIR base URL.
- **The Epic registration answers** (spec: "do this first") can't be checked without the user's account. Every unknown has a coded fallback:
  - key format: JWKS or PEM, or hosting `public.jwks.json`;
  - no refresh token: fallback A;
  - localhost redirect refused: fallback A, via a manual redirect page. Ruled out by the user: no hosted login page.
- The user confirms the registration at the end.

Real hospital connection needs the user's Epic developer registration and MyChart login, so it can't run unattended. At the end of the work:
- Report what the user runs, in order: register at fhir.epic.com (README walkthrough), `ga keys`, `ga connect <url>` per hospital, review dry-run counts, `ga sync --enable <types>`, `ga status`.
- Report that the dry-run per-type counts are the gate for enabling types (spec).
