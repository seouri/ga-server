# Apple Health Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ga import <apple-health-export-folder>` loads the clinically useful part of an Apple Health export into GA. It writes per-reading vitals, daily summaries, sleep, the ECG and the hospital records inside the export. It archives the whole folder, and re-importing changes nothing.

**Architecture:** `src/apple/` follows the `src/ehi/` pattern:
- a streaming reader over `export.xml`;
- pure mappers that produce FHIR resources, each carrying a first identifier in `urn:ga-server:id:apple-health`;
- an importer that archives the folder, drops resources unchanged since the last import, and sends the rest through `importResources` with `SourceInfo.kind = 'apple-health'`.

The engine learns two things: Apple readings never join day-level possible-duplicate flags, and an Apple reading that exactly matches a hospital record only adds its identifier.

**Tech Stack:** TypeScript on Node 26 (runs .ts natively), vitest, `@medplum/core` 5.2.14, Medplum via `compose.yaml`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-apple-health-import-design.md`

## Global Constraints

- No PHI in the repo. Fixtures are synthetic. Real-data checks read `GA_REAL_DATA_APPLE` and print counts and timings only. Source and device names contain the user's name, so never print them.
- Nothing leaves the machine.
- No new dependencies.
- LOINC goes only on per-reading records and only for the codes listed in Task 3. Daily summaries are `code.text` only, except steps (41950-7).
- Every Apple resource's first identifier is `{system: 'urn:ga-server:id:apple-health', value}`. Identifier values for readings and daily records are sha256 hex, never raw source names.
- Source date for every resource is the export's `ExportDate`, converted to ISO, e.g. `2026-11-05T13:39:52-05:00`.
- Apple dates `YYYY-MM-DD HH:MM:SS ±HHMM` become ISO with the record's own offset (`YYYY-MM-DDTHH:MM:SS±HH:MM`). A record's local day is the first 10 characters.
- Every skip is counted with a reason in the import report.
- Unit tests: `npm test`. Integration tests (need `docker compose up`): `npm run test:int`. Typecheck: `npm run typecheck`.

## Review Focus

1. **A hospital vital imported after Apple data on the same day must not flag either record.** An example is the next Epic export bringing a clinic weight. The test goes in Task 1.
2. **A later export that renames the iPhone/Watch must not duplicate past readings.** This resolves the spec's `sourceName` [check]: reading keys leave out the source (Task 3). The test is in Task 3, and Task 6 tests it end to end.
3. **Records nested in `<Correlation>`/`<Workout>` must be counted once.** They also appear at top level. The test is in Task 2.
4. **An XML entity in a source name (`&amp;`, `&#8217;`) must not break parsing or keys.** The test is in Task 2.
5. **The newest export's last day is partial.** A later export must update that day's summaries instead of skipping them as unchanged. The test is in Task 6.

---

### Task 1: Engine — `apple-health` source kind and dedup rules

**Files:**
- Modify: `src/identity.ts` (`SourceInfo.kind`, `stableIdentifier`)
- Modify: `src/engine.ts` (`importResources` content-match block, ~lines 316–364)
- Test: `tests/identity.test.ts`, `tests/integration/engine.test.ts`

**Interfaces:**
- Produces:
  - `SourceInfo.kind` includes `'apple-health'`.
  - `export const APPLE = 'urn:ga-server:id:apple-health'` in `src/identity.ts`.
  - For `kind: 'apple-health'`, `stableIdentifier` returns the resource's first identifier when its system is `APPLE`, otherwise throws `GaError('<type> has no Apple Health identifier')`. This mirrors the EHI branch.
  - `stamp` adds tag `src-apple-health` automatically through the existing code.

- [ ] **Step 1: Write failing unit tests in `tests/identity.test.ts`**
  - `stableIdentifier(obsWithAppleId, {kind:'apple-health', …}, '')` returns `{system: APPLE, value: 'abc'}`.
  - An Observation without an Apple identifier throws `/no Apple Health identifier/`.
