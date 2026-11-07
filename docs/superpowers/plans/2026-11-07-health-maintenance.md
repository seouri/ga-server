# Health Maintenance Engine (Proactive GA, Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A health maintenance engine that lists screenings, vaccines and doctor-planned follow-ups with status, due dates from the guideline and the doctor's plan side by side, evidence, why it matters, importance and when it may next be mentioned; plus tools to postpone or dismiss an item and to record a follow-up the agent found in a note.

**Architecture:** A shipped USPSTF rule file and a pure evaluator (`src/screenings.ts`) turn the record into guideline items; `src/maintenance.ts` adds vaccine items (from the existing `vaccineGaps`), the doctor's plan (Epic health maintenance Observations and agent-recorded follow-ups) and the person's reminders (GA-tagged `Basic` records), and computes status, importance and next mention. MCP tools in `src/tools/maintenance.ts`; `whats_new` takes its follow-ups from the engine.

**Tech Stack:** Node 26 strip-only TypeScript, Medplum client, vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-proactive-ga-design.md` (Part 2; "Decisions from the builder check" 3, 4, 5, 7, 9).

## Global Constraints

- Node 26 type stripping: no enums, namespaces or parameter properties; `.ts` import suffixes. `npx tsc --noEmit -p .` clean.
- No advice GA invented: every item's `why`, `cost` and importance come from the rule file, each topic with its source URL, grade or category, and publication date; `why` and `cost` are quoted or closely paraphrased from that source's own text. **[user]**
- No personal risk numbers, no money. Tone factual and calm. **[user]**
- Importance **[user: from guidelines]**: USPSTF A or B high; C low, worded "worth discussing with your doctor"; D and I never raised. Vaccines: routine medium; a started series overdue high; shared clinical decision-making or not evaluated low. Doctor-planned follow-ups: high when overdue, medium otherwise.
- After "not now": high 14 days, medium 60 days, low 365 days; a person's postponement date overrides; dismissed: never. **[call]**
- Guideline and doctor's plan both shown, each labelled with its source and as-of date; the earlier date drives status. Epic dates before the birth date are never shown as dates. **[user / call]**
- Sex-specific rules: when `Patient.gender` is not male or female, or a relevant history may change eligibility, the item's status is `discuss`, never `not for you`. **[call, decision 9]**
- Nothing leaves the machine. No PHI in the repo; tests use synthetic records; integration tests only in the long-lived `ga-test` project.
- Each task ends with a ponytail pass on its own diff. **[user]**

## Review Focus

1. **A screening done under another name or code** (an uncoded "Colonoscopy" Procedure from a PDF, a FIT result as an Observation, a CPT-coded colonoscopy) counts as done. (Task 1 tests.)
2. **A record with a GA-suggested code only** (tag `concept-suggested`) does not count as done: it is a guess. (Task 1 test.)
3. **An Epic topic GA has no rule for** (e.g. "LIPID PANEL - YEARLY") still appears, as a doctor's-plan-only item. (Task 2 test.)
4. **A postponement past its date** no longer hides the item; a dismissed high-importance screening is never dismissed (only low items can be). (Task 2 tests.)
5. **Sex unknown** turns cervical, breast, prostate and AAA into `discuss`, not `not for you` and not `due`. (Task 1 test.)

## Rulings made while planning (spec "[call]"s)

- Guideline follow-up intervals for a history (e.g. post-polypectomy surveillance) do not ship in this plan: they depend on pathology details code cannot read. The doctor's plan side (Epic health maintenance, agent-recorded follow-ups) carries them. Recorded in the spec.
- Status set: `done | due soon | due | overdue | postponed | not for you | discuss`. `discuss` is added for decision 9 and for vaccines the schedule leaves to risk factors or shared decision-making.
- `vaccine_gaps` is not changed (decision 7 keeps its shape); the engine calls `vaccineGaps` and maps its results.
- Postponements, dismissals and agent-recorded follow-ups are `Basic` records; `Basic` is added to the never-shared types (no importer writes `Basic`).

---

### Task 1: USPSTF rule file and screening evaluator

**Files:**
- Create: `src/schedules/uspstf-screening.json`, `src/screenings.ts`
- Test: `tests/screenings.test.ts`

**Interfaces:**
- Produces (src/screenings.ts):
  - `export type Topic = { id: string; name: string; grade: 'A' | 'B' | 'C'; source: string; published: string; ages: [number, number]; sex?: 'male' | 'female'; riskBased?: string; doneBy: { name: string; types: string[]; codes: string[]; text?: string; years: number | null }[]; why: string; cost: string; epic?: string[] }` (`codes` as `system|code`; `text` a lower-case substring for uncoded records; `years: null` = once in a lifetime; `riskBased`: the eligibility words GA cannot check, quoted; `epic`: upper-case substrings of Epic health maintenance topic names that mean this topic).
  - `export type Rules = { edition: string; topics: Topic[] }` and `export function loadRules(): Rules`.
  - `export type ScreenInput = { birthDate: string; sex?: 'male' | 'female'; records: Resource[] }` (Procedure, Observation, DiagnosticReport, Immunization ignored).
  - `export type Status = 'done' | 'due soon' | 'due' | 'overdue' | 'postponed' | 'not for you' | 'discuss'`
  - `export type GuidelineItem = { topic: string; name: string; status: Status; grade: string; dueDate?: string; last?: { date: string; by: string; source?: string; id?: string }; reason: string; why: string; cost: string; citation: string }`
  - `export function evaluateScreenings(rules: Rules, input: ScreenInput, asOf: string): GuidelineItem[]`

- [ ] **Step 1: Write the rule file.** Topics, each from its current USPSTF recommendation statement (https://www.uspreventiveservicestaskforce.org/uspstf/recommendation-topics), with the statement's URL in `source`, its date in `published`, `why` from its "Importance" or rationale text and `cost` from its description of the harm of the condition found late, both quoted or closely paraphrased:
  - `colorectal`: A 50–75, B 45–49 (two age entries: use two topics `colorectal` and `colorectal-45` or an age-grade list; pick one and keep `evaluateScreenings` simple). doneBy: colonoscopy 10 y, FIT/gFOBT 1 y, stool DNA-FIT 3 y, CT colonography 5 y, flexible sigmoidoscopy 5 y. Seed codes from `config/concepts.json` "colorectal cancer screening" plus FIT LOINC codes (verify each LOINC at https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?terms=<code>&sf=LOINC_NUM — send only the code).
  - `cervical`: A, female 21–65; cytology 3 y, hrHPV or cotesting 5 y (30–65).
  - `breast`: B, female 40–74; mammography 2 y.
  - `lung`: B, 50–80, `riskBased` ("20 pack-year smoking history and currently smoke or have quit within the past 15 years"); low-dose CT 1 y.
  - `prostate`: C, male 55–69; PSA, `years: null` (C: a discussion, not a schedule).
  - `aaa`: B, male 65–75, `riskBased` ("ever smoked"); ultrasound once.
  - `hepatitis-c`: B, 18–79; HCV antibody test once.
  - `hiv`: A, 15–65; HIV test once.
  - `diabetes`: B, 35–70, `riskBased` ("overweight or obesity"); A1c or fasting glucose 3 y.
  - `blood-pressure` (A, 18-39, a blood pressure reading every 3 y) and `blood-pressure-40` (A, 40+, every 1 y).
  - `epic` substrings at least: colorectal `COLORECTAL`, `CRCS`; cervical `CERVICAL`, `PAP`; breast `MAMMO`, `BREAST`; prostate `PSA`; hepatitis-c `HEP C`; hiv `HIV`.
- [ ] **Step 2: Failing tests** (`tests/screenings.test.ts`, synthetic records, `asOf: '2026-11-07'`):
  - `'a colonoscopy in any form counts'`: an uncoded Procedure `code.text: 'Colonoscopy'` dated 2020-03-01 → colorectal `done`, `dueDate: '2030-03-01'`; the same with CPT 45378 → same; a FIT Observation (LOINC) dated 2026-01-10 → dueDate 2027-01-10, status `done`.
  - `'due soon within 90 days, overdue past the date'`: colonoscopy 2016-12-01 → dueDate 2026-12-01 → `due soon`; colonoscopy 2016-01-01 → `overdue`.
  - `'never done and eligible is due'`: birth 1970-01-01, no records → colorectal `due` with no dueDate.
  - `'a suggested code is not evidence'`: a Procedure whose only matching coding is GA-added and tagged `concept-suggested` → colorectal `due`.
  - `'out of age range is not for you'`: birth 2000-01-01 → colorectal `not for you`.
  - `'sex unknown is discuss'`: birth 1970-01-01, sex undefined → cervical, breast, prostate, aaa `discuss`.
  - `'risk-based topics are discuss with the quoted words'`: lung `discuss`, reason contains the `riskBased` text.
  - `'grade C reads worth discussing'`: prostate for a 60-year-old male → status `discuss`, reason contains "worth discussing with your doctor".
  - `'every topic cites its source'`: each topic in the shipped file has `source` starting `https://www.uspreventiveservicestaskforce.org/`, a `published` date, non-empty `why` and `cost`.
