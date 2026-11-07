# Proactive GA (Milestone 7) — Design

Builds on milestones 1–6 and the concept layer (all shipped). Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first.

## Intent

GA holds the whole record but only answers what it is asked. A proactive GA notices what changed and what is due, and says so, with the reason it matters and what slipping costs. **[user]** "It should be proactive." For now it speaks only inside a conversation the person started; GA reaching out on its own (notifications, email) is a later milestone. **[user]**

Order **[user: "what's new" first]**:

1. **What's new**: what changed since the person last looked, and what in it deserves a look.
2. **Health maintenance engine**: screenings and vaccines due, from guidelines and the doctor's own plan. **[user: "a dedicated health maintenance engine", as core as deduplication and the concept layer]**
3. **Surfaces on the engine**: the "By the way" line, the upcoming-due list, the calendar feed.

Each part ships and is usable on its own. One design, three plans.

## Anti-goals

- **No advice GA invented.** Every "why it matters", "what slipping costs", importance and interaction point comes from a cited guideline, label or published source, quoted or closely paraphrased with its edition or date. **[user: "based on guidelines or literature"]**
- **No personal risk numbers** except from a validated calculator GA already ships (cardiovascular risk). General consequences only ("found at a later stage, treatment is harder"). **[user approved]**
- **No money.** Costs mean health consequences; GA cannot see insurance. **[user approved]**
- **No false completeness.** The medication check says it is from the FDA label and is not a full interaction screen. **[user approved]**
- **No nagging.** Not repeated within a conversation; "not now" is respected (see "When an item comes back").
- **Nothing leaves the machine but drug codes or names**, for label lookups. Never record content.
- **No PHI in the repo**: rule tables and label caches hold no patient data; tests use synthetic records.
- **Not medical advice.** Framed as input for a conversation with the clinician (existing TERMS).

## Part 1: What's new

### Shape [user]