- [ ] **Step 2: Run `npm test -- tests/identity.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the `SourceInfo`/`APPLE`/`stableIdentifier` change.**
- [ ] **Step 4: Write failing integration tests in `tests/integration/engine.test.ts`.** Use `createTestPatient`. Use weight LOINC 29463-7 kg. Start with an `ehi` source dated 2026-01-01 and an `apple-health` source dated 2026-11-05, then add these tests:
  - `apple reading on a hospital day is not a possible duplicate`:
    - Import an EHI weight at `2026-03-01T09:00:00-05:00`, value 80 kg.
    - Then import an Apple weight at `2026-03-01T07:00:00-05:00`, value 79 kg.
    - Expect `possibleDuplicates: 0, created: 1`, and neither record tagged `possible-duplicate`.
  - `hospital reading after apple on the same day is not a possible duplicate`: the reverse order. Expect `possibleDuplicates: 0`.
  - `two apple readings same day are both kept`: Apple 79 kg at 07:00 and 79.4 kg at 21:00 in one batch. Expect `created: 2, possibleDuplicates: 0`.
  - `apple exact match keeps the hospital body`:
    - Start from an EHI weight 80 kg at 09:00 with a `note` text "clinic".
    - Then import an Apple weight 80 kg at the same instant.
    - Expect `merged: 1`, one record, the `note` still present, and both identifiers on it.
  - `day-level flag still works between hospital sources`: an existing C-CDA/EHI pair test in this file still passes unchanged.
- [ ] **Step 5: Run `npm run test:int -- tests/integration/engine.test.ts`.** Expected: the new tests FAIL.
- [ ] **Step 6: Implement in `importResources`.** `isApple(r)` = any identifier with system `APPLE`.
  - **(a) Day-level match list:** `matches` excludes candidates where `isApple(m)`, and is empty when `source.kind === 'apple-health'`. Leave `contentMatches` alone, so the exact-time + same-value `same` lookup still runs.
  - **(b) Apple onto a non-Apple record:** in the `same` branch, when `source.kind === 'apple-health' && !isApple(same)`, take the identifier-only path (`protect({...same, identifier: [...same.identifier, ident]})`, `merged++`) whatever `decide` returns.
- [ ] **Step 7: Run `npm test && npm run test:int -- tests/integration/engine.test.ts && npm run typecheck`.** Expected: all PASS.
- [ ] **Step 8: Commit** `feat: apple-health source kind; Apple readings never flag day-level duplicates`

---

### Task 2: Streaming reader for `export.xml`

**Files:**
- Create: `src/apple/read.ts`
- Create: `tests/fixtures/apple/export.xml`, `tests/fixtures/apple/clinical-records/Patient-A.json`, `tests/fixtures/apple/clinical-records/AllergyIntolerance-B.json`, `tests/fixtures/apple/electrocardiograms/ecg_2024-02-11.csv` (all synthetic)
- Test: `tests/apple-read.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AhRecord = { type: string; unit?: string; value?: string; sourceName: string; startDate: string; endDate: string }; // dates already ISO
  export type AhSummary = { date: string; activeEnergyBurned?: number; activeEnergyBurnedUnit?: string; appleExerciseTime?: number; appleStandHours?: number; activeEnergyBurnedGoal?: number; appleExerciseTimeGoal?: number; appleStandHoursGoal?: number };
  export type AhClinical = { type: string; sourceURL: string; fhirVersion: string; resourceFilePath: string };
  export function isAppleHealthExport(dir: string): boolean; // export.xml exists and its first 4 KB contain '<!DOCTYPE HealthData'
  export function appleDate(s: string): string;              // '2017-11-03 10:13:05 -0500' -> '2017-11-03T10:13:05-05:00'
  export async function readExport(dir: string, on: { record(r: AhRecord): void; summary(s: AhSummary): void; clinical(c: AhClinical): void }): Promise<{ exportDate: string; nested: number }>;
  ```

**Fixture `export.xml`.** Copy the real DTD header shape: `<!DOCTYPE HealthData [ … ]>`, `<HealthData locale="en_US">`, `<ExportDate value="2026-11-05 13:39:52 -0500"/>`, `<Me …/>`. Then add one element per line, with source names `Test Watch` and `Test iPhone`:
- 3 HeartRate records on 2026-03-01 from Test Watch (60, 80, 100 count/min). One has `<MetadataEntry>` children on the following lines.
- Steps on 2026-03-01: Test Watch 4,000 + 3,000, and Test iPhone 5,000.
- 2 BodyMass readings on 2026-03-01 (79 and 79.4 kg). One BodyMass on 2026-03-02 whose `sourceName="Scale &amp; Co"`.
- One BP pair:
  - top-level systolic 120 and diastolic 80, same start, `mmHg`;
  - a `<Correlation type="HKCorrelationTypeIdentifierBloodPressure">` wrapping copies of both.
- One `<Workout>` wrapping a HeartRate copy.
- SleepAnalysis for the night ending 2026-03-02:
  - InBed 22:30–06:30;
  - AsleepCore 23:00–02:00 from Watch;
  - AsleepDeep 02:00–03:00 from Watch;
  - AsleepUnspecified 23:30–01:00 from iPhone, which overlaps the Watch intervals.
- ActivitySummary rows for 2026-03-01 (non-zero) and 2020-11-05 (all zero, goals zero apart from exercise/stand defaults, as in the real file).
- A `<ClinicalRecord>` line for each JSON file (sourceURL `https://fhir.example.org/R4/Patient/p1` etc.).

