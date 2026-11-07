# GA Reaches Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA messages its owner by iMessage about new abnormal results (as they arrive) and due items (at a chosen time), and answers the owner's texts with GA's own tools through any OpenAI-compatible AI provider.

**Architecture:** A channel-agnostic core in `src/notify/` runs inside `ga-gateway`: a one-minute tick picks what to send and queues it in an outbox; replies run an AI tool loop over the gateway's own remote MCP server (in memory), so confirm links work. A small host process (`ga notify bridge`, launchd) is the iMessage adapter: it exchanges incoming texts and queued messages with the gateway at `127.0.0.1:8110/notify/exchange` using a secret token, sends with `osascript`, reads `chat.db` with `node:sqlite`.

**Tech Stack:** Node 26 (strip-only TypeScript), vitest, Medplum client, `@modelcontextprotocol/sdk` (`InMemoryTransport`), `openai` (already a dependency), `node:sqlite`, macOS `osascript` and launchd.

**Spec:** `docs/superpowers/specs/2026-11-07-ga-reaches-out-design.md`

## Global Constraints

- No PHI in the repo, fixtures, logs or commits; tests use synthetic records. Logs never hold message content.
- Tests never write to the real patient and never touch the owner's real Messages (adapter tested against fakes).
- No new npm dependencies.
- Lock-screen first line is generic: `GA: 1 new result`, `GA: N new results`, `GA: N items for you`. No test names or values in it.
- Abnormal = the lab's own out-of-range flag (`whats_new` lab items). Every new one, even if chronically out of range. Only results arrived after notify setup and collected within the last 30 days.
- Defaults: digest `09:00`, sleep `22:00`–`07:00` (local time, `TZ`). Nothing sent during sleep; nothing sent on empty days.
- A sent due item is not sent again until `DAYS[importance]` (14 / 60 / 365) after it was sent, and never while `raiseNow` is false.
- Messages from any handle but the owner's are never answered; logged without content.
- Text tool allowlist: `health_summary`, `lab_results`, `current_medications`, `current_problems`, `allergies`, `vitals`, `notes_search`, `fhir_search`, `fhir_read`, `whats_new`, `health_maintenance`, `vaccine_gaps`, `cardiovascular_risk_10yr`, `postpone`, `record_followup`, and only with `GA_PUBLIC_URL`: `share_create`, `hospital_enable`. Nothing else.
- Part 1 messages are built from templates; no AI provider is called to send them.
- Every message ends with `Not medical advice.` and a reply hint.
- AuditEvent logs use `REMOTE_TAG` with client name `iMessage`.
- Extend existing tools before adding new ones (AGENTS.md).

## Review Focus

1. Sleep window crossing midnight (22:00–07:00) and a result arriving at 03:00: sent once at 07:00, not at 22:00 the day before or twice.
2. A failed send (bridge reports failure, or the bridge is down for hours) is retried and never duplicated; `ga notify status` shows the last error.
3. The bridge must not read GA's own sent messages back as owner replies (self-message mode: both directions are "from me").
4. The `/notify/exchange` route is reachable through Tailscale Funnel: without the exact token it returns 401 and does nothing.
5. AI provider down or no `GA_LLM_MODEL`: the owner gets a short plain reply, the gateway never crashes, part 1 keeps sending.

---

### Task 1: iMessage spike (controller with the user; no product code)

Run by the controller, not a subagent. Sends real messages only to the owner, with the owner watching.

- [ ] **Step 1:** Ask the user for the handle to test with. Run `osascript -e 'tell application "Messages" to send "GA test 1 (spike)" to participant "<handle>" of (1st account whose service type = iMessage)'`. Ask: did the iPhone show a notification? Did the Mac?
- [ ] **Step 2:** Ask the user to reply "pong" from the iPhone. With Full Disk Access granted to the terminal, run `sqlite3 ~/Library/Messages/chat.db "select m.ROWID, m.is_from_me, h.id, length(m.text), length(m.attributedBody), m.date from message m left join handle h on h.ROWID=m.handle_id order by m.ROWID desc limit 6"`. Record which rows are GA's send and which is the reply, and whether `text` is null (then `attributedBody` must be decoded).
- [ ] **Step 3:** Write the findings to the SDD ledger: notification yes/no, how the reply row differs from the sent row, text column. If no iPhone notification: stop and bring the user the separate-Apple-ID choice (spec, "iMessage facts"). Task 6's brief is adjusted to the result.

