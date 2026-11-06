# GA in Any Chat (Milestone 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner use GA from claude.ai, ChatGPT, Gemini, Grok, Grok Bot or remote Claude Code, with every Terminal-only task available as a chat tool, behind a passkey owner login.

**Architecture:** A new `ga-gateway` service replaces `ga-share` on port 8110, so the existing Funnel route `/` keeps working. It serves the share pages (today's handler), an OAuth server (`oidc-provider`) with passkey login (`@simplewebauthn/server`), a stateless Streamable HTTP MCP endpoint at `/mcp`, `/callback` for hospital logins, and `/upload/<token>`. The tools are built once in `src/mcp.ts` and served over both stdio and HTTP. The gateway talks to Medplum with GA's own credentials, as the CLI does.

**Tech Stack:** Node 26 (TypeScript strip-only), `@modelcontextprotocol/sdk` 1.32.2 (already pinned), `oidc-provider` 9.13.0, `@simplewebauthn/server` 14.0.3, `yauzl` 3.4.0, vitest 5, Medplum 5.2.14 via docker compose.

**Spec:** `docs/superpowers/specs/2026-11-06-remote-agent-design.md`

## Global Constraints

- Node 26 runs `.ts` directly in strip-only mode: no parameter properties, enums or namespaces.
- New dependencies pinned exact, released at least 2 weeks earlier: `oidc-provider` 9.13.0, `@simplewebauthn/server` 14.0.3, `yauzl` 3.4.0. Install with `npm install --save-exact`. No other new runtime dependency.
- No PHI in the repo, tests, fixtures, logs or commit messages. Tests never touch the real patient: integration tests use `tests/integration/helpers.ts` throwaway patients.
- Never run `tailscale funnel` or `tailscale serve` (AGENTS.md); docs tell the user what to run.
- The FHIR server and its admin app stay on localhost. Only `ga-gateway` is published, on `127.0.0.1:8110`.
- The gateway never forwards a chat app's token to Medplum.
- The remote access log records tool name, client name and time only, never arguments or results. Errors to chat apps never echo record content beyond what the tool returns anyway.
- `https://<funnel host>/callback` keeps working for the production Epic app; its path never changes.
- All pages (login, consent, upload) load nothing from third parties, with the same headers and CSP style as `src/share/server.ts`.
- Public URL from `GA_PUBLIC_URL` (e.g. `https://<machine>.<tailnet>.ts.net`, no trailing slash). The MCP resource is exactly `${GA_PUBLIC_URL}/mcp`.
- Lifetimes: access token 1 hour, refresh token 90 days idle, upload link 15 minutes and single use, pending hospital login 10 minutes, owner cookie 12 hours, enrollment link 24 hours and single use.
- Unit tests `npm test`; integration tests one file at a time, `npm run test:int -- tests/integration/<file>.test.ts`, with GA running.

## Review Focus

1. **A bad bearer token on `/mcp`** (expired, revoked, wrong audience, minted for a disconnected client, or none) gets 401 with `WWW-Authenticate: Bearer resource_metadata="<GA_PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"` and runs no tool. Task 9.
2. **Client registration with a redirect URI outside the allowlist** (e.g. `https://evil.example/cb`, or `https://claude.ai.evil.example/api/mcp/auth_callback`) is rejected with `invalid_redirect_uri`. Task 8.
3. **A hostile zip upload** (`../` entries, absolute paths, symlinks, more than 200,000 entries, or more than 8 GB uncompressed) is refused, and nothing is written outside its upload directory. Task 10.
4. **`/callback` with an unknown, expired or already-used `state`** returns 404 and stores no tokens. Task 5.
5. **An upload link that was already used, has expired, or is used without a passkey sign-in or owner cookie** is refused, and no file is stored. Task 10.

---

### Task 1: One import dispatcher for CLI and gateway

**Files:**
- Create: `src/import.ts`
- Modify: `src/cli.ts:18-54` (call it)
- Test: `tests/import.test.ts`

**Interfaces:**
- Produces: `type ImportKind = 'pdf' | 'ehi' | 'apple' | 'ccda'`; `detectKind(path: string): ImportKind` (throws `GaError` for `.zip`, as today); `importAny(client: MedplumClient, cfg: GaConfig, path: string, opts?: { tz?: string; name?: string }): Promise<unknown>`, which runs `importEhi`, `importAppleHealth` or `importPath` (it refuses `pdf` with the existing "PDFs are extracted by your agent" message).

- [ ] **Step 1:** Write the failing tests. Build temp folders the way the existing EHI and Apple tests do.
  - `detectKind` returns `'pdf'` for `x.PDF` and `.png`.
  - It returns `'ehi'` for an EHI-shaped folder and `'apple'` for an Apple-shaped folder.
  - It returns `'ccda'` for a folder of XML files.
  - It throws `/unzip export.zip first/` for `a.zip`.
- [ ] **Step 2:** `npx vitest run tests/import.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `src/import.ts` by moving the branch logic out of `src/cli.ts`, with the `--tz` validation kept in the CLI. `cli.ts` then calls `importAny`.
- [ ] **Step 4:** `npm test` and `npm run typecheck` → all pass.
- [ ] **Step 5:** Commit `refactor: one import dispatcher for CLI and gateway`.

### Task 2: Tools built once; chat instructions from the skill

**Files:**
- Create: `src/instructions.ts`
- Modify: `src/mcp.ts:122-230`
- Test: `tests/instructions.test.ts`, `tests/integration/mcp.test.ts` (must still pass)

**Interfaces:**
- Produces:
  - `type ToolDeps = { client: MedplumClient; cfg: GaConfig; patientId: string; remote?: { publicUrl: string; clientName: string; log: (tool: string) => Promise<void> } }`.
  - `buildMcpServer(deps: ToolDeps): McpServer` registers the existing five tools, then calls `registerShareTools`, `registerHospitalTools`, `registerImportTools` and `registerAppTools` (Tasks 4, 6, 10, 11) only when `deps.remote` is set. Until a task lands, its register function is absent; each task adds its own call.
  - `runMcp(cfg)` keeps its signature: `buildMcpServer({ client, cfg, patientId })` plus the stdio transport.
  - `chatInstructions(): string`.
  - Tool helpers moved from `mcp.ts` and exported: `text(v)` and `fail(e)`.
- Annotations: `readOnlyHint: true` on `fhir_search`, `fhir_read`, `vaccine_gaps` and `cardiovascular_risk_10yr`; `destructiveHint: true` on `ga_import`.
- Remote output cap: when `deps.remote` is set, any tool's text result over 150,000 characters is cut there and ends with `[truncated: narrow the search, e.g. _count, _elements or a date range]`. claude.ai's limit is about that size.
- Remote logging: when `deps.remote` is set, every tool handler calls `deps.remote.log(<tool name>)` first. Wrap `server.registerTool` once in `buildMcpServer`; don't edit each handler.

- [ ] **Step 1:** Write the failing tests in `tests/instructions.test.ts`. `chatInstructions()` must satisfy all of these:
  - It contains `Cite every value` and `cardiovascular_risk_10yr`.
  - It contains the stale-source rule naming the tools from Task 6 (`hospital_status`, `hospital_connect`, `hospital_sync`) instead of `ga connect` and `ga sync`.
  - It contains the PDF extraction rules from `.claude/skills/ga-import/extract.md`, rewritten to call `upload_link` first and then `ga_import` with `fileId`.
  - It doesn't contain `ga share`, `/ga-import` or `AGENTS.md`.
  - It is under 20,000 characters.
- [ ] **Step 2:** `npx vitest run tests/instructions.test.ts` → FAIL.
- [ ] **Step 3:** Implement `chatInstructions()` the way `instructions()` in `src/share/ask.ts` transforms `SKILL.md` line by line:
  - Steps 0–9: step 0's CLI fixes become the tool names above.
  - Then `extract.md` with `sourceFile` replaced by "the `fileId` from `upload_link`".
  - Then one line: "Creating a share or enabling hospital record types returns a preview: show it to the user and call again with its `confirm` code only after the user says yes."
- [ ] **Step 4:** Add a test that a remote `fhir_search` returning 200,000 characters comes back cut at 150,000 characters with the marker, using a fake client. Implement `buildMcpServer` (remote servers pass `instructions: chatInstructions()`; stdio keeps today's text). Run `npm test` and `npm run test:int -- tests/integration/mcp.test.ts` → pass.
- [ ] **Step 5:** Commit `refactor: build MCP tools once; chat instructions generated from the /ga skill`.

### Task 3: Confirmation in one place

**Files:**
- Create: `src/confirm.ts`
- Test: `tests/confirm.test.ts`

**Interfaces:**
- Produces:
  - `preview<T>(kind: 'share' | 'enable', payload: T, now?: Date): { confirm: string; expiresAt: string }` gives a 6-character base32 code that lasts 15 minutes. It lives in memory.
  - `takeConfirmed<T>(kind, code: string, now?: Date): T`, single use. It throws `GaError('confirmation code unknown or expired; ask for a new preview')`.
  - Spec: this is where options B and A plug in later. Mode C is the only mode now, so the code goes back to the agent inside the preview.

- [ ] **Step 1:** Write the failing tests:
  - A round trip returns the payload.
  - A second take throws.
  - A take with the wrong `kind` throws.
  - A take after 15 minutes (pass `now`) throws.
  - 1,000 previews give 1,000 distinct codes.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `randomBytes` and a `Map`, deleting entries on take and pruning on each `preview`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: two-step confirmation store`.

### Task 4: Share tools

**Files:**
- Create: `src/tools/shares.ts`
- Modify: `src/mcp.ts` (call `registerShareTools`)
- Test: `tests/tools-shares.test.ts`

**Interfaces:**
- Consumes: `preview`, `takeConfirmed` (Task 3); `createShare`, `listShares`, `revokeShare`, `parseSince` (`src/share/store.ts`); `readLog` (`src/share/audit.ts`); `scopeWords` (`src/share/page.ts`); `renderQr` (`src/share/page.ts`), for a QR code returned as an image content block.
- Produces: `registerShareTools(server: McpServer, deps: ToolDeps, dir = shareDir())`, which registers:
  - `share_create {audience: 'doctor'|'family', label, scope?: string[] | 'all', since?, until?, expires?, questionsPerDay?, confirm?}`.
    - Without `confirm`, it returns the preview: audience, label, `scopeWords`, since/until, the expiry (the doctor default is 7 days) and `confirm`.
    - With `confirm`, it creates the share with `baseUrl = deps.remote.publicUrl` and returns the link `${publicUrl}/s/${token}` and a QR code.
    - The arguments in the confirming call must equal the previewed ones. Otherwise it throws "arguments changed since the preview".
    - `destructiveHint`.
  - `share_list`: id, label, audience, scope words, expires, status, last access, access count. `readOnlyHint`.
  - `share_log {id?}`: `readOnlyHint`.
  - `share_revoke {id}`: `destructiveHint`.

- [ ] **Step 1:** Write the failing tests, using an in-memory `McpServer` with `InMemoryTransport` from the SDK, a temp share dir and a fake `client.searchResources` that returns no AuditEvents:
  - A preview creates no file.
  - Confirming with matching arguments creates exactly one share whose `baseUrl` is `publicUrl`.
  - Confirming with a changed `label` is refused.
  - Reusing a code is refused.
  - `share_revoke` makes `share_list` show `revoked`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: share tools for chat (two-step create, list, log, revoke)`.

### Task 5: Hospital login in two halves (start, finish) through files

**Files:**
- Modify: `src/smart/auth.ts:74-150`, `src/smart/cli.ts` (connect branch)
- Test: `tests/smart-auth.test.ts` (extend; it uses `tests/smart/mock-server.ts`)

**Interfaces:**
- Produces:
  - `startLogin(dir: string, fhirBase: string, clientId: string, redirectUri: string, name?: string): Promise<{ url: string; state: string }>` writes `pending/<sha256(state)>.json`. The file holds `{ verifier, state, fhirBase, clientId, redirectUri, name, expires }` and is written with `saveSecret`-style encryption at mode 0600.
  - `finishLogin(dir: string, search: string, now?: Date): Promise<SourceRec>` reads and deletes the pending file for the search's `state`, rejects one that has expired, exchanges the code, then saves the tokens and source as `connect` does today. It throws `GaError('unknown_state')` when no pending file exists.
  - `waitForLogin(dir: string, state: string, timeoutMs = 600_000): Promise<SourceRec>` polls `results/<sha256(state)>.json`, which the gateway writes (Task 6).
  - `connect(...)` keeps today's localhost path through `listen()` unchanged.
  - With an `https:` redirect, `connect` instead calls `startLogin`, opens the URL and calls `waitForLogin`. The gateway must be running, so the error names `docker compose up -d ga-gateway`.

- [ ] **Step 1:** Write the failing tests against the mock server:
  - `startLogin` then `finishLogin(?code=..&state=..)` returns the source and stores tokens.
  - A second `finishLogin` with the same state throws `unknown_state`.
  - A forged state throws `unknown_state`.
  - A `finishLogin` 11 minutes later throws, and no tokens file exists after it.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement, sharing the exchange code with `connect`. **Step 4:** Run `npm test` → PASS; `npm run test:int -- tests/integration/smart-cli.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat: hospital login split into start/finish via pending files`.

### Task 6: Hospital tools

**Files:**
- Create: `src/smart/actions.ts`, `src/tools/hospitals.ts`
- Modify: `src/smart/cli.ts` (enable and disconnect call the actions), `src/mcp.ts`
- Test: `tests/tools-hospitals.test.ts`

**Interfaces:**
- Consumes: `startLogin` and `finishLogin` (Task 5); `syncSource`, `syncAll`, `readStatus` and `writeEndpoint` (`src/smart/sync.ts`); `preview` and `takeConfirmed` (Task 3).
- Produces:
  - In `src/smart/actions.ts`:
    - `enableTypes(dir, sourceKey: string, types: string[] | 'all'): SourceRec` (validation moved from the CLI).
    - `disconnectSource(client, dir, sourceKey, patientId): Promise<void>`.
    - `completeLogin(client, dir, patientId, search): Promise<SyncResult>`: `finishLogin`, then a dry-run `syncSource`, then the result written to `results/<sha256(state)>.json`. The gateway's `/callback` calls it.
  - `registerHospitalTools(server, deps, dir = smartDir())` registers:
    - `hospital_connect {fhirBase, name?}`: uses `readApp(dir).clientId` and `redirectUri`, and requires an https redirect (otherwise it tells the user to run `ga connect` on the GA host). Returns the login link, telling the agent to give it to the user and then call `hospital_status`.
    - `hospital_status`: `readStatus` rows plus a `pendingLogins` list (state hash, fhirBase, `finished` / `waiting` / `failed: <error>`, and the dry-run `fetched` counts per type once finished). `readOnlyHint`.
    - `hospital_enable {source, types, confirm?}`: preview = `fetched` counts for those types from the latest dry run; confirm = `enableTypes` plus a real `syncSource`. `destructiveHint`.
    - `hospital_sync {source?}`: `syncAll` or a single `syncSource`.
    - `hospital_disconnect {source}`: `destructiveHint`.

- [ ] **Step 1:** Write the failing tests, with fakes for sync and status functions injected through a small `deps` parameter on `registerHospitalTools`:
  - `hospital_connect` refuses when `app.json` has no https `redirectUri`.
  - It returns a URL when one is set.
  - `hospital_enable` without `confirm` doesn't change `sources.json`.
  - With a valid `confirm` it sets `enabledTypes`.
  - Unknown types are refused with the known list.
  - `hospital_status` shows a finished pending login's `fetched` counts.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; the CLI `sync --enable` and `disconnect` call the shared actions. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: hospital tools for chat (connect, status, enable, sync, disconnect)`.

### Task 7: Passkeys and the owner cookie

**Files:**
- Create: `src/gateway/passkey.ts`, `src/gateway/store.ts` (`gatewayDir()` = `.ga/gateway`, JSON helpers reusing `writeAtomic`)
- Modify: `src/cli.ts` (add `ga passkey link`), `package.json` (`@simplewebauthn/server` 14.0.3)
- Test: `tests/passkey.test.ts`

**Interfaces:**
- Produces:
  - `enrollLink(dir, publicUrl, now?): string`: `${publicUrl}/enroll/<token>`. A 24-hour, single-use token, stored hashed.
  - `takeEnrollToken(dir, token, now?): boolean`.
  - `registrationOptions(dir, publicUrl)` and `verifyRegistration(dir, publicUrl, response, expectedChallenge)`: store `{ id, publicKey, counter, transports }` in `passkeys.json`.
  - `authenticationOptions(dir, publicUrl)` and `verifyAuthentication(dir, publicUrl, response, expectedChallenge): boolean`.
  - `ownerCookie(dir, now?): string` and `isOwner(dir, cookieHeader: string | undefined, now?): boolean`. The cookie is `ga_owner`, HMAC-SHA256 over its expiry with a key in `.ga/gateway/cookie.key`; `HttpOnly; Secure; SameSite=Lax; Path=/`, 12 hours.
  - The relying party ID is `new URL(publicUrl).hostname`, the origin `publicUrl`.
- `ga passkey link` prints the enrollment link (needs `GA_PUBLIC_URL`).
- Browser side, built in Task 9's pages: `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` and `credential.toJSON()`, with no browser library.

- [ ] **Step 1:** Write the failing tests:
  - An enrollment token works once.
  - It fails after 24 hours.
  - `isOwner` is true for a fresh cookie, and false for a tampered one, one that has expired, or a missing one.
  - `verifyAuthentication` is false when `passkeys.json` is empty. Real WebAuthn verification is covered by the library and isn't re-tested.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: passkey owner login and enrollment link`.

### Task 8: OAuth server

**Files:**
- Create: `src/gateway/oauth.ts`, `src/gateway/adapter.ts`, `config/chat-apps.json`
- Modify: `package.json` (`oidc-provider` 9.13.0)
- Test: `tests/oauth.test.ts`

**Interfaces:**
- Produces:
  - `allowedRedirect(uri: string): boolean` matches `config/chat-apps.json`: `{ "apps": [{ "name": "claude.ai", "redirects": ["https://claude.ai/api/mcp/auth_callback", ...] }, ...] }`.
    - Patterns may end in `*`, which matches any rest of the path on the same origin.
    - Loopback entries are `http://localhost:*` and `http://127.0.0.1:*`, with any port and path.
    - The list contains exactly the spec's table.
  - `appName(redirectUri): string` is shown on the consent page and in the remote log.
  - `createProvider(opts: { publicUrl: string; dir: string; now?: () => number }): Provider`:
    - `issuer = publicUrl`.
    - `features.registration: { enabled: true }`, with an `extraClientMetadata` or registration policy that rejects any `redirect_uris` entry failing `allowedRedirect` (`invalid_redirect_uri`) and forces `token_endpoint_auth_method: 'none'`.
    - `pkce.required` always (S256).
    - `features.resourceIndicators`: `defaultResource` → `${publicUrl}/mcp`, `useGrantedResource` → true, `getResourceServerInfo` → `{ scope: 'ga', audience: '${publicUrl}/mcp', accessTokenTTL: 3600, accessTokenFormat: 'opaque' }` only for that resource, `InvalidTarget` otherwise.
    - `scopes: ['ga', 'offline_access']`.
    - `ttl.RefreshToken`: 90 days idle (`ttl.RefreshToken` returns 90 days; rotation resets it).
    - `rotateRefreshToken(ctx)`: `false` when the client's redirect is a Google pattern (Gemini), otherwise `true`.
    - `issueRefreshToken`: always for this client set.
    - `findAccount`: `{ accountId: 'owner', claims: () => ({ sub: 'owner' }) }`.
    - `interactions.url` → `/interaction/<uid>`.
    - `adapter`: the file adapter.
    - `cookies.keys` and `jwks`: generated on first start into `.ga/gateway/cookie.key` and `.ga/gateway/jwks.json` (mode 0600; `jose` is already a dependency) and reused afterwards, so restarts don't sign everyone out.
  - `FileAdapter` (oidc-provider's adapter interface: `upsert`, `find`, `findByUserCode`, `findByUid`, `consume`, `destroy`, `revokeByGrantId`) stores JSON under `.ga/gateway/oidc/<Model>/<sha256(id)>.json` with mode 0600, expiry honoured on `find`. A shortcut comment notes it's single-process.
  - `listClients(dir): { clientId, name, created }[]` and `disconnectClient(provider, dir, clientId)` (destroys the client and revokes its grants), for Task 11.

- [ ] **Step 1:** Write the failing tests, running the provider in-process on a random port with `http.createServer(provider.callback())`:
  - `allowedRedirect` accepts each spec entry, `http://localhost:53682/callback` and `https://chatgpt.com/connector/oauth/abc`.
  - It rejects `https://claude.ai.evil.example/api/mcp/auth_callback`, `https://evil.example/cb` and `http://claude.ai/api/mcp/auth_callback`.
  - POST `/reg` with `https://evil.example/cb` → 400 `invalid_redirect_uri`.
  - POST `/reg` with the claude.ai callback → 201 with no `client_secret`.
  - Metadata at `/.well-known/oauth-authorization-server` lists `S256` and `registration_endpoint`.
  - `rotateRefreshToken` is false for a client registered with `https://oauth-redirect.googleusercontent.com/r/x`.
  - The adapter: `find` after `upsert` round-trips; it returns undefined after expiry; `consume` sets `consumed`; `revokeByGrantId` removes every model with that `grantId`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: OAuth server for chat connectors (oidc-provider, allowlisted DCR)`.

### Task 9: Gateway server and compose

**Files:**
- Create: `src/gateway/server.ts`, `src/gateway/pages.ts`, `src/gateway/remote-log.ts`
- Modify: `src/share/server.ts` (export `shareHandler(deps)` alongside `createServer`, which keeps working), `src/share/cli.ts` (`ga share serve` stays and prints a deprecation note pointing at `ga gateway serve`), `src/cli.ts` (`ga gateway serve`), `compose.yaml` (rename the `ga-share` service to `ga-gateway`, keep port `127.0.0.1:8110:8110`, add `GA_PUBLIC_URL: ${GA_PUBLIC_URL:-}`, command `['node','src/cli.ts','gateway','serve']`)
- Test: `tests/gateway.test.ts`, `tests/integration/gateway.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6, 7 and 8; `shareHandler`.
- Produces: `createGateway(deps: { publicUrl; dir; tools: (remote: ToolDeps['remote']) => McpServer; share: ShareDeps; completeLogin: (search: string) => Promise<unknown>; verifyPasskey?: ... }): http.Server`, with routes:
  - `GET /.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`: `{ resource: '<publicUrl>/mcp', authorization_servers: ['<publicUrl>'], scopes_supported: ['ga'], bearer_methods_supported: ['header'] }`.
  - `POST|GET|DELETE /mcp`:
    - The bearer token is looked up with `provider.AccessToken.find(token)`. It must exist, be unexpired, have `aud` (or the resource) equal `<publicUrl>/mcp`, and its client must still exist.
    - Otherwise the reply is 401 with the header from Review Focus 1.
    - On success, a fresh `buildMcpServer` plus `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request (stateless). `remote.clientName = appName(client redirect)`, `remote.log = logRemote`.
  - `/interaction/:uid`: the login page (passkey sign-in, or "no passkey yet: run `ga passkey link`"), then the consent page ("<app name> wants to use your GA record", Allow / Deny). Finish with `provider.interactionFinished(...)`, granting scope `ga offline_access` for resource `<publicUrl>/mcp`. A valid owner cookie skips the passkey step but never the consent.
  - `/enroll/:token`: the passkey registration page.
  - `GET /callback`: `completeLogin(search)`. On `unknown_state` → 404 and the page "This login link is no longer valid"; on success → "GA received the authorization. You can close this window and return to your chat." Accepts `/callback/` too.
  - `/s/...`: `shareHandler`.
  - `/upload/...`: Task 10.
  - Everything else goes to `provider.callback()`.
  - Rate limits with `failLimiter` from `src/share/server.ts`: 20 failed passkey or bearer attempts per IP per 10 minutes → 429. A valid token is never limited.
- `logRemote(client, tool, clientName)` writes an `AuditEvent` tagged `urn:ga-server:remote|<clientName>`, with action `E`, the tool name in `entity.what.display` and the time. It follows `src/share/audit.ts`.
- `ga gateway serve`: needs `GA_PUBLIC_URL`; without it, it serves only the share pages and logs `remote access off: set GA_PUBLIC_URL`.

- [ ] **Step 1:** Write the failing unit tests in `tests/gateway.test.ts`, with the provider on a temp dir and a fake tools factory:
  - `/mcp` with no token, an expired one, one for a destroyed client, or one with `aud` `https://other/mcp` → 401 with the exact `WWW-Authenticate` header.
  - The resource metadata JSON is exact.
  - `/callback?state=nope` → 404.
  - `/s/<bad>` → 404 from the share handler.
  - An unknown path → the provider's 404.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement.
- [ ] **Step 4:** Write `tests/integration/gateway.test.ts`, the full flow against running Medplum with a throwaway patient:
  - Register with `http://localhost:9/cb` and run authorize with PKCE (`openid-client`, already a dependency).
  - Pass the interaction by injecting `verifyPasskey: async () => true` and posting consent.
  - Exchange the code and call `tools/list` and `fhir_search` through the SDK's `StreamableHTTPClientTransport` with the bearer.
  - Refresh once.
  - Disconnect the client → the next call is 401.
  - One remote AuditEvent exists per tool call.

  Run `npm run test:int -- tests/integration/gateway.test.ts` → PASS.
- [ ] **Step 5:** Run `docker compose up -d ga-gateway`, then `curl -s localhost:8110/.well-known/oauth-protected-resource/mcp` → the metadata JSON, and an existing share link still opens.
- [ ] **Step 6:** Commit `feat: ga-gateway serves MCP over HTTP, owner login, callback and share pages`.

### Task 10: Uploads and import tools

**Files:**
- Create: `src/gateway/uploads.ts`, `src/tools/imports.ts`
- Modify: `src/gateway/server.ts` (`/upload/:token` GET page, POST body), `src/mcp.ts` (`ga_import` accepts `fileId` when remote), `package.json` (`yauzl` 3.4.0)
- Test: `tests/uploads.test.ts`, `tests/tools-imports.test.ts`

**Interfaces:**
- Produces:
  - `newUpload(dir, now?): { token: string; url: string; expiresAt: string }`: single use, 15 minutes.
  - `acceptUpload(dir, token, fileName: string, body: Readable, now?): Promise<{ fileId: string }>`: streams to `uploads/<fileId>/<safeName(fileName)>` with a 2 GB cap (`413` above it). Consumes the token first.
  - `uploadPath(dir, fileId): string`, which throws for an unknown id.
  - `unzipSafe(zip: string, into: string, limits = { entries: 200_000, bytes: 8 * 1024 ** 3 }): Promise<string>`: `yauzl`; rejects absolute paths, `..` segments, symlinks (external attributes) and over-limit archives; returns the extracted root (the single top folder if there is one).
  - `uploads/` older than 24 hours are deleted when the gateway starts and each hour.
  - `registerImportTools(server, deps, dir)` registers:
    - `upload_link {purpose?: string}`: returns the URL with instructions.
    - `import_file {fileId, tz?}`: background job; PDF/image → error "read it in the chat and call ga_import with this fileId"; zip → `unzipSafe` then `importAny`; folder kinds per `detectKind`. Returns `{ jobId }`. `destructiveHint`.
    - `import_status {jobId?}`: running / done (with the import report) / failed (message). `readOnlyHint`. Jobs live in memory and are lost on restart.
    - Remote `ga_import` gains `fileId` (a remote call without `fileId` is refused with "call upload_link first"). It resolves `uploadPath` and passes it as today's `sourceFile`, so "imported once" and provenance work unchanged.
    - ChatGPT: `ga_import` and `import_file` also accept `file: {download_url, file_name}` declared in `_meta["openai/fileParams"]`. GA fetches `download_url` only when it's https and its host matches the `fileHosts` list in `config/chat-apps.json` (start with the host seen in testing, **[check]**), with the same 2 GB cap, into a new upload.
- Upload page: GET shows a file picker. If `isOwner(cookie)` is false it first runs passkey sign-in and sets the cookie. POST streams the file. CSP as in the share pages, plus one inline script with a nonce.

- [ ] **Step 1:** Make four tiny synthetic fixture zips under `tests/fixtures/zips/` with a one-off `python3 -c` using `zipfile` (no PHI): `ok.zip` (one top folder, two small files), `traversal.zip` (an entry `../evil.txt`), `absolute.zip` (an entry `/abs.txt`), `symlink.zip` (an entry whose external attributes mark a symlink, `0o120777 << 16`). Commit them with the tests. Then write the failing tests in `tests/uploads.test.ts`; the entry and byte limits are tested by passing small `limits` to `unzipSafe`. The cases:
  - A token works once.
  - It's refused after 15 minutes.
  - A stored file lands under `uploads/<fileId>/`.
  - `unzipSafe` rejects `../evil.txt`, `/abs.txt`, a symlink entry, and an archive declaring more than the entry or byte limit; nothing is written outside `into`.
  - A normal zip with one top folder returns that folder.
- [ ] **Step 2:** Write the failing tests in `tests/tools-imports.test.ts`:
  - Remote `ga_import` without `fileId` is refused.
  - With `fileId` it calls `importExtracted` with `uploadPath`.
  - `import_file` on a zipped C-CDA fixture folder returns a `jobId`, and `import_status` reaches `done`, with `importAny` faked.
  - A `download_url` on a host not in `fileHosts` is refused without a fetch.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS. Then upload a synthetic PDF through the running gateway with curl (cookie from a test passkey is not possible, so use the integration test's injected `verifyPasskey`).
- [ ] **Step 6:** Commit `feat: upload links and import tools for chat`.

### Task 11: Connected apps

**Files:**
- Create: `src/tools/apps.ts`
- Modify: `src/mcp.ts`, `src/cli.ts` (`ga apps`, `ga apps disconnect <clientId>`)
- Test: `tests/tools-apps.test.ts`

**Interfaces:**
- Consumes: `listClients` and `disconnectClient` (Task 8).
- Produces: `registerAppTools(server, deps)` registers:
  - `connected_apps`: name, clientId, connected date and last use (from the remote AuditEvents). `readOnlyHint`.
  - `disconnect_app {clientId}`: `destructiveHint`. Disconnecting the app making the call is allowed and says so.

- [ ] **Step 1:** Write failing tests: list shows two registered clients by app name; after disconnect, one remains and the removed client's refresh token no longer refreshes (in-process provider from Task 8 tests).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: list and disconnect connected chat apps`.

### Task 12: Nightly backups

**Files:**
- Create: `scripts/backup.sh`
- Modify: `compose.yaml` (new `ga-backup` service: `postgres:16`, `restart: unless-stopped`, mounts `ga-binary` read-only, `./.ga` read-only and `${GA_BACKUP_DIR:-./backups}` at `/backups`; runs the script in a loop once every 24 hours, and once at start), `.gitignore` (`backups/`)

**Interfaces:**
- `scripts/backup.sh`:
  - Writes `/backups/<YYYY-MM-DD_HHMM>/{ga-postgres.dump, ga-binary.tgz, dot-ga.tgz}` with `pg_dump -h postgres -U medplum -Fc medplum`, and `PGPASSWORD` taken from the same env compose gives Medplum.
  - Uses `umask 077`.
  - Keeps the 7 newest directories and deletes older ones.
  - Exits non-zero on any failure without deleting older backups.

- [ ] **Step 1:** Run `docker compose up -d ga-backup && sleep 60 && ls -la backups/*/`. Expected: one dated directory with three non-empty files, modes `-rw-------`.
- [ ] **Step 2:** Restore check, as done for `docs/operations.md`:
  - Restore the dump into a throwaway `postgres:16` container.
  - `select count(*) from "Observation"` equals the live count.
  - Drop the container.
- [ ] **Step 3:** Create 8 fake dated dirs and run the script once with `RUN_ONCE=1`. Expected: 7 remain.
- [ ] **Step 4:** Commit `feat: nightly backups (database, stored files, .ga), keep 7`.

### Task 13: Docs

**Files:**
- Create: `docs/chat-apps.md`
- Modify:
  - `README.md` (one Quick start line: "Use GA from claude.ai, ChatGPT, Gemini or Grok: see docs/chat-apps.md", plus the mermaid diagram gets `chat apps → ga-gateway`);
  - `docs/operations.md` (what's public, backups, `GA_PUBLIC_URL`, restart, keeping the host awake);
  - `docs/sharing.md` (`ga-gateway` replaces `ga-share`; shares from chat);
  - `docs/hospital-portals.md` (connect from chat);
  - `AGENTS.md` (remote tools, `fileId`, two-step confirm);
  - `SECURITY.md` (the public surface);
  - `TERMS.md` and `docs/epic-setup.md` (records reach the chat apps the owner connects).

- `docs/chat-apps.md`:
  - The one-time setup:
    - `GA_PUBLIC_URL` in `.env`;
    - `docker compose up -d`;
    - the Funnel commands the user runs, with `/callback` now going to 8110: `tailscale funnel --bg 8110` and `tailscale funnel --set-path /callback off` if it was set before;
    - `ga passkey link`, opened on the phone.
  - Then a short per-app section for claude.ai, ChatGPT, Gemini, Grok, Grok Bot and Claude Code (`claude mcp add --transport http ga https://<host>/mcp`), each with its plan limits from the spec and "verified" or "not yet verified".
- [ ] **Step 1:** Write the docs. **Step 2:** Check every command against the code (`grep` for each CLI verb and env var). **Step 3:** Commit `docs: GA from chat apps`.

### Task 14: Acceptance

These are manual steps with the user. Record results in `docs/chat-apps.md` ("verified on <date>"), with no PHI.

- [ ] **Step 1:** The user sets `GA_PUBLIC_URL`, runs the Funnel commands and enrolls a passkey.
- [ ] **Step 2:** On a device other than the GA host: `claude mcp add --transport http ga https://<host>/mcp`, then log in with the passkey and approve. Run spec success steps 1–5:
  - Ask the statin question.
  - Connect a hospital: production Epic, or skip with a note while the second hospital is still undistributed.
  - Check `hospital_status` and run `hospital_sync`.
  - Import a synthetic lab PDF via `upload_link` and a small Apple Health export zip.
  - `share_create` (preview, then confirm), `share_list`, `share_log`, `share_revoke`.
- [ ] **Step 3:** Grok on its free plan: add a custom connector and repeat steps 1, 3 and 5. If the free plan can't add one, repeat with claude.ai on a personal free account (spec fallback).
- [ ] **Step 4:** Try ChatGPT, Gemini and Grok Bot, and record the result for each. A redirect URI rejected at registration means an entry for `config/chat-apps.json`.
- [ ] **Step 5:** Commit `docs: chat app acceptance results`.