- [ ] **Step 1: Write failing tests.**
  - `appleDate` converts `'2017-11-03 10:13:05 -0500'` → `'2017-11-03T10:13:05-05:00'`, and `'+0900'` → `'+09:00'`.
  - `isAppleHealthExport(fixtureDir)` is true. `isAppleHealthExport('tests/fixtures/ehi')` is false.
  - `readExport` on the fixture:
    - returns `exportDate: '2026-11-05T13:39:52-05:00'`;
    - delivers each top-level Record exactly once (count by type: HeartRate 3, BloodPressureSystolic 1);
    - reports `nested` = the count of Records inside Correlation/Workout (3);
    - delivers the 2 summaries and 2 clinical refs;
    - decodes the scale source as `'Scale & Co'`.
- [ ] **Step 2: Run `npm test -- tests/apple-read.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `readline` over `createReadStream`, and match start tags by regex.
  - Attributes come from `/(\w+)="([^"]*)"/g`, decoding `&amp; &lt; &gt; &quot; &apos; &#N; &#xH;`.
  - Track `<Correlation`/`<Workout` open and close lines. Records between them are counted in `nested` and not delivered.
  - Throw `GaError('not an Apple Health export: <dir>')` when there is no ExportDate.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: streaming Apple Health export reader`

---

### Task 3: Per-reading Observations and blood pressure pairs

**Files:**
- Create: `src/apple/readings.ts`
- Test: `tests/apple-map.test.ts`

**Interfaces:**
- Consumes: `AhRecord`, `APPLE`
- Produces:
  ```ts
  export const READINGS: Record<string, { text: string; loinc?: string; ucum: string; category: 'vital-signs' | 'activity'; scale?: number }>;
  export class Readings { add(r: AhRecord): boolean /* false if type not in READINGS or a BP half */; bp(r: AhRecord): void; result(): { resources: Observation[]; skips: { sameReadingTwoSources: number; bpUnpaired: number } } }
  ```

**The `READINGS` table.** Keys are HK type ids. `scale` converts Apple fractions to percent.

| HK type | text | LOINC | UCUM | category |
|---|---|---|---|---|
| BodyMass | Body weight | 29463-7 | kg | vital-signs |
| BodyMassIndex | BMI | 39156-5 | kg/m2 | vital-signs |
| Height | Body height | 8302-2 | cm (Apple `m` × 100, `cm` as is) | vital-signs |
| BodyFatPercentage | Body fat percentage | 41982-0 | % (scale 100) | vital-signs |
| OxygenSaturation | Oxygen saturation (pulse oximetry) | 59408-5 | % (scale 100) | vital-signs |
| RestingHeartRate | Resting heart rate | 40443-4 | /min | vital-signs |
| LeanBodyMass | Lean body mass | — | kg | vital-signs |
| WalkingHeartRateAverage | Walking heart rate average | — | /min | vital-signs |
| HeartRateRecoveryOneMinute | Heart rate recovery, 1 minute | — | /min | activity |
| SixMinuteWalkTestDistance | Six-minute walk distance (estimated) | — | m | activity |
| AppleWalkingSteadiness | Walking steadiness | — | % (scale 100) | activity |
| AppleSleepingWristTemperature | Sleeping wrist temperature | — | Cel | vital-signs |
| AppleSleepingBreathingDisturbances | Sleeping breathing disturbances | — | /h | vital-signs |
| HighHeartRateEvent / LowCardioFitnessEvent (category records) | High heart rate notification / Low cardio fitness notification | — | none (`valueString` = HK category value) | vital-signs |

Weight stored in `lb` is converted to kg (×0.45359237, rounded to 0.01). **[check]** Before the real run, check the units the real file uses per type, printing unit counts only. Also check Epic's units for weight and BMI in GA (`fhir_search Observation code=29463-7`) and match the UCUM `code`.

**Shape of each reading:**
- `status: 'final'`
- `category`
- `code: {coding?: [{system: 'http://loinc.org', code}], text}`
- `subject: Patient/apple-patient`
- `effectiveDateTime` = start when start = end, else `effectivePeriod`
- `valueQuantity: {value, unit, system: 'http://unitsofmeasure.org', code}`
- `device: {display: sourceName}`
- `identifier: [{system: APPLE, value: sha256(type|start|end|value|unit)}]`

The source is left out of the key on purpose. A device rename must not create new records (Review Focus 2). Two sources with an identical reading become one record, counted as `sameReadingTwoSources`.

**Blood pressure.** Pair top-level `BloodPressureSystolic` and `BloodPressureDiastolic` records with the same `startDate` and `sourceName`. Each pair becomes one Observation:
- LOINC 85354-9 "Blood pressure panel";
- components 8480-6 and 8462-4 in `mm[Hg]`;
- key `sha256('BP'|start|end|sys|dia)`.

An unpaired half is counted in `bpUnpaired` and dropped.

- [ ] **Step 1: Write failing tests.** Feed synthetic `AhRecord`s directly.
  - BodyMass 79 kg → LOINC 29463-7, `valueQuantity {value: 79, code: 'kg'}`, `device.display` = source, and identifier system `APPLE` with a 64-hex value.
  - The same reading under two source names gives 1 resource and `sameReadingTwoSources: 1`.
  - Renaming the source keeps the identifier unchanged.
  - BodyFatPercentage `0.21` → `21` with code `%`.
  - A sys/dia pair → 1 panel with components 120/80. A lone systolic → `bpUnpaired: 1`.
  - An unknown type returns `add() === false`.
- [ ] **Step 2: Run `npm test -- tests/apple-map.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Apple Health per-reading vitals and BP pairs`

---

### Task 4: Daily summaries and nightly sleep

**Files:**
- Create: `src/apple/daily.ts`
- Test: `tests/apple-map.test.ts` (add to it)

**Interfaces:**
- Consumes: `AhRecord`, `AhSummary`, `APPLE`
- Produces:
  ```ts
  export class Daily { add(r: AhRecord): boolean; summary(s: AhSummary): void; result(): { resources: Observation[]; skips: { activityEmptyDays: number } } }
  ```

**Daily kinds.** Each output is one Observation per (kind, local day). Identifier `sha256('daily'|kind|day)`. `effectivePeriod` runs `{day}T00:00:00{offset}` → next day, using the offset of that day's first record. `category: activity`. `subject` as in Task 3; no `device` (a day mixes sources). `code.text` as listed below, coding only for steps.
- **Rates (mean, plus components min, max and sample count):**
  - HeartRate → "Heart rate, daily mean (Apple Health)" `/min`
  - HeartRateVariabilitySDNN → "Heart rate variability SDNN, daily mean (Apple Health)" `ms`
  - RespiratoryRate → "Respiratory rate, daily mean (Apple Health)" `/min`
  - The mean is rounded to 1 decimal.
- **Totals.** Per day, sum per `sourceName` and take the largest source total:
  - StepCount → LOINC 41950-7 "Steps, daily total (Apple Health)" `{steps}`
  - DistanceWalkingRunning → "Walking + running distance, daily total" `km` (convert `mi`)
  - DistanceCycling → same pattern
  - FlightsClimbed → "Flights climbed, daily total" `{flights}`
  - Put `// shortcut: largest single source per day approximates Apple's source-priority merge; upgrade to interval merge if totals look wrong` on it.