1. **A one-line tally** of what changed since the last look: counts by kind (lab results, medications, visits, vaccines, notes, problems) and the sources they came from. Example: "Since Oct 12: 14 new lab results, 2 new medications, 1 visit, 1 vaccine (hospital sync, 1 PDF)."
2. **Then the items worth reviewing, most important first:**
   - **Lab results outside their reference range**, each with the previous value of the same concept (via the concept layer), so new vs ongoing is visible. Only results that carry a range (or the source's own high/low flag) are judged; results with neither are listed as "no range given", never judged. **[call]**
   - **New medications**, checked against the record (see "Medication check").
   - **Follow-ups now due**: vaccine series doses (from today's vaccine check, later the engine), doctor-planned items from Epic health maintenance whose due date arrived, and, once Part 2 ships, the engine's newly due or overdue items.
3. Ends by asking whether to go through the items. GA summarises and points; the person decides. **[call]**

### "Since the last look" [call]

- GA stores one timestamp per install: when "what's new" was last shown (any chat app or Claude Code). The tally covers records whose import time (`meta.lastUpdated` of the first version, or GA's own import time) is after it. **[check]** which timestamp reliably means "arrived in GA" across importers and sync, including records merged or updated by the engine.
- First run: the last 90 days. **[call]**
- Calling with an explicit `since` does not move the stored timestamp. **[call]**

### Medication check [user approved]

- **Codes:** each new medication's RxNorm code from the source or the concept layer; ingredient level for the label lookup. Uncoded: listed as "not checked: no standard code".
- **Source:** the FDA label from openFDA (`/drug/label.json`, `search=openfda.rxcui:"<rxcui>"`, plus `_exists_:drug_interactions` to skip labels without sections; CC0, no key needed, 1,000 requests a day per IP). Sections: Boxed Warning, Contraindications, Warnings and Precautions, Drug Interactions, Use in Specific Populations. DailyMed as fallback **[check]**.
- **Cache:** label sections cached locally by RxNorm code with their effective date; refreshed after 30 days **[call]**. Not in the FHIR record (it is reference data, not the person's).
- **Who reads it:** the agent. The tool returns the relevant label sections next to the person's current medications, active problems and recent out-of-range labs; the tool's instructions say to report only what the label says, quoting the section and label date, and to end with "from the FDA label; not a full interaction screen, ask your pharmacist". GA does not judge interactions in code.
- **Structured supplements [call: later in Part 1 if cheap]:** RxClass `CI_with` (drug–disease contraindications, live API, not shipped), the ONC high-priority interaction pairs (small, hard-coded). Not DDInter (non-commercial licence).
- Only RxNorm codes leave the machine.

### Tool and wiring

- MCP tool **`whats_new {since?}`** on both transports, read-only. Returns the tally, the review items (each with its evidence: record dates, values, sources), the label sections for new medications, and `portalWarning` like every read tool.
- Chat instructions (AGENTS.md, chat-apps instructions, `/ga` skill): call `whats_new` at the start of a health conversation when it has not been shown in this conversation, answer the person's question first, then offer the summary in one short line. **[call]** (The "By the way" line in Part 3 generalises this.)
- CLI: `ga whats-new [--since YYYY-MM-DD]`.

## Part 2: Health maintenance engine

### What it reads and returns

- **Reads:** birth date, sex, problems, procedures, immunizations, lab results, all through the concept layer (so a colonoscopy, FIT or stool DNA test from any source counts as colorectal screening).
- **Rule sets, shipped in the repo, each with edition and source URL:**
  - **USPSTF** recommendations, grades A, B and C.
  - **CDC/ACIP adult schedule**: today's `vaccine_gaps` logic moves into the engine; `vaccine_gaps` becomes a view of it.
  - **Guideline follow-up intervals where a guideline defines them for a history in the record** (for example post-polypectomy surveillance intervals). **[call]** which ones ship first.
- **Second opinion: the doctor's plan.** Epic health maintenance Observations (`Health maintenance: <topic>`, status and Next due), as of their export or sync date, and doctor-planned follow-ups an agent finds in notes (quoted with date, recorded by the agent, never inferred by code). **[check]** how to store an agent-found plan (a GA-tagged record the engine reads).
- **Returns: a list of items**, each with:
  - topic and its concept;
  - status: done, due soon, due, overdue, postponed, not for you;
  - due date(s) from the guideline and from the doctor's plan;
  - evidence: the records that satisfied it, with dates and sources;
  - why it matters and what slipping costs, from the rule set, with citation;
  - importance;
  - when it may next be mentioned.

### Guideline and doctor's plan [user: show both]

- Agree: one due date, both sources listed.
- Differ: both shown, labelled ("doctor's plan: 2027, from the health maintenance as of <date>"; "guideline: 2034, routine screening"). GA does not pick or explain away the difference.
- The earlier of the two drives due status, the line, the list and the calendar, so nothing slips. **[call]**
- Epic artefacts (a due date before birth, a topic with no status) are shown as status only, never as a date. **[call]**

### Importance [user: from guidelines or literature]

- **Screenings (USPSTF grade):** A or B high; C low, worded "worth discussing with your doctor"; D and I never raised.
- **Vaccines (ACIP category):** routine for age medium; a started series overdue high; shared clinical decision-making low; risk-based medium, only when the risk factor is in the record.
- **Doctor-planned follow-ups:** high when overdue, medium otherwise **[call]**.
- How overdue an item is changes status, not importance. **[call]**

### When an item comes back [user: "depends on the importance"]

- After "not now": high in 2 weeks, medium in 2 months, low next year (or never, once dismissed). **[call]** the intervals.
- A postponement the person sets ("in spring", a date) overrides these.
- Postponements, dismissals and "last mentioned" are stored in GA as records the person (through the agent) wrote, with Provenance, and come back with a restore. **[check]** resource type (e.g. a GA-tagged Flag or Basic, or a Task per item).
- MCP tools: `health_maintenance {asOf?}` (the list), `postpone {topic, until | reason}` (two-step confirm not needed: it changes only GA's own reminders) **[call]**.

## Part 3: Surfaces on the engine

- **"By the way" line [user]:** after answering the person's question, one short line: "By the way, colorectal cancer screening is overdue since March. Want to review it now?" Several open items: the most important named, plus a count. Yes: go through them one at a time, each with why and cost of slipping. No or ignored: no push. At most once per conversation, only in health conversations. **[call]** on the last two.
- **Upcoming-due list:** items due in the next N months (default 6) **[call]**.
- **Calendar feed:** an iCalendar (`.ics`) subscription URL served by `ga-gateway` behind a secret token, events on due dates, no clinical details beyond the topic name **[call]**. **[check]** that calendar apps can subscribe through Tailscale Funnel; token revocation like share links.
- What's new picks up engine items automatically.

## Item copy [user approved]

Each item reads: what and when; why it matters for this person (age, sex, history from the record); what slipping costs (general consequences from the cited source); source with grade or category and edition. Tone: factual and calm, like a good clinician's note. Example (synthetic): "Colorectal cancer screening, due since March 2026. Screening finds cancer and precancerous polyps early, when removal or treatment works best; found later, treatment is more extensive and survival lower (USPSTF 2021, grade A for ages 50–75)."

## Left to the builder

- Rule-table file format; which USPSTF topics and follow-up intervals ship first (at least: colorectal, cervical, breast, lung, prostate decision, AAA, hepatitis B/C, HIV, diabetes, lipids, blood pressure, depression, and the ACIP adult schedule already shipped).
- Mapping Epic health maintenance topic names to engine topics (a per-source map, like the concept layer).
- How `whats_new` ranks review items within a kind.
- Label-section trimming (labels are long): which paragraphs to return.

## Decisions from the builder check [call]

1. **Arrival marker.** No field records when a record first reached GA (`meta.lastUpdated` moves on every write, `source-date` is the clinical date). The engine stamps an `urn:ga-server:ext:arrived` instant on create only, never on update; records without it count as "before tracking" and are never new (changed in planning: moving GA into its own project re-created every record on one day, so `_history` gives the move date, not the arrival).
2. **Shown, not called.** Calling `whats_new` moves nothing. The agent passes `markSeen: true` only on the call whose summary it actually showed; that moves the stored timestamp. "Once per conversation" is an instruction to the agent: MCP has no conversation id.
3. **Doctor's plan freshness.** Epic health maintenance comes only from EHI exports today; accepted for Part 2. Each doctor's-plan date shows its as-of date. Portal ServiceRequest/CarePlan are read when a source returns them (none today).
4. **Agent-found plans.** A new tool `record_followup {topic, due, quote, documentRef}` with the two-step confirm (preview, the person's yes, then write), stored as a GA-tagged `Basic` with Provenance.
5. **Shares.** Postponements, dismissals and agent-found plans (`Basic` records tagged by GA) are added to the never-shared list.
6. **Label lookup.** Ingredient RxNorm code to product codes through RxNav (codes only), then the newest openFDA label carrying the needed sections. Cache keyed by the RxNorm code looked up (changed in planning: simpler, same result); the citation gives the label's `set_id` and `effective_time`.
7. **`vaccine_gaps` keeps its output shape** as a view of the engine; its instructions and tests stay.
8. **Calendar feed** exists only with `GA_PUBLIC_URL` (remote mode), tokens like share links. Subscribing through Funnel is tested live before building it.
9. **Sex-specific rules.** Read `Patient.gender` plus relevant history (e.g. hysterectomy); when ambiguous, the item reads "discuss with your doctor", never "not for you".
10. **What counts as new [user].** The tally counts everything that arrived, split into recent and historical (clinical date older than 12 months). Review items flag out-of-range results with a clinical date in the last 12 months only; older ones stay reachable through `lab_results`. A medication is new the first time its concept appears in the record, not when another source repeats it. Updated or merged records are not counted, except a medication or problem whose status changed.
