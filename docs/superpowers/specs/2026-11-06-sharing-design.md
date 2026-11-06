# GA Milestone 4: Sharing with Doctors and Family — Design

Builds on `2026-11-05-ga-server-design.md` (milestone 1, §7 "Sharing"), 2a, 2b and 3 (`2026-11-05-smart-sync-design.md`), all shipped. Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

## Intent

GA holds all of the user's health data; this milestone lets the user hand it to the people who need it. **[user]**

- **Doctors** sometimes need everything, sometimes only some parts, sometimes only the latest. For them, getting the data matters most: a human-readable copy and a machine-readable copy they can download. **[user]**
- **Parents (family)** often don't know what they need. They should have full access and be able to ask questions about it in plain words; that matters more to them than downloading. **[user]**
- **No feature is held back from either.** Doctors can ask questions; family can download. What differs between shares is which records they cover, how long they last, and the default layout. **[user]**

**Success test [call]:** at a visit, the user opens a share link on their phone and shows its QR code. The doctor scans it on hospital Wi‑Fi with nothing installed and downloads a PDF and a FHIR file of the shared records. The user's parent opens their own link at home and asks "what were the last cholesterol results?", getting an answer that cites the records.

## Scope

- **In:**
  - Share links, each with a scope, an expiry and a layout. Create, list and revoke them from the CLI and from `/ga` in plain words.
  - A read-only web page per share: summary, records, Ask box and downloads.
  - Downloads: a readable PDF and a FHIR R4 JSON Bundle of exactly the shared records.
  - An offline export of the same two files, for uploading to a clinic portal or attaching to an email.
  - An access log the user can read.
- **Delivery [user]:** a QR code shown on the user's phone, a link emailed before the visit, or a file uploaded to the clinic's portal.
- **Non-goals (this milestone):**
  - Family password logins or Medplum invites. A no-expiry link replaces them. **[call]**
  - Any write access for anyone but the user.
  - Shares of other people's records.
  - A live FHIR API for recipients. The FHIR download covers machine-readable needs **[call]**; this narrows §7 of the milestone‑1 design.
  - Creating shares from the phone. That is milestone 5 (messaging).

## Anti-goals

- **No record leaves its share's scope.** A recipient sees, downloads or gets answers about only the records their share covers. This is enforced on the server for every request, the Ask box included, never only by hiding links.
- **Nothing else on the machine is reachable from the internet.** Only the share service is exposed. Medplum, the Medplum app, the MCP server and `.ga/` never are.
- **No guessable or long-lived-by-accident access.** Every link is unguessable. Doctor links expire by default. Revocation takes effect on the next request.
- **No silent access.** Every view, download and question is logged locally, and the user can read the log.
- **No runaway bill.** A leaked link can't run up unlimited Claude API cost.
- **No PHI to anyone but the recipient and the user's AI provider.**
  - The page loads nothing from third parties: no CDNs, fonts or analytics.
  - Questions go only to the user's Claude API account. **[user: "use my AI provider"]**
- **No new dependency for a few lines** (project rule). Use widely used open-source libraries where they replace real code. **[user]**

## Who, what, how long

A share has: **[call]**
- an id;
- a label (e.g. "Dr. Kim", "Mom");
- an audience (`doctor` or `family`);
- a scope;
- an expiry (none allowed);
- a layout (`A` or `B`);
- a daily question cap;
- its token;
- created and revoked times.

- **Scope:** record groups plus an optional date range (`since`, `until`). The groups are labs, vitals, medications, problems, allergies, immunizations, visits, notes and documents, procedures, family history, messages, and Apple daily data; or `all`. **[call]**
  - "Only the latest" is a date range (e.g. `--since 12m`). The summary shows the newest in-scope value per test. **[call]**
  - **The date range filters events only:** labs, vitals, visits, notes and documents, messages, procedures, Apple daily data, and immunization doses. **[call]**
    - Problems, medications and allergies in scope are always included whatever their date when they are active, unconfirmed included. Dropping a 2018 diagnosis from a "last 12 months" share would make the share look complete while being clinically wrong.
    - Inactive or resolved ones follow the date range.
  - **The `Patient` resource is cut down** to name, birth date, sex and the GA id. Address, phone, email, contacts and identifiers (MRNs and any SSN-type id) are never shared. A doctor needs to know whose records these are, not how to reach the patient or bill them. Applied to the page, the PDF, the FHIR file and the Ask tools, with a test. **[call]**
  - Resources referenced by in-scope records are included as needed to read them: Medication, Practitioner, Organization, Location, and an in-scope DocumentReference's Binary.
