# GA Milestone 6: GA in Any Chat, No Terminal — Design

Builds on milestones 1–4 (`2026-11-05-ga-server-design.md`, `2026-11-05-smart-sync-design.md`, `2026-11-06-sharing-design.md`), all shipped. Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

This replaces milestone 6 in the milestone‑1 design ("bundled single image"). The user judged one bundled image too prescriptive: it would limit where GA can be deployed. **[user]** Messaging (milestone 5) is folded into a later "proactive GA" milestone.

## Intent

The ultimate goal is that a non-technical person clicks a button and starts using GA, from chatgpt.com or claude.ai, because most people don't have Claude Code. **[user]**

Picture GA as an agent: an always-on health agent that has all of the user's data and collects it from multiple sources. **[user]** Everything happens in chat. That means less interface for users to learn and less for us to build. **[user]**

Today GA works only from Claude Code (or another local MCP client) on the machine that runs it, and hospital connections, shares and sync need Terminal. This milestone makes GA usable from the chat apps people already have, from any device, with nothing done in Terminal after setup.

**Where it runs [user]:** now, on one of the user's devices in their Tailscale network. Later, any cloud service. This milestone builds what both need; one-click cloud deploy is the next milestone.

**Success test [user]:**
- Must pass with **Claude Code connected over the network** (remote URL plus login, not stdio) and with **Grok (grok.com)** on a free account. The test runs from a device other than the GA host.
- If Grok's free plan turns out unable to add a custom connector, the second must-pass app becomes claude.ai on a personal free account (one custom connector allowed). **[call]**
- Tried best effort on claude.ai, ChatGPT, the Gemini app and Grok Bot, as their plans allow. The user has free accounts on all of them; their Claude account is Enterprise, where only an organization Owner can add a custom connector.

In chat, with Terminal closed, the user can:
1. Ask "Is starting Atorvastatin 40 mg the right decision?" and get the same grounded answer as `/ga` gives in Claude Code.
2. Connect a hospital portal, review the record counts and turn sync on.
3. Check sync status and sync now.
4. Import a lab PDF, with the original kept, and an Apple Health export.
5. Create a share, list shares, read a share's access log and revoke it.

## Scope

**In:**
- A remote MCP endpoint over HTTPS (Streamable HTTP), reachable through the existing Tailscale Funnel.
- An owner login (OAuth 2.1) that chat apps use to connect, with passkey sign-in.
- Chat tools for everything that is CLI-only today: hospital connect, sync, shares, file and export imports.
- An upload link for files the chat app can't hand to GA.
- Running unattended: restart after reboot, scheduled backups, configuration from the environment.

**Non-goals (this milestone):**
- One-click cloud deploy and per-host deploy templates (next milestone).
- GA reaching out on its own: new-result alerts, broken-connection alerts (later milestone; ideally the messages arrive in the chat) **[user]**.
- A GA web app or dashboard. **[user: all in chat]** The only pages are the login page, the upload page and the existing share pages.
- An iPhone, iPad or Mac app. The design must not block one (see "Shared base for Apple apps").
- More than one owner, and family logins.
- Medplum's built-in MCP server: it exposes raw FHIR, not GA's tools, dedup and scope checks.

## Anti-goals

- **Only the owner gets in.** Every remote tool call needs a valid owner login. No URL, header or token pasted in chat grants access by itself.
- **The FHIR server stays private.** Medplum's API and its admin app stay on localhost, as in milestones 1–4. Only GA's own public service is exposed. This narrows milestone 4's anti-goal: GA's MCP tools are now reachable from the internet, but only behind the owner login.
- **No new write path skips dedup or provenance.** Remote imports go through the same engine as the CLI. Every LLM-extracted record still links to its stored original file.
- **Nothing that sends records out happens without a confirmation step in chat.** That covers creating a share and enabling a hospital's record types: a preview first, then a second call (see "Chat tools" for the accepted limit).
- **No silent remote access.** Every remote tool call is logged locally (tool, client app, time; never arguments or results). The owner can list connected chat apps and disconnect any of them.
- **No homegrown security.** Login, tokens and passkeys use widely used libraries. GA writes glue.
- **No PHI in the repo, logs or test fixtures.** Unchanged.