### Task 2: "I already did this" (`postpone` gets `done`)

**Files:**
- Modify: `src/tools/maintenance.ts` (postpone schema and handler)
- Modify: `src/maintenance.ts` (`REMINDER` comment, `healthMaintenance`, `combine`; export `DAYS`)
- Test: `tests/tools-maintenance.test.ts`, `tests/maintenance.test.ts`; integration in the existing maintenance integration test file

**Interfaces:**
- Produces: `postpone {topic, done: {date: 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD', method?: string, where?: string}, reason?}` writes `Basic` code `done` with extensions `urn:ga-server:ext:done-date` (valueString, as given), `urn:ga-server:ext:method`, `urn:ga-server:ext:where`. Export `DAYS: Record<Importance, number>` from `src/maintenance.ts`.

- [ ] **Step 1: Failing tests**
  - `postpone done on a screening needs a method from the rule`: topic `colorectal`, `done: {date: '2024'}` without method → error listing the topic's `doneBy` names; with `method: 'colonoscopy', date: '2024-05'` → `{topic, recorded: 'done', date: '2024-05'}`. `done` with `until` or `dismiss` → error. A date after today → error.
  - `combine: a done reminder counts as evidence`: given a `done` Basic for `colorectal` (`colonoscopy`, `2024-05`) and age 55, the colorectal item is `done`, `dueDate` `2034-05-01`, `evidence[0].by` `colonoscopy`, `evidence[0].source` `you told GA`. A partial date counts from its first day (`2024` → `2024-01-01`).
  - `combine: done on a follow-up` with a date on or after the plan's `asOf` → status `done`, `nextMention` `null`; an older done date changes nothing.
  - `done on a vaccine` → error `vaccines: import the vaccination record instead` (shortcut, see Step 3).
- [ ] **Step 2:** Run `npx vitest run tests/tools-maintenance.test.ts tests/maintenance.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `healthMaintenance`, turn each screening `done` Basic into a synthetic `Procedure` (`status: completed`, `code.text` = method, `performedDateTime` = date padded to the first day, `id` = the Basic's id, `meta.source` = `you told GA`) appended to the records `evaluateScreenings` reads, so the rule's own `text` match and interval apply. Follow-up `done` is handled in `combine` beside `not-now`. Vaccines refused with `// shortcut: vaccines need an Immunization record, add a typed completion when owners ask`. Provenance reason: `done "<topic>" <date>[ <method>][ at <where>]: <reason>`. Update the tool description: `done: the person says they already had it (date at least a year; method one of the screening's options)`.
- [ ] **Step 4:** Run the same tests plus `npx vitest run tests/integration` for the maintenance integration test (real Medplum, throwaway patient): a `done` write is accepted (`Basic.created` stays a date). Expected: PASS.
- [ ] **Step 5:** Update AGENTS.md "Health maintenance" (`postpone {topic, until?, dismiss?, done?, reason?}`). Commit `feat: postpone records "I already did this" (done) for screenings and follow-ups`.

### Task 3: What to send (pure core)

**Files:**
- Create: `src/notify/settings.ts`, `src/notify/select.ts`, `src/notify/compose.ts`
- Test: `tests/notify-select.test.ts`, `tests/notify-compose.test.ts`