- **Never shared, even with `all`:**
  - SMART `Endpoint` status records.
  - Whole-export archive DocumentReferences (identifier systems `urn:ga-server:id:ehi-archive`, `urn:ga-server:id:apple-health-archive`).
  - Provenance and AuditEvent.
  - Anything from another patient. **[call]**
- **Defaults [call]:**

  | Audience | Scope | Expiry | Layout | Question cap |
  |---|---|---|---|---|
  | `doctor` | labs, medications, problems, allergies, immunizations, vitals | 7 days | A | 20/day |
  | `family` | `all` | none | B | 20/day |

  Every default can be overridden at creation. **[user: layout picked at creation]**
- **Change:** a share's scope and expiry can't be edited. Revoke it and create a new one. **[call]**

## The page

Phone-width first, server-rendered HTML with inline CSS and no client framework. **[call]** (This replaces the Medplum React components in milestone‑1 §7: no build step, nothing loaded from elsewhere.) It works in light and dark mode.

- **Header:** "Shared by <patient name> · for <label> · expires <date>", the scope in words, and a **Show QR** button that displays this page's own URL as a QR code. This is how the user shows a QR at the visit: they open their own link on their phone. **[call]**
- **Layout A (doctor default), one page:**
  1. Download PDF and Download FHIR (JSON) buttons.
  2. Summary.
  3. Lab table.
  4. Ask box.
- **Layout B (family default), tabs:**
  - Summary;
  - All records (a date-sorted, filterable list of every in-scope record, with notes and documents readable or downloadable);
  - Ask;
  - Download.
- **Summary [call]:**
  - problem list (`problem-list-item` only);
  - current medications;
  - allergies;
  - latest result per lab test with date;
  - latest vitals;
  - vaccinations.
  - Each item shows its date and source.
- **Current medications** follow the medication currency rule in `AGENTS.md` ("Hospital portals (SMART)"). Today that rule exists only as agent instructions; this milestone puts it in code, as one function the page, the PDF and the summary all use. Unconfirmed items show as "unconfirmed (not on the latest hospital list)" rather than being hidden. **[call]**
- **Caveats stay visible** as on `/ga`: `extracted-by-llm` ("read from a document by AI"), `possible-duplicate`, and home versus clinic readings.
- **Expired, revoked and unknown links** all get the same plain "This link is no longer active" page with HTTP 404. A link's existence is never revealed. **[call]**

## Downloads

- **PDF:** the summary plus full tables of every in-scope record by group, with date and source. A cover line gives the patient, the share label, the creation time and the scope. Built from the same summary data as the page, so the two never disagree. **[call]** Library: **pdfmake** (widely used, pure JS). **[call]**
- **FHIR:** an R4 `Bundle` of type `collection` holding exactly the in-scope resources (as defined above). **[call]**
  - `meta.source` is reduced to the file name: GA stores local paths, which may contain the user's account name.
  - GA's own extensions and tags stay. They are harmless and explain provenance.
- **Offline export:** `ga share export <id> [--out dir]` writes the same PDF and JSON to disk. These files are what the user uploads to a portal or attaches to an email; it works with GA's network exposure off. **[call]**

## Ask

- A text box. The answer comes from Claude through the user's own API key. **[user]** Model `claude-opus-5-5`, as in `src/llm.ts`. **[call]**
- **Same rules as `/ga`:**
  - answer only from the records;
  - cite date, value and source;
  - keep the caveats;
  - say what is missing;
  - frame decisions as input for a conversation with a clinician.

  The prompt reads the steps from `.claude/skills/ga/SKILL.md`, as `src/llm.ts` reads `extract.md`, so there is one source of truth. Step 0 (portal status) doesn't apply and is left out. **[call]**
- **Tools Claude gets [call]:**
  - search and read, both forced through the share's scope on the server;
  - `vaccine_gaps`, only when the share has immunizations **and** labs (or `all`) and no date range. It reads every Immunization and immunity lab, so a narrower share would either leak records through its "records used" list or report a false "overdue" from a missing dose. Otherwise the tool isn't offered, and the summary lists doses without a gap verdict. **[call]**
  - `cardiovascular_risk_10yr` (pure computation).
  - Search results carry each medication, problem and allergy's currency status already computed (current or unconfirmed). Claude can't apply the rule itself because Endpoints are never shared. **[call]**
  - No import, no other patient, no Endpoint.
- **Scope enforcement:**
  - Every tool call runs through the same scope filter as the page and downloads.
  - A request for an out-of-scope type or date returns nothing.
  - A read of an out-of-scope id returns "not found".
  - Recipient text and record text are untrusted data. Nothing in them can widen the scope, because scope is never in the prompt's control.