## How it fits together

```
chat app (claude.ai, ChatGPT, Gemini, Grok, Grok Bot, Claude Code)
    │ HTTPS
Tailscale Funnel ──► ga-gateway (one public service, one port)
                       ├─ /mcp            MCP tools (bearer token required)
                       ├─ OAuth server    login (passkey), client registration, tokens
                       ├─ /upload/<token> one-time upload page
                       ├─ /callback       hospital (SMART) login return
                       └─ /s/...          share pages (today's ga-share)
                             │ GA's own Medplum credentials
                       Medplum (localhost only), ga-sync
```

- **One public service, one port. [call]** A new `ga-gateway` compose service serves everything public. Today's share server becomes part of it, so the Funnel needs one route (`/` → the gateway) instead of today's two. Keeping `ga-share` separate behind path routes would also work, but OAuth discovery needs root-level `/.well-known/...` paths, so one service at the root is simpler.
- **The hospital login return address must not change.** Epic has `https://<funnel host>/callback` registered for the production app; re-registering takes Epic hours to days. The gateway serves `/callback`.
- **Claude Code over stdio keeps working unchanged.** The remote tools are a superset of the stdio ones. File-path imports stay stdio-only.
- **The gateway never forwards the chat app's token to Medplum.** It calls Medplum with GA's existing client credentials, as the CLI does.

## Owner login

- **Authorization server: `oidc-provider` (panva) [call].** It's widely used and certified, and supports what the chat apps need:
  - authorization code with PKCE S256;
  - Dynamic Client Registration (all five apps support it; Gemini requires it);
  - resource indicators, so tokens name GA's `/mcp` as their audience;
  - refresh tokens;
  - issuer identification in the authorization response (`iss`), so ChatGPT can use its fixed callback.
  - **[check]** each of these in the pinned version, including how `iss` is enabled.
- **Not Medplum as the login server. [call]** It was researched and rejected:
  - Its login page and full API would have to be public.
  - Its registration endpoint only matches preconfigured clients.
  - It ignores `resource`, so tokens can't name GA.
  - It returns `invalid_request` where Claude requires `invalid_grant`, which breaks reconnects.
- **Passkey sign-in via `@simplewebauthn/server` [call].** Face ID or Touch ID, with no password to forget. Passkeys sync across Apple devices through iCloud Keychain.
  - **First passkey:** setup prints a one-time enrollment link (the CLI, once). A lost passkey gets a new link the same way.
  - A passkey is bound to the public hostname. Moving GA to a new hostname means enrolling again; document it.
- **Client registration allowlist [call].** Registration is open, as DCR requires, but a client's redirect URIs must match a known chat app. Unknown redirect URIs are rejected. A registered client still can't do anything until the owner signs in with a passkey and approves it on a consent screen naming the app. Known redirect URIs:

  | App | Redirect URI |
  |---|---|
  | claude.ai | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` |
  | ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect`, `https://chatgpt.com/connector/oauth/*` |
  | Gemini app | `https://oauth-redirect.googleusercontent.com/r/*` (and the `-sandbox`/`-test` hosts) |
  | Grok | `https://grok.com/connectors-oauth-exchange-code/`, `https://grok.com/connectors/oauth/callback` (with or without trailing slash) |
  | Grok Bot | `https://cursor.com/agents/mcp/oauth/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` |
  | Claude Code | `http://localhost:*/...`, `http://127.0.0.1:*/...` |

  These come from vendor docs and forum reports, and they change. **[check]** each during acceptance testing. Keep the list in one config file, extendable without a code change.