**Interfaces:**
- Consumes: `ReviewItem` from `src/whats-new.ts`; `Item`, `raiseNow`, `DAYS` from `src/maintenance.ts`.
- Produces:
  - `type Settings = { to: string; digestAt: string; sleep: [string, string]; setupAt: string; off?: true }` and `type State = { sentResults: Record<string, string>; sentTopics: Record<string, string>; lastDigestDay?: string; lastSend?: string; lastError?: string; checkedAt?: string }` (ids/topics → ISO date sent), stored as `.ga/notify/settings.json` and `.ga/notify/state.json` via `writeJson`/`readJson`. `notifyDir(cfgPath?): string`, `readSettings(dir)`, `readState(dir)`, `writeState(dir, s)`.
  - `inSleep(now: Date, sleep: [string, string]): boolean` (local time; handles windows crossing midnight; equal start and end = no sleep).
  - `digestTime(now: Date, digestAt: string, lastDigestDay?: string): boolean` (true once per local day at or after `digestAt`).
  - `newResults(items: ReviewItem[], state: State, setupAt: string, asOf: string): ReviewItem[]` — `kind === 'lab'`, `date >= asOf - 30 days`, id not in `sentResults`. (Arrival after setup is guaranteed by the caller's `since`.)
  - `dueToSend(items: Item[], state: State, asOf: string): Item[]` — `raiseNow(i, asOf)` and (`sentTopics[i.topic]` absent or `addDays(sent, DAYS[i.importance]) <= asOf`), in the engine's order.
  - `resultMessage(items: ReviewItem[]): string`, `digestMessage(meds: ReviewItem[], due: Item[]): string`.

- [ ] **Step 1: Failing tests**
  - `inSleep`: 22:00–07:00 → 23:30 true, 03:00 true, 07:00 false, 21:59 false; 13:00–14:00 → 13:30 true; `['07:00','07:00']` → always false.
  - `digestTime`: at 08:59 false; 09:00 true; 09:00 with `lastDigestDay` = today false.
  - `newResults`: drops a 40-day-old result, a non-lab item, an already-sent id; keeps a flagged 3-day-old lab even if the previous value was also flagged.
  - `dueToSend`: a high item sent 10 days ago → excluded; 14 days ago → included; `nextMention` in the future → excluded.
  - `resultMessage` for 2 labs: first line exactly `GA: 2 new results`; contains name, value, range, flag, date, source, `previous` when present; ends with `Not medical advice.` and `Reply with a question about it.`
  - `digestMessage`: first line `GA: 3 items for you`; each due item has name, status, due date, `why`, doctor's plan when present; ends with `Reply "done" if you already had one, "not now", or ask a question. Not medical advice.`; meds list name and the line `From the FDA label; not a full interaction screen. Ask your pharmacist.` when label sections exist. Over 1,500 characters: first items kept, then `…and N more: ask GA`.
- [ ] **Step 2:** Run `npx vitest run tests/notify-select.test.ts tests/notify-compose.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the functions above. No I/O in `select.ts` or `compose.ts`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: notify core picks new abnormal results and due items and writes the messages`.

### Task 4: Outbox, tick and the gateway route

**Files:**
- Create: `src/notify/outbox.ts`, `src/notify/tick.ts`
- Modify: `src/gateway/server.ts` (route `POST /notify/exchange`, one-minute timer in `serveGateway` when settings exist and not `off`)
- Test: `tests/notify-tick.test.ts`, `tests/gateway.test.ts` (route)

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `type Outgoing = { id: string; text: string; kind: 'result' | 'digest' | 'reply'; keys: string[] }` (keys: `result:<id>` / `topic:<topic>` marked sent on ack). Outbox file `.ga/notify/outbox.json`. `enqueue(dir, o)`, `pending(dir): Outgoing[]`, `ack(dir, sent: string[], failed: {id: string; error: string}[], now: Date)` (sent: removes, writes keys into `State`, sets `lastSend`; failed: keeps, sets `lastError`).
  - `tick(deps: { client: MedplumClient; patientId: string; dir: string; eps: () => Promise<Endpoint[]>; now: Date }): Promise<void>` — skips during sleep; results: `whatsNew(client, patientId, eps(), { since: max(setupAt, checkedAt - 10 min) })`, `newResults`, excluding keys already in the outbox, one `result` message; digest at `digestTime`: `healthMaintenance` → `dueToSend`, plus `whatsNew` `new medication` items since `lastDigestDay`, one `digest` message if non-empty; sets `lastDigestDay` even when empty; saves `checkedAt`. Each enqueue logs `logRemote(client, 'sent <kind>', 'iMessage')` on ack, not on enqueue.
  - `POST /notify/exchange` body `{ incoming: {from: string; text: string; at: string}[]; sent: string[]; failed: {id: string; error: string}[] }`, header `Authorization: Bearer <token>`; token in `.ga/notify/token` (32 random bytes base64url, 0600, created by `ga notify setup`), compared with `timingSafeEqual`. Response `{ outgoing: {id, text}[] }`. Body limit 64 KB. Incoming is handed to `onIncoming` (Task 5; until then a no-op).

- [ ] **Step 1: Failing tests** (fake client returning fixed `whatsNew`/`healthMaintenance` results through injected functions)
  - `tick during sleep enqueues nothing`; `a 03:00 result is enqueued at 07:00 once` (two ticks at 07:00 and 07:01 → one outbox entry).
  - `tick does not re-enqueue a pending or sent result`; `ack failed keeps it and sets lastError; next exchange returns it again`.
  - `digest on an empty day sends nothing and sets lastDigestDay`.
  - Route: no token / wrong token → 401 and outbox untouched; right token → 200 with pending messages; acked ids are gone on the next call; body over 64 KB → 413.
- [ ] **Step 2:** Run `npx vitest run tests/notify-tick.test.ts tests/gateway.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The timer catches and stores errors in `lastError`; it never throws out of `serveGateway`. A tick never runs while another is running.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: gateway queues GA's messages and exchanges them with the iMessage bridge`.

### Task 5: Answering texts

**Files:**
- Create: `src/llm-chat.ts` (tool loop moved out of `src/share/ask.ts`), `src/notify/reply.ts`
- Modify: `src/share/ask.ts` (uses `chatLoop`), `src/gateway/server.ts` (wire `onIncoming`)
- Test: `tests/notify-reply.test.ts`; `tests/share-ask.test.ts` must pass unchanged

**Interfaces:**
- Produces:
  - `chatLoop(deps: { llm: Llm; model: string }, messages: Any[], tools: Any[], run: (name: string, input: Any) => Promise<unknown>): Promise<string>` — the existing loop, limits and error handling from `ask.ts` unchanged.
  - `ALLOWED: string[]` (Global Constraints list) and `CONFIRM_TOOLS = ['share_create', 'hospital_enable']`.
  - `createReplier(deps: { client; cfg; patientId; dir; publicUrl?: string; llm?: Llm; model?: string; now?: () => Date }): { onIncoming(m: {from: string; text: string; at: string}): Promise<void> }` — owner check (handles compared after lowercasing and stripping spaces, dashes and parentheses); non-owner → `logRemote(client, 'ignored sender', 'iMessage')`, nothing queued. Owner → `logRemote(client, 'received', 'iMessage')`; tools from `remoteTools(client, cfg, patientId)({ publicUrl: publicUrl ?? '', clientName: 'iMessage' })` via an MCP `Client` over `InMemoryTransport.createLinkedPair()`, filtered to `ALLOWED` (minus `CONFIRM_TOOLS` without `publicUrl`); system prompt = the server instructions + `You are answering by text message. Plain text, short. If "done" or "not now" could mean more than one item, ask which. "done" needs at least a year; say what you recorded.`; thread = GA's sent messages and the owner's texts of the last 30 minutes (in memory; `// shortcut: thread memory is per process, lost on restart`). The answer is enqueued as `kind: 'reply'`. No model → enqueue `GA can't answer texts until an AI provider is set (GA_LLM_MODEL).`. Provider error → `GA couldn't answer just now. Try again later.`
- [ ] **Step 1: Failing tests** (fake `Llm` scripted with tool calls, real `buildMcpServer` against a fake client as `mcp-tools.test.ts` does)
  - `non-owner text is ignored and logged without content` (AuditEvent has no text).
  - `the model sees only allowed tools`; without `publicUrl` no `share_create`; with it, `share_create` returns a `confirmUrl` that `findConfirmPage` resolves in the same process.
  - `a disallowed tool call is refused` (`hospital_sync` → error result to the model, not executed).
  - `no model → setup reply`; `provider throws → couldn't-answer reply, gateway keeps running`.
  - `thread carries the last digest so "done" reaches postpone with that topic`.
- [ ] **Step 2:** Run `npx vitest run tests/notify-reply.test.ts tests/share-ask.test.ts`. Expected: reply tests FAIL, share-ask PASS.
- [ ] **Step 3:** Move the loop into `chatLoop` without behaviour change; implement `reply.ts`; wire `onIncoming` in the gateway (incoming handled one at a time, in order).
- [ ] **Step 4:** Run both test files and the full `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: GA answers the owner's texts with its own tools through any AI provider`.

### Task 6: `ga notify` CLI and the iMessage bridge (brief adjusted after Task 1)

**Files:**
- Create: `src/notify/cli.ts`, `src/notify/imessage.ts`
- Modify: `src/cli.ts` (dispatch `notify`)
- Test: `tests/notify-cli.test.ts`, `tests/notify-imessage.test.ts`

**Interfaces:**
- Produces:
  - `ga notify setup --to <handle> [--digest HH:MM] [--sleep HH:MM-HH:MM]` writes settings (`setupAt` = now), the token if missing, and installs `~/Library/LaunchAgents/org.ga.notify-bridge.plist` (`KeepAlive`, runs `node <repo>/src/cli.ts notify bridge`, logs to `.ga/notify/bridge.log` without message text), then `launchctl bootstrap gui/$UID`; prints the permissions to grant (Full Disk Access and Automation for `node`). `ga notify test` enqueues `GA: test message. Reply anything to check replies.`. `ga notify status` prints handle, digest, sleep, last send, last error, outbox size, bridge running or not. `ga notify off` sets `off`, unloads and removes the plist.
  - `imessage.ts`: `sendText(to: string, text: string, run?: (args: string[]) => Promise<void>): Promise<void>` (text passed as an `osascript` argument via `on run argv`, never interpolated into the script); `readSince(dbPath: string, afterRowId: number, owner: string): {rowId: number; from: string; text: string; at: string}[]` using `node:sqlite` read-only, decoding `attributedBody` when `text` is null; skips rows matching a recently sent text (self-message echo, per Task 1's findings).
  - `bridge(deps: { url: string; token: string; dbPath: string; owner: string; every: number })`: loop every 5 s: read new rows, `POST /notify/exchange` with them and the previous round's sent/failed, send each outgoing, remember the last row id in `.ga/notify/bridge.json`.
- [ ] **Step 1: Failing tests**
  - `sendText passes text as an argument` (fake `run` gets `['-e', <script>, to, text]`; a text with quotes and newlines is not in the script).
  - `readSince` on a temp SQLite file with the `message`/`handle` columns from Task 1: returns the owner's reply, not GA's own send, not another handle; a null `text` with `attributedBody` decodes.
  - `setup` writes settings and token 0600 into a temp dir and a plist with the repo path (launchctl injected as a fake); `status` prints last error; `off` removes the plist.
- [ ] **Step 2:** Run `npx vitest run tests/notify-cli.test.ts tests/notify-imessage.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and full `npx vitest run`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: ga notify sets up the iMessage bridge`.

### Task 7: Docs and live check

**Files:**
- Create: `docs/notifications.md` (setup, what gets sent and when, replies, the confirm link, privacy: texts and the needed records go to your AI provider, `ga notify status`/`off`)
- Modify: `README.md` (one bullet line in "What GA does" and a row in the docs table; no other growth), `docs/usage.md` ("Stay on top of your health": the `done` reply), `AGENTS.md` ("Remote chat apps": texts use the allowlist; "What's new": notify does not mark seen)
- [ ] **Step 1:** Write the docs.
- [ ] **Step 2 (controller, with the user):** `docker compose up -d ga-gateway`, `ga notify setup --to <handle>`, `ga notify test`; the user confirms the phone notification and replies "what's due?"; check `ga notify status` and the AuditEvents. No real patient writes beyond what the user asks for.
- [ ] **Step 3:** Commit `docs: GA reaching out by iMessage`.