- **ActivitySummary.** One Observation per `dateComponents` day, `code.text` "Activity rings, daily (Apple Health)", with components:
  - active energy (`kcal`)
  - exercise minutes (`min`)
  - stand hours (`h`)

  A day with all values 0 and active-energy goal 0 is skipped as `activityEmptyDays`.
- **Sleep.** Key by wake date, the local day of the latest asleep end in a cluster.
  - A night = asleep intervals (`HKCategoryValueSleepAnalysisAsleep*`) chained with gaps under 3 h, across all sources.
  - Merge overlapping intervals.
  - `valueQuantity` = total asleep minutes.
  - Components: minutes per stage (core, deep, REM, unspecified, from the dominant source where stages overlap), and in-bed minutes (InBed intervals merged, in the same cluster window).
  - `code.text` "Sleep, nightly (Apple Health)", `effectivePeriod` = cluster start → end.

- [ ] **Step 1: Write failing tests.**
  - 3 HeartRates 60/80/100 → mean 80, min 60, max 100, count 3, `effectivePeriod.start` `2026-03-01T00:00:00-05:00`, and no `coding`.
  - Steps (Watch 4,000 + 3,000, iPhone 5,000) → 7,000, coded 41950-7.
  - Records in two offsets on one local day still make one day.
  - Fixture sleep → asleep 240 min (23:00–03:00 merged), deep 60, in bed 480, keyed to 2026-03-02.
  - ActivitySummary: the zero day is skipped (`activityEmptyDays: 1`) and the other day has 3 components.
  - Two calls on the same input give identical identifiers.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep only running sums per (kind, day, source), never the raw samples, apart from sleep intervals (3k rows).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Apple Health daily summaries and nightly sleep`

---

### Task 5: Hospital records and the ECG

**Files:**
- Create: `src/apple/clinical.ts`
- Test: `tests/apple-map.test.ts` (add to it)

**Interfaces:**
- Consumes: `AhClinical`, `APPLE`
- Produces:
  ```ts
  export function mapClinical(dir: string, refs: AhClinical[]): { resources: Resource[]; skips: { clinicalTypeUnsupported: number } };
  export function mapEcgs(dir: string): Resource[]; // per CSV: one DocumentReference + one Observation
  ```

**Clinical records:**
- **Patient** (any FHIR version) → `{resourceType: 'Patient', id: 'apple-patient', identifier}`, with identifiers only, so the engine absorbs them and fills demographics only where missing.
- **R4 AllergyIntolerance:**
  - Drop `id`.
  - Set `patient` to `Patient/apple-patient`.
  - Replace every other `reference` with its `display` only.
  - Prepend `{system: APPLE, value: sourceURL}` to `identifier`.
- **Anything else,** or non-R4 non-Patient records → `clinicalTypeUnsupported++`. They stay in the archive.

**ECG** (`electrocardiograms/*.csv`). Read header rows until the first empty line and use only these keys: `Recorded Date`, `Classification`, `Symptoms`, `Sample Rate`, `Lead`, `Unit`. Never copy `Name` or `Date of Birth` into structured fields.
- **DocumentReference:**
  - `status: current`
  - `type.text` "Apple Watch ECG"
  - `date` = recorded
  - `content[0].attachment` = `{contentType: 'text/plain; charset=utf-8', data: base64(file), title: basename}`. Inline, so `fhir_read` shows the text.
  - identifier `{APPLE, sha256('ecg'|file contents)}`
- **Observation:**
  - `code.text` "Apple Watch ECG classification"
  - `valueString` = Classification
  - `effectiveDateTime` = recorded
  - `derivedFrom` the DocumentReference by `id` (`'apple-ecg-<n>'`), which the engine's topo sort resolves
  - identifier `{APPLE, sha256('ecg-class'|recorded)}`
  - a `note` with the symptoms when present

- [ ] **Step 1: Write failing tests on the fixtures.**
  - Patient → identifiers only, with the patient id `apple-patient`.
  - Allergy:
    - `patient` is the apple patient;
    - `recorder` has no `reference`;
    - first identifier is `{APPLE, 'https://fhir.example.org/R4/AllergyIntolerance/a1'}`.
  - A DSTU2 non-Patient ref → `clinicalTypeUnsupported: 1`.
  - ECG:
    - `valueString` `'Sinus Rhythm'` and `effectiveDateTime` `'2024-02-11T14:48:35-05:00'`;
    - the attachment decodes back to the CSV;
    - the JSON of the Observation contains no fixture name or birth date.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: Apple Health clinical records and ECG`

---

### Task 6: Importer, archive, CLI and docs

**Files:**
- Create: `src/archive.ts` (moved from `src/ehi/import.ts`: `manifestHash`, `archive`)
- Modify: `src/ehi/import.ts` (use `archiveFolder(client, dir, patientId, 'urn:ga-server:id:ehi-archive')`)
- Create: `src/apple/import.ts`
- Modify: `src/cli.ts` (Apple branch before the C-CDA fallback)
- Modify: `AGENTS.md`, `.claude/skills/ga/SKILL.md`, `README.md` (import list)
- Test: `tests/integration/apple.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```ts
  // src/archive.ts
  export async function archiveFolder(client: MedplumClient, dir: string, patientId: string, system: string): Promise<'stored' | 'already-present'>;
  // src/apple/import.ts
  export async function importAppleHealth(client: MedplumClient, cfg: GaConfig, dir: string, patientId = cfg.patientId):
    Promise<ImportReport & { archived: 'stored' | 'already-present'; unchanged: number; seconds: number; skips: Record<string, number> }>;
  ```

**Importer flow:**
1. `archiveFolder(…, 'urn:ga-server:id:apple-health-archive')`. Keep the existing temp-dir and tar rules.
2. `readExport` feeds `Readings`, `Daily` (a record that neither takes is counted per HK type under `skips.archiveOnly.<type>`) and the clinical refs.
3. Add `mapClinical` and `mapEcgs`, plus `{resourceType:'Patient', id:'apple-patient'}`.
4. **Unchanged filter.**
   - Fetch every existing Observation/DocumentReference/AllergyIntolerance for the patient tagged `_tag=urn:ga-server:tag|src-apple-health`, using `client.searchResourcePages` with `_count=1000` and `_elements` limited to identifier, code, value*, component, effective*.
   - **[check]** Medplum's maximum search offset. If paging stops early, page by `_lastUpdated` windows instead, and assert the fetched count equals `Observation?_summary=count&_tag=…`.
   - Drop an incoming resource when an existing one has its first identifier and the same projection, i.e. equal JSON of `{code, valueQuantity, valueString, component, effectiveDateTime, effectivePeriod}`. Count it in `unchanged`.
5. `importResources(client, rest, {kind:'apple-health', file: dir, date: exportDate, writer:'importer'}, patientId, '')`.

Report wall-clock `seconds`.

**CLI.** `else if (isAppleHealthExport(file))` comes after the EHI branch and before the C-CDA fallback. It takes no extra args: anything after the path is `GaError('usage: ga import <apple-health-folder>')`. If `file` ends in `.zip`, throw `GaError('unzip export.zip first, then: ga import <folder>')`. A zip reader isn't worth a dependency.

**Docs.**
- `AGENTS.md`: a "## Apple Health data" section, which the `/ga` skill references:
  - system `urn:ga-server:id:apple-health`, tag `src-apple-health`;
  - per-reading vitals are measurements;
  - "daily mean/total" records are summaries (largest single source per day for steps and distance);
  - sleep is nightly;
  - a home and a clinic reading on one day are both real;
  - Health Records inside the export are hospital copies;
  - the ECG is a text DocumentReference.
- `/ga` skill: one line pointing there.
- `README.md`: add Apple Health to the import list, with `ga import <unzipped apple_health_export folder>`.

- [ ] **Step 1: Write failing integration tests.** Copy `tests/fixtures/apple` to a temp dir and use `createTestPatient`/`cleanupTestPatient`.
  - `first import`:
    - `created` > 0, `possibleDuplicates: 0`, `archived: 'stored'`;
    - the test patient gains the fixture Patient's identifiers;
    - the allergy exists with the Apple identifier.
  - `re-import is a no-op`: the second report has `created: 0, updated: 0` and `archived: 'already-present'`, with `unchanged` equal to the first run's created count.
  - `renamed source creates nothing`:
    - Rewrite `Test Watch` → `Renamed Watch` in the temp copy's `export.xml`.
    - Assert `created === 0`.
  - `newer export updates a partial day`:
    - Append one HeartRate (120) on 2026-03-01 and bump `ExportDate` by a day.
    - Expect `updated >= 1`.
    - The daily heart-rate record now has max 120, and its identifier is unchanged.
  - `cli routes apple folders`: `isAppleHealthExport` is checked before C-CDA. Assert `importPath` is not reached by spying, or assert that running `node src/cli.ts import <tmp> extra` exits 1 with the Apple usage message.
  - Existing EHI integration tests still pass after the archive move.
- [ ] **Step 2: Run `npm run test:int -- tests/integration/apple.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the archive move, the importer, the CLI and the docs.**
- [ ] **Step 4: Run `npm test && npm run test:int && npm run typecheck`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat: ga import for Apple Health exports`

---

### Task 7: Real-data run and acceptance

**Files:**
- Modify: `tests/integration/real-data.test.ts` (add an Apple block, skipped unless `GA_REAL_DATA_APPLE` is set)

**Interfaces:** Consumes `importAppleHealth`.

- [ ] **Step 1: Write the test.** Run on a **test patient**, never the real one.
  - **Run 1:**
    - print counts per HK type, skips, `seconds`, the report and the archived state;
    - assert `possibleDuplicates === 0` and `seconds < 1800`.
  - **Run 2:** assert `created === 0 && updated === 0` and `seconds < 180`.
  - **Archive:** assert the archive's Binary size is > 100 MB and unpacks to the same file count and total size as the folder.
  - **Clean up** the test patient.
- [ ] **Step 2: Run `GA_REAL_DATA_APPLE=/path/to/export npm run test:int -- tests/integration/real-data.test.ts`.**
  - If the archive upload fails on size, fix the configuration, not the test. Raise the limit in `compose.yaml`, or split the upload into several Binaries on one DocumentReference. Pick the smaller change and keep the `shortcut:` comment honest.
  - If time targets fail, batch creates (Medplum batch Bundle under `MEDPLUM_MAX_BATCH_SIZE`). Report the measured times either way.
- [ ] **Step 3: Step-total check.** Print the computed daily steps for the dates the user supplied (dates and numbers only) next to the user's Health-app numbers. A difference over 5% means the shortcut needs the interval merge: stop and report.
- [ ] **Step 4: Import into the real patient** with `node src/cli.ts import <export>`, twice. The second report must be `created:0 updated:0`.
- [ ] **Step 5: Hand to the user** for acceptance #6: `/ga How have my weight and resting heart rate changed since 2022, and how does that line up with my A1c?`
- [ ] **Step 6: Commit** `test: Apple Health real-data acceptance`