- [ ] **Step 3:** Run `npx vitest run tests/screenings.test.ts` → fail.
- [ ] **Step 4:** Implement. Match a record when a **trusted** coding (`trusted` from `src/concept-apply.ts`) is in `codes`, or the record's `code.text`/display contains `text`. `last` = the newest match's date; `dueDate` = last + years (none when `years` is null: done once is done). `due soon` = dueDate within 90 days of asOf.
- [ ] **Step 5:** `npm test`, `npx tsc --noEmit -p .` → pass.
- [ ] **Step 6:** Ponytail pass; commit `feat: USPSTF screening rules and evaluator`.

### Task 2: Doctor's plan, reminders and combining

**Files:**
- Create: `src/maintenance.ts`
- Modify: `src/confirm.ts` (Kind adds `'followup'`), `src/share/scope.ts` (`Basic` in `NEVER`)
- Test: `tests/maintenance.test.ts`, `tests/share-scope.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `vaccineGaps` result shape (src/vaccines.ts).
- Produces (src/maintenance.ts):
  - `export const REMINDER = 'urn:ga-server:reminder'` (Basic.code system; codes `not-now`, `postpone`, `dismiss`, `followup`), extension URLs `urn:ga-server:ext:topic`, `urn:ga-server:ext:until`, `urn:ga-server:ext:due`, `urn:ga-server:ext:quote`.
  - `export type Plan = { due?: string; status?: string; asOf: string; from: 'epic' | 'agent'; source?: string; id?: string; quote?: string }`
  - `export type Item = { topic: string; name: string; kind: 'screening' | 'vaccine' | 'follow-up'; status: Status; importance: 'high' | 'medium' | 'low'; dueDate?: string; guideline?: { dueDate?: string; grade?: string; citation: string; reason: string }; doctorsPlan?: Plan; evidence: { date: string; by: string; source?: string; id?: string }[]; why?: string; cost?: string; nextMention?: string | null }` (`nextMention: null` = never).
  - `export function vaccineItems(v: Awaited<ReturnType<typeof vaccineGaps>>): Item[]`: complete/immune → done; due → due; overdue → overdue; not-recommended → not for you; not-evaluated → discuss. Importance: overdue with records high; due or overdue medium; discuss low. `why` = the result's reason; citation = the schedule edition.
  - `export function epicPlans(hm: Observation[], birthDate?: string): { topic: string; plan: Plan }[]`: one per `Health maintenance: <topic>` Observation; `due` from the "Next due date" component unless before `birthDate`; `asOf` = its `urn:ga-server:ext:source-date`; `status` = `valueString`.
  - `export function combine(guideline: GuidelineItem[], vaccines: Item[], plans: { topic: string; plan: Plan }[], reminders: Basic[], rules: Rules, asOf: string): Item[]`:
    - A plan joins the guideline item whose `epic` substrings match its topic name (case-insensitive), else becomes its own `kind: 'follow-up'` item named after the Epic topic. Agent follow-ups (Basic `followup`, topic = an engine topic id or a free name) join the same way.
    - `dueDate` = the earlier of guideline and plan due dates; status from that date as in Task 1 (`done`/`due soon`/`overdue`); a plan whose Epic status is "Overdue" with no date makes the item `overdue`; "Completed"/"Not Due" with no date leaves the guideline status.
    - Follow-up-only importance: high when overdue, medium otherwise. Screening importance: grade A/B high, C low. Status `not for you` items are dropped from the list unless a plan exists.
    - Reminders: the newest Basic per topic wins. `postpone` with `until` > asOf → status `postponed`, `nextMention` = until. `not-now` → `nextMention` = its date + 14/60/365 days by importance. `dismiss` → `nextMention: null`, only for importance low (a dismiss on a high or medium item is ignored).
    - Sorted: overdue, due, due soon, discuss, postponed, done; then importance high→low; then dueDate.
- [ ] **Step 1: Failing tests** (`tests/maintenance.test.ts`, synthetic):
  - `'doctor's plan and guideline both shown, earlier date drives'`: guideline colorectal dueDate 2034-01-01, Epic `Health maintenance: COLORECTAL SCREENING` Next due 2027-05-01 as of 2026-10-15 → one item, `dueDate: '2027-05-01'`, `guideline.dueDate: '2034-01-01'`, `doctorsPlan.due: '2027-05-01'`, `doctorsPlan.asOf: '2026-11-03'`.
  - `'an Epic topic with no rule is its own follow-up'`: `Health maintenance: LIPID PANEL - YEARLY`, Next due 2027-10-15 → item `kind: 'follow-up'`, `importance: 'medium'`, status `done`.
  - `'Epic date before birth is not a date'`: Next due 1976-05-21 with birth date 1980-01-01 → `doctorsPlan.due` undefined; Epic status "Overdue" → item `overdue`.
  - `'postpone hides until its date, then not'`: postpone until 2026-12-01 → `postponed`; with asOf 2026-12-02 → back to its status.
  - `'not now by importance'`: not-now on 2026-11-01 for a high item → nextMention 2026-11-15; medium → 2026-12-31; low → 2027-11-01.
  - `'dismiss only for low items'`: dismiss on prostate (C, low) → nextMention null; dismiss on colorectal (A) → ignored.
  - `'vaccine statuses map'`: a `vaccineGaps`-shaped fixture with each status → expected status and importance.
  - `tests/share-scope.test.ts`: a `Basic` resource is never in scope.