- **Cost guard:** a per-share daily question cap (default 20). When it is reached the page says "question limit reached for today". **[call]** Answers are shown as plain text with line breaks; no markdown rendering. **[call]**
- **No API key configured:** the Ask box shows "Questions are not set up" and everything else works.
- **History:** questions and answers are not kept on the page. A reload starts fresh. They are logged for the user (see Log). **[call]**

## Access and exposure

- **Token:** 32 random bytes, base64url, in the URL path (`/s/<token>`). **[call]**
  - Looked up by its SHA‑256 on every request.
  - Kept encrypted in `.ga/` with the existing AES‑GCM secret store (`src/smart/store.ts`), so `ga shares` can show the link and QR again.
  - Shares are kept in `.ga/shares.json`. They are not FHIR resources, because they hold secrets. **[call]**
- **Service:** a new `ga-share` compose service on the pinned Node image, the same pattern as `ga-sync`. It listens on `127.0.0.1:8110` on the host and uses `node:http`; no web framework for a handful of routes. **[call]** It reads Medplum with GA's client credentials. The Claude API key reaches it as `ANTHROPIC_API_KEY` from the host environment or a gitignored `.env`. **[call]**
- **Internet exposure:** Tailscale Funnel on the GA host proxies `https://<machine>.<tailnet>.ts.net/` → `127.0.0.1:8110`. HTTPS is Funnel's. **[call]**
  - `ga share` checks whether Funnel is on and prints the exact command to turn it on (`tailscale funnel --bg 8110`) rather than running it. **[call]**
  - **[check]** whether Funnel is enabled for the tailnet (an admin policy setting), and that the macOS app's CLI supports `funnel --bg`.
  - Note for the user: the machine name is visible in every link. It can be renamed in Tailscale.
- **Availability:** links work only while the GA host is awake and online. **[user accepted]** The README says this and points to the offline export.
- **Hardening [call]:**
  - Only `/s/<token>/…` routes exist; everything else is 404.
  - Every response sets `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, a strict `Content-Security-Policy` (self only, inline styles allowed), and `X-Robots-Tag: noindex`.
  - Every record value is HTML-escaped.
  - Failed token lookups are rate limited per client IP. Funnel forwards it **[check]** which header.
  - The service never proxies Medplum requests by URL. It calls only its own scoped queries.

## Commands

- `ga share [--for doctor|family] [--label "Dr. Kim"] [--scope labs,meds,…|all] [--since 12m|YYYY-MM-DD] [--until …] [--expires 7d|YYYY-MM-DD|never] [--layout A|B] [--questions N]` prints the link and a terminal QR code. **[call]**
- `ga shares` lists every share: label, audience, scope, expiry, status, last access and access count.
- `ga shares show <id>` prints the link and QR again.
- `ga revoke <id>` revokes a share.
- `ga share log [<id>]` shows the access log.
- `ga share export <id> [--out dir]` writes the PDF and FHIR files to disk.
- **`/ga`:** the skill learns to turn "share my labs from the last 2 years with Dr. Kim for a week" into a `ga share …` command, show the parsed scope and expiry, and run it after the user confirms. The confirmation exists because creating a share sends data out. **[call]** The MCP server gets no share tool; shares are CLI only, like imports and sync. **[call]**
- **QR library:** **qrcode** (widely used) for both the terminal and the page's SVG. **[call]**

## Log

- Each view, download (which file) and question is a local AuditEvent in Medplum. **[call]** It records:
  - the share id and label;
  - the time;
  - the client IP and user agent, as Funnel reports them;
  - for questions, the question text and the answer's length.
- Answers aren't stored. Questions are, so the user can see what their family asked. **[call]**
- `ga share log` and the `ga shares` "last access" column read from these AuditEvents. AuditEvents are never shared (see Scope).

## Constraints

- Node 26 runs `.ts` in strip-only mode: no parameter properties, enums or namespaces.
- Tests:
  - Unit tests with vitest. Integration tests run one file at a time (Medplum's login rate limit).
  - Tests never touch the real patient. Integration tests create their own test patient.
  - No PHI in the repo, fixtures, logs or commit messages.
- New dependencies are pinned exactly (`pdfmake`, `qrcode`, plus their types if needed).
- One patient for now, but nothing may assume one: a share records its `patientId`.

## Left to the builder

- Page markup and styling within the rules above.
- How the scope filter maps groups to FHIR types and search params. This includes **[check]** which date search parameter each type supports in Medplum 5.2.14, and what happens to undated records under a date range (suggested: included only when the range is open-ended).
- Paging and size limits for `all` (the record holds about 30k resources). The page lists lazily, and the FHIR download streams.
- How the Ask tool loop is bounded (turns, tokens).
- Test strategy. It must include an automated scope test: for every route and every Ask tool, out-of-scope records never come back.
