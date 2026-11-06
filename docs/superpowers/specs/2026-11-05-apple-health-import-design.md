# GA Milestone 2b: Apple Health Export Import — Design

Builds on `2026-11-05-ga-server-design.md` (milestone 1) and `2026-11-06-ehi-import-design.md` (milestone 2a), both shipped. Legend: **[user]** decided by the user, **[call]** designer's call (open to override), **[check]** unverified fact the builder confirms first. The user skipped the design questions, so everything not carried from earlier specs is a **[call]**.

## Intent

"All of my health data that exists on earth in one place, no matter where it is or what format it is." **[user]** The hospital records in GA hold one weight or heart rate per clinic visit. Apple Health holds what happens between visits: years of weight, resting heart rate, heart rate variability, sleep, steps and exercise from the user's iPhone, Watch and scale. This milestone brings the clinically useful part of the Apple Health export into GA. The rest is kept in an archive, and nothing is duplicated.

**Success test [call]:** in Claude Code, `/ga How have my weight and resting heart rate changed since 2022, and how does that line up with my A1c?` gets a cited answer. The answer combines daily Apple Health data (weight, resting heart rate) with the hospital A1c results already in GA.

## Goals, non-goals, anti-goals

**Goals**
- The whole export is kept: it is archived as one document linked to the patient, as with EHI. **[user: nothing lost]**
- Clinically useful measurements become searchable FHIR Observations at a size agents can read. Sparse measurements are stored one per reading; high-frequency streams become one record per day (see "Mapping").
- The hospital FHIR records inside the export (`clinical-records/`) go through the same dedup as other hospital data.
- Re-importing the same export changes nothing. Importing a newer export adds new data and updates only the days that changed.
- Import time on the real export: under 30 minutes the first time, under 3 minutes for a re-import. **[call]**