- [ ] **Step 2:** Run → fail. **Step 3:** Implement. **Step 4:** `npm test`, tsc → pass.
- [ ] **Step 5:** Ponytail pass; commit `feat: health maintenance combining (doctor's plan, reminders, vaccines)`.

### Task 3: Loader against the record

**Files:**
- Modify: `src/maintenance.ts`
- Test: `tests/integration/maintenance.test.ts`

**Interfaces:**
- Produces: `export async function healthMaintenance(client: MedplumClient, patientId: string, asOf = today): Promise<{ asOf: string; edition: string; items: Item[]; note: string }>`; `note` (exact): "Guideline items cite their source. The doctor's plan is shown as of its date. Not medical advice: input for a conversation with your clinician."
  - Reads: Patient (birth date, gender → sex only when male/female), Procedure, DiagnosticReport, Observation (category laboratory, vital-signs, or none; plus `code:text=Health maintenance`), Basic with `code=urn:ga-server:reminder|` — all for the patient, cursor-paged (`_sort=_lastUpdated`, `_count=1000`), and `vaccineGaps(client, patientId, asOf)`.
  - Births missing: throw `GaError('Patient has no birthDate in GA')`.
- [ ] **Step 1: Failing integration test** in the ga-test project: a synthetic patient record set (a colonoscopy Procedure 2019-01-10, an Epic HM Observation, a `not-now` Basic) → `healthMaintenance` returns colorectal `done` with that evidence, the Epic item, and the not-now nextMention. Run `npx vitest run --dir tests/integration maintenance` → fail.
- [ ] **Step 2:** Implement. **Step 3:** test passes; `npm test`, tsc clean.
- [ ] **Step 4:** Ponytail pass; commit `feat: health maintenance loader`.