- **Refresh tokens.** Rotate them, as the MCP spec recommends for clients without a secret, except for clients whose redirect is Gemini's: Gemini breaks on rotation, so keep the same token and extend its expiry. **[call]**
- **Lifetimes [call]:** access token 1 hour, refresh token 90 days of inactivity. The owner can disconnect any client.
- **Token check on `/mcp`:**
  - validate the token in process (the same process as the OAuth server), including that its audience is GA's `/mcp`;
  - answer 401 with `WWW-Authenticate: Bearer resource_metadata=...`;
  - serve RFC 9728 protected-resource metadata. The `resource` value must exactly equal the URL the user types (`https://<host>/mcp`). Claude reads only the first entry of `authorization_servers`.
- **Token store [call]:** persisted, so restarts don't log chat apps out. Builder's choice between a file adapter under `.ga/` and the existing Redis. It must survive the backup and restore in `docs/operations.md`.

## Chat tools

The MCP tool set, the same over remote and stdio unless noted. Tools that change something carry `destructiveHint`, read tools `readOnlyHint`, so apps that support it ask before running writes.

| Area | Tools (names are the builder's) | Notes |
|---|---|---|
| Read (existing) | `fhir_search`, `fhir_read`, `vaccine_gaps`, `cardiovascular_risk_10yr` | unchanged |
| Hospitals | connect, status, enable types, sync now, disconnect | see below |
| Shares | create, list, access log, revoke | create is two-step (below) |
| Import | upload link, import uploaded file, import extracted records (`ga_import`), import status | see below |
| Connected apps | list, disconnect | the owner's view of which chat apps have access |

**Two-step confirmation for actions that send records out. [user]** Creating a share and enabling a hospital's types first return a preview: for a share, the audience, scope, dates and expiry, as `/ga` step 10 shows today; for a hospital, the dry-run counts per type. A second call acts. The tool description tells the agent to show the preview and wait for the user's yes, and `destructiveHint` makes apps that support it show their own confirm dialog.
- **Known limit, accepted by the user:** the agent itself carries the yes. An agent misled by instructions hidden in a document could make the second call without the user. Mitigation: every share is in the share list and access log, and can be revoked at once.
- **Later, as configurable options [user]:** (B) the user types back a code shown in chat, or (A) a confirm link approved with the passkey. Keep the confirmation check in one place so either can be added without changing the tools.

**Hospital connect in chat.** The connect tool starts the SMART login and returns the MyChart login link. The user opens it and logs in. The always-on gateway receives `/callback` and finishes the token exchange and a dry run in the background. The status tool then shows the result and counts, and enabling goes through the two-step confirmation.
- This moves the https login return into the gateway: every SMART login with the https redirect goes through it, including CLI `ga connect`, which asks the gateway to start the login, prints the link and waits for the result (so the gateway must be running, as the rest of GA is). **[call]**
- Connecting with a `http://localhost:8765/callback` redirect (Epic's sandbox) stays CLI-only on the GA host, with today's temporary listener. Sandbox connect from chat is out of scope. **[call]**
- The production Epic registration uses the https callback already, so nothing changes at Epic.

**Imports.**
- **ChatGPT** can pass an attached file to a tool (`_meta["openai/fileParams"]`, delivered as a download URL). GA downloads and stores it. **[check]** whether this needs a paid plan.
- **Every other app** can't pass file bytes to a tool. The upload tool returns a one-time upload link (expires in 15 minutes, single use, size-capped). The user opens it, signs in with their passkey (skipped if already signed in on that browser), and picks the file; GA stores it and returns a file id. The passkey keeps the anti-goal: a leaked link alone can't add files. **[call]** A future app uploads with its OAuth token instead of the page.
- **PDF or photo:** the original is stored first, through ChatGPT's file param or the upload link. The agent reads the file in the chat, extracts by the existing rules, and calls `ga_import` with the records and the file id instead of a local path. "A file is imported once" and "every LLM-extracted record links to its original" keep working, keyed on the stored file's hash. **[call]** The user picks the file twice on claude.ai, Gemini and Grok: once in the chat and once on the upload page. Accepted for now.
  - **[check]** a one-pick alternative: GA returns the uploaded PDF's pages as images in a tool result, so the agent reads the stored original. Adopt it if the main apps accept image tool results of that size.
- **Exports** (Apple Health, Epic EHI, C-CDA) go through the upload link as a zip. GA unzips into a private temporary directory and runs the existing importer. Zip handling is untrusted input: no path traversal, a size cap and a file-count cap.
- **Long imports** run in the background. The tool returns at once, and the import status tool reports progress and the final report. Tool calls time out after about 4 minutes on claude.ai, and an Apple Health import takes longer.

**Answer quality in chat apps.** Chat apps have no `/ga` skill. GA's MCP server instructions carry the `/ga` answering rules (steps 0–9: portal status first, cite every value, GA's caveats, never compute risk or judge vaccines yourself) and the PDF extraction rules. They're generated from `.claude/skills/ga/SKILL.md` and `extract.md`, as the share question prompt already is, so the skill stays the single source. **[check]** which apps honour server instructions. Where an app doesn't, put the essentials into tool descriptions; `fhir_search` has the most room.

**Tool output size.** claude.ai allows about 150,000 characters per tool result. Keep results within that, with the same trimming the share question tools use.

## Running unattended

- **Restart:** `restart: unless-stopped` on every service, with Docker set to start at login or boot. Document keeping the host awake.
- **Configuration from the environment:**
  - the public URL (e.g. `GA_PUBLIC_URL=https://<host>`);
  - the OAuth signing keys and passkey data, generated on first start into `.ga/` (mode 0600);
  - no repo-relative paths that break when the container runs elsewhere.

  This is what the next milestone's cloud deploy builds on.
- **Scheduled backups [call]:** a nightly job writes the database dump, the stored files and `.ga/` (the same three as `docs/operations.md`) to a backup directory set by env (default `./backups`, gitignored, mode 0700), keeping the last 7. It's encrypted only if the disk is (FileVault); document it. Restore stays the documented manual procedure.
- **Container images [call]:** GA's services keep running the repo's code on the pinned Node image. Publishing GA's own images is the next milestone.

## Shared base for Apple apps

An iPhone, iPad or Mac app is a later milestone, but it reuses this milestone's pieces, so build them for that:
- **One public address and one login.** The app is another OAuth client: a native redirect URI, PKCE, passkey sign-in through iCloud Keychain.
- **One action surface: the MCP tools.** An app calls the same tools through the official MCP Swift SDK. Don't add a second REST API for the app.
- **One upload endpoint.** The upload link or file id flow is how a future app sends Apple Health data automatically: the iOS-app goal from milestone 1.

## Security notes

- **Public surface:** share pages (unchanged), `/mcp` (owner token required), OAuth and passkey pages, `/upload/<token>` (one-time token), and `/callback` (accepted only with a pending `state`).
- **Rate limits** on login, registration and upload. A valid owner token is never rate-limited on reads, but writes are bounded.
- **Remote access log:** each tool call is a local `AuditEvent` tagged as remote access (tool, client name, time; no arguments or results), separate from share logs. Builder's choice of tag system.
- **Errors** returned to chat apps never include record content beyond what the tool would return anyway.
- **Data flow:** the user's records reach whichever chat app they connect, as they reach Claude today through Claude Code. Document it in TERMS.md and the Epic Data Use Questionnaire answers.

## Docs

- README quick start gains "Use GA from claude.ai, ChatGPT, Gemini or Grok". Short: the Funnel command (run by the user, never by an agent), the connector URL `https://<host>/mcp`, and passkey setup. Per-app steps go in a new `docs/chat-apps.md`.
- Also update `docs/operations.md` (backups, restart, what's public), `docs/sharing.md` (shares from chat), `docs/hospital-portals.md` (connect from chat), `AGENTS.md`, `SECURITY.md` and TERMS.md.

## Left to the builder

- Tool names and exact argument shapes.
- The token store adapter and the remote access log's tag system.
- Gateway port and internal layout, as long as the Funnel needs one route and `/callback` keeps its path.
- How background jobs (hospital connect, imports) keep state across a restart. They may simply fail and be retried.
- Pinned versions of `oidc-provider`, `@simplewebauthn/server` and any zip library: widely used, exact versions at least 2 weeks old.