**Non-goals (this milestone)**
- An iOS app or live HealthKit sync. This milestone covers exported files only. **[user, milestone 1]**
- Workouts (14,236 rows), GPX workout routes (909 files), `export_cda.xml` (Apple's CDA copy of the same data) and the low-value types listed under "Archive only". These are kept in the archive and not mapped.
- Charts. The agent answers questions, and a chart skill like `/ga-lipids` can come later.

**Anti-goals** (carried from earlier milestones)
- No silent merges.
- No PHI in the repo. Fixtures are synthetic. Real-data checks print counts only, since source and device names contain the user's name.
- Nothing leaves the machine.
- No invented codes: use LOINC only when confident, otherwise `code.text`.
- **[call] Apple samples don't trigger false "possible-duplicate" flags.** Two scale weights on one day, or a home weight on a clinic day, are separate measurements. See "Dedup".

## What's in the export (recon of the user's file, counts only)

The export is `<apple-health-export>/` (2.8 GB unpacked, ~155 MB as tar.gz). It contains:
- `export.xml` (2.07 GB, HealthKit export version 17, ExportDate 2026-11-05 13:39:52 -0500)
- `export_cda.xml` (546 MB)
- `clinical-records/` (3 FHIR JSON files)
- `electrocardiograms/` (1 CSV)
- `workout-routes/` (909 GPX)

Records span 2011–2026, about 6 million in total.

| Type (HK…Identifier) | Rows | Handling |
|---|---|---|
| HeartRate | 440,797 | daily |
| HeartRateVariabilitySDNN | 10,493 | daily |
| RespiratoryRate | 3,054 | daily |
| StepCount / DistanceWalkingRunning / DistanceCycling / FlightsClimbed | 449,930 / 588,988 / 1,582 / 53,691 | daily total |
| ActivitySummary (Apple's own daily move/exercise/stand totals) | 2,192 | daily |
| SleepAnalysis (category) | 3,030 | nightly |
| BodyMass / BodyMassIndex / BodyFatPercentage / LeanBodyMass / Height | 3,204 / 3,211 / 3,151 / 709 / 3 | per reading |
| RestingHeartRate / WalkingHeartRateAverage | 1,513 / 1,612 | per reading (Apple already makes these daily) |
| BloodPressure correlation (+ 14 systolic / 14 diastolic top-level) | 6 | per reading |
| OxygenSaturation | 1 | per reading |
| HeartRateRecoveryOneMinute / SixMinuteWalkTestDistance / AppleWalkingSteadiness | 270 / 257 / 266 | per reading |
| AppleSleepingWristTemperature / AppleSleepingBreathingDisturbances | 65 / 65 | per reading |
| HighHeartRateEvent / LowCardioFitnessEvent | 3 / 4 | per reading |
| ClinicalRecord: Patient (a second Epic hospital R4, a lab company DSTU2), AllergyIntolerance (second hospital R4, "No Known Allergies") | 3 | engine (hospital data) |
| ECG (`electrocardiograms/*.csv`) | 1 | document + classification Observation |
| ActiveEnergyBurned, BasalEnergyBurned, PhysicalEffort, AppleExerciseTime, AppleStandTime/Hour, audio exposure (3 types), walking/stair gait metrics (6 types), HandwashingEvent, TimeInDaylight, EnvironmentalSoundReduction, MindfulSession, Menstrual/Sexual/Contraceptive, effort scores, SleepDurationGoal, Workout, ActivitySummary goals | rest | archive only. Active energy, exercise and stand come from ActivitySummary instead. |

Two points from recon:
- The Epic Patient here is from a different Epic organization than the one GA holds. Apple Health is the first link to that hospital, which matters for milestone 3 (SMART pull).
- The DTD notes that records inside a `Correlation` or `Workout` also appear at the top level. Read each record once.

## Mapping [call; builder may refine]

**Identifier system:** `urn:ga-server:id:apple-health`. `SourceInfo.kind` gains `apple-health`. The source date for every resource is the export's `ExportDate`.

- **Per-reading Observation.** Category `vital-signs` for vitals, otherwise `activity`.
  - `effectiveDateTime` = `startDate`, or `effectivePeriod` when start ≠ end. Keep the record's own UTC offset.
  - `valueQuantity` with UCUM units.
  - Identifier value: sha256 of `<HKtype>|<startDate>|<endDate>|<sourceName>`. Value is excluded because Apple samples are immutable. Hashing is required: source names contain the user's name, and identifiers will be exposed by milestone-4 sharing.
  - **[check]** Whether renaming a device rewrites `sourceName` on old samples in a later export. If it does, every past reading would get a new identifier and silently duplicate, which matters most for `code.text`-only readings. Test: re-import a synthetic export with the source renamed and expect zero creates. If Apple's behaviour can't be confirmed, key on type, start, end, value and unit without the source.
  - The source and device name is recorded on the Observation, e.g. `device.display` or `method.text`, so the agent can tell scale from Watch. Builder's choice.
- **Blood pressure:** one Observation per pair. LOINC 85354-9 panel with components 8480-6 and 8462-4. Pair top-level systolic and diastolic records with the same start time and source. Correlations exist for 6 of the 14 pairs.
- **Daily Observation.** Identifier value: `<HKtype>|<YYYY-MM-DD>`.
  - The day is the local date in each record's own offset.
  - `effectivePeriod` covers that day.
  - Rates (heart rate, HRV, respiratory rate): `valueQuantity` = mean, plus components for min, max and sample count.
  - Cumulative types: `valueQuantity` = daily total.
  - **Overlap rule [call]:** steps and distance are recorded by both iPhone and Watch, so summing every source double-counts. Per day, take the single source with the largest total. Mark this `shortcut: approximates Apple's source-priority merge; upgrade to interval merge if totals look wrong`. **[check]** On real data, compare daily step totals against a few days the user can read in the Health app. Ask the user for those numbers.
  - ActivitySummary gives active energy, exercise minutes and stand hours as reported. Days with all-zero values and zero goals are skipped and counted.
- **Nightly sleep.** One Observation per night with asleep minutes and the stage breakdown (core, deep, REM) as components.
  - The night is dated by its wake-up date.
  - Use only asleep stages and merge overlapping intervals across sources. In-bed time is a separate component.
- **Codes.** LOINC only where the meaning matches, and only on per-reading records, for example:
  - 29463-7 weight
  - 39156-5 BMI
  - 8302-2 height
  - 41982-0 body fat %
  - 40443-4 resting heart rate
  - 59408-5 SpO2 by pulse oximetry

  Daily summaries get `code.text` only, for example "Heart rate, daily mean (Apple Health)". A single-reading code such as 8867-4 heart rate on a daily mean would make agents read it as a measurement. The exception is codes that already mean a 24-hour total, such as 41950-7 steps per 24 h. Readings with no confident code also use `code.text`, with the HK type name in readable form. **[check]** Every LOINC/UCUM pair. GA already holds weight and BMI from Epic, so match the codes and units Epic uses where they agree; `/ga-lipids` and agents compare across sources.
- **ECG.** The CSV is stored as a DocumentReference, as text so `fhir_read` shows it. Add one Observation `code.text` "Apple Watch ECG classification" with the header's classification and average heart rate.
- **Clinical records.** Convert the DSTU2 lab-company Patient only as far as identifiers. Patients collapse into the GA Patient (identifiers absorbed, demographics fill-only), as today. The R4 AllergyIntolerance goes through the engine with identifier `urn:ga-server:id:apple-health|<sourceURL>`.
- **Archive.** The whole export folder becomes a tar.gz DocumentReference stored once by file hash, as with EHI. The existing EHI shortcut uploads one Binary and notes "upgrade to chunks if exports reach GBs". This one is ~155 MB. **[check]** Whether Medplum (as configured in compose) accepts a 155 MB Binary. If it doesn't, raise the limit in compose or split the upload into several Binaries on one DocumentReference. Pick the smaller change.

## Dedup [call]

- **Stable identifiers make re-import a no-op.** A newer export reproduces the same identifiers for all past readings. Daily records for a day that gained data (the export day itself, late sync) are updated because the source is newer. An older export imported after a newer one is skipped, per the existing `decide` rule.
- **Apple readings never take part in the engine's day-level "possible-duplicate" flag, in either direction.** A same-code, same-day match with another reading is not evidence of a copy.
  - In the engine, drop any candidate that carries an `urn:ga-server:id:apple-health` identifier from the day-level match list.
  - Skip the day-level match when the incoming record is from Apple.
  - Either way, a hospital vital imported later (newer Epic export, C-CDA, the milestone-3 SMART pull) on the same day as an Apple reading is not flagged.
  - The existing exact-time + same-value merge still applies. That is the one case where an Apple reading may genuinely be a copy, for example a clinic BP the user typed in at the same minute.
  - Tests cover both directions, including an Epic weight imported after an Apple weight on the same day.
- **Hospital clinical records** use the engine as they are. Epic-ID linking applies to the second hospital records, though GA has none from that hospital yet.
- **Speed.** About 35,000 resources are expected. Per-resource search plus create may miss the time targets. The builder may prefetch the existing `apple-health` identifiers once and skip known ones, and/or write in batches. Measure on the real export and report the counts and timings.

## Interfaces

- **CLI:** `ga import <folder>` detects an Apple Health export by `export.xml` with an `<!DOCTYPE HealthData`. Detection must run before the C-CDA path: `src/ccda.ts` treats any other folder as C-CDA and walks every `*.xml` file in it recursively, so it would send the 2 GB `export.xml` and the 546 MB `export_cda.xml` to the converter. It also accepts the `export.zip` the iPhone produces, if this costs only a few lines; otherwise skip it and say so. The report gives counts per type, the daily days written and the skips with reasons.
- **Parsing:** stream `export.xml`. Never load 2 GB into memory. Apple writes one element per line, so a line reader over start tags (no new dependency) is acceptable with a test on a synthetic export. Use a widely used SAX parser instead if multi-line elements break that.
- **MCP:** no new tool; `fhir_search` covers these records. Update `AGENTS.md` and the `/ga` skill with:
  - where Apple data lives (system `urn:ga-server:id:apple-health`);
  - that daily records are summaries (mean/min/max, or totals with the overlap rule);
  - that a home reading and a clinic reading on the same day are both real;
  - that Apple Health "Health Records" are hospital copies.

## Acceptance

1. Import the real export twice. The second run reports `created:0 updated:0`, and one Patient remains, now with the second hospital and lab-company identifiers.
2. Per-type counts (counts only) match the export, minus documented skips. Every skip is counted with a reason. Daily records number one per type per day that has data.
3. No `possible-duplicate` tags are added by the import, in either direction between Apple and hospital records.
4. The archive DocumentReference exists. Its Binary unpacks to the original folder: compare file count and total size.
5. Unit tests on a synthetic export cover the following, plus timing on real data against the targets:
   - parsing, including multi-day and offset handling;
   - BP pairing;
   - daily aggregation and the overlap rule;
   - sleep interval merge;
   - ECG header;
   - the dedup flag change.
6. `/ga How have my weight and resting heart rate changed since 2022, and how does that line up with my A1c?` answers with cited Apple and hospital records. The user checks this manually.

## Left to the builder

- Exact FHIR shapes, components and code text, within the mapping above.
- File layout. Follow `src/ehi/` conventions, e.g. `src/apple/`.
- How to batch writes, and the parser choice per the constraint above.