### Task 4: Tools, CLI, whats_new follow-ups and docs

**Files:**
- Create: `src/tools/maintenance.ts`
- Modify: `src/mcp.ts` (register), `src/cli.ts` (`ga maintenance [--as-of YYYY-MM-DD]`), `src/whats-new.ts` (follow-ups from the engine), `src/instructions.ts` (two-step confirm list adds `record_followup`), `.claude/skills/ga/SKILL.md` (step 7: call `health_maintenance` for screenings and vaccines; Epic HM is inside it as the doctor's plan), `AGENTS.md`, `docs/usage.md`, `docs/chat-apps.md`
- Test: `tests/tools-maintenance.test.ts`, `tests/whats-new.test.ts`, `tests/instructions.test.ts`

**Interfaces:**
- Consumes: `healthMaintenance`, `REMINDER` and ext URLs (Task 2/3), `preview`/`takeConfirmed` (`'followup'`).
- Produces (MCP, both transports):
  - `health_maintenance {asOf?}`: read-only, through `warned(...)`; description says to relay status, both dates with their labels, why and cost with the citation, and never to judge the guideline itself.
  - `postpone {topic, until?: YYYY-MM-DD, dismiss?: boolean, reason?}`: no confirm; writes a `Basic` (`postpone` when `until`, `dismiss` when `dismiss`, else `not-now`) with Provenance (agent = client name, as `map_concept` does); refuses a topic the engine doesn't list.
  - `record_followup {topic, due: YYYY-MM-DD, quote, documentRef: "DocumentReference/<id>", confirm?}`: without `confirm` returns a preview (`preview('followup', args)`); with a valid `confirm` writes a `Basic` `followup` with Provenance. The referenced DocumentReference must exist and belong to the patient; `quote` must appear in its text (case- and space-insensitive).
  - `whats_new`: `followUpItems` is replaced by engine items with status `overdue` or `due soon` whose `nextMention` is absent or ≤ asOf.
- [ ] **Step 1: Failing tests:** `postpone` writes the expected Basic and refuses an unknown topic; `record_followup` returns a preview first, writes only with the confirm code, refuses a quote not in the document; `health_maintenance` is registered on stdio and remote builds; chat instructions list `record_followup` among two-step confirms; `whats_new` includes an overdue engine item and omits one whose nextMention is in the future.
- [ ] **Step 2:** Run → fail. **Step 3:** Implement and update docs. **Step 4:** `npm test`, tsc, `npx vitest run --dir tests/integration maintenance whats-new` → pass.
- [ ] **Step 5: Live check (controller):** `node src/cli.ts maintenance` on the user's record runs; report counts by status and kind only.
- [ ] **Step 6:** Ponytail pass; commit `feat: health_maintenance, postpone and record_followup tools; whats_new follow-ups from the engine; docs`.
