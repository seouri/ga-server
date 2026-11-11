# Dataset Folder Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import every dataset of a personal health dataset folder into GA: an Epic FHIR export file, a DICOM study, TIFF scans, and a structured rebuild of the personalrecord app's flattened bundle, alongside the Apple Health export and scanned PDFs GA already handles.

**Architecture:** Task 0 (serial, small) adds two import kinds (`fhir-export`, `dicom`) to every shared switch (detectKind, SourceInfo, currency rule, engine, whats-new, CLI) and leaves stub importers. Then five code chunks run fully in parallel, each owning its own files: A fills `src/fhir-export/`, B fills `src/dicom/`, C widens `ga_import` to TIFF, D is a standalone tool, kept in the dataset folder (`derived/ga-rebuild/<date>/tool/`, moved there after it was built), whose output is A's input format, E makes the Apple importer import every R4 clinical record, identified like a portal sync. One data run (scanned PDFs and PNGs) needs no code and can start at once. Task Z (serial, last) runs the remaining imports in order, writes AGENTS.md and checks the totals.

**Tech Stack:** Node ≥26 TypeScript (run directly), Medplum client, vitest (`unit` and `integration` projects).

**Spec:** `docs/superpowers/specs/2026-11-10-dataset-folder-import-design.md`

## Global Constraints

- The dataset path is always an argument. No code, test, fixture, doc or commit message names the person or quotes their clinical content; fixtures are synthetic.
- No new npm dependency.
- MGB FHIR base for runs: `https://ws-interconnect-fhir.partners.org/Interconnect-FHIR-MU-PRD/api/FHIR/R4/`.
- Identifiers from `fhir-export`: `urn:ga-server:id:smart:<sourceKey(fhirBase)>` | `<Type>/<id>` (identical to a portal sync).
- New tags: `src-fhir-export`, `src-dicom`. New identifier systems: `urn:dicom:uid`, `urn:ga-server:id:dicom-archive`.
- Errors that may reach a user never quote file content (GA's existing rule).
- The rebuild tool (in the dataset's `derived/ga-rebuild/<date>/tool/`) imports only `node:*` and `@medplum/fhirtypes` (types), never `src/`.
- AGENTS.md is edited only by Task C (its "PDF extraction" section, which mirrors `extract.md`) and Task Z (everything else).

## Parallelism

| Phase | Tasks | May run in parallel with |
|---|---|---|
| 1 | Task 0 | R2 |
| 2 | A, B, C, D, E | each other, R2 |
| 3 | Z | nothing |

File ownership (no file is in two tasks of phase 2):
- A: `src/fhir-export/*`, `src/smart/fetch.ts` (export `htmlToText`, DiagnosticReport `presentedForm` conversion in `mapForGa`), `src/smart/sync.ts` (export `uploadBinaries`), `tests/smart-fetch.test.ts`, `tests/fhir-export*.test.ts`, `tests/integration/fhir-export.test.ts`, `tests/fixtures/fhir-export/*`, `docs/fhir-export.md`.
- B: `src/dicom/*`, `src/share/scope.ts` (`NEVER_DOCS`), `tests/dicom*.test.ts`, `tests/integration/dicom.test.ts`, `tests/fixtures/dicom/*`, `docs/dicom.md`.
- C: `src/mcp.ts` (`TYPES`), `src/tools/imports.ts`, `src/llm.ts`, `.claude/skills/ga-import/extract.md`, `.claude/skills/ga-import/SKILL.md`, AGENTS.md "PDF extraction" section, `tests/mcp-tools.test.ts`, `tests/tools-imports.test.ts`, `tests/llm.test.ts`.
- D: the rebuild tool (built in `tools/personalrecord/**`, then moved into the dataset's `derived/ga-rebuild/<date>/tool/`).
- E: `src/apple/clinical.ts`, `src/apple/read.ts`, `src/apple/import.ts`, `tests/apple-map.test.ts`, `tests/apple-read.test.ts`, `tests/integration/apple-clinical.test.ts`, `tests/fixtures/apple/clinical/*`.
- E reads `mapForGa` and `sourceKey` but does not change them; A's `presentedForm` change reaches Apple copies after the merge with no interface change.

## Review Focus

1. A later `ga connect` + `ga sync` of the same MGB server must link to the file-imported records, not duplicate them → Task A, test `file import and portal sync give the same identifier`.
2. Importing the same export file twice must change nothing → Task A integration test `re-import is a no-op`.
3. A resource copy that adds only a `note` (the annotation copy from D) must update the stored record and keep the note → Task A integration test `an added note updates the record`.
4. DICOM folders contain non-DICOM files (DICOMDIR, Preview.jpg, `.DS_Store`) and may use implicit VR or undefined-length sequences; none may stop the import → Task B tests `skips non-DICOM files`, `reads implicit VR`, `skips undefined-length sequences`.
5. An attachment whose resource or path is missing must be counted, not crash → Task A test `unplaced attachment is counted`.
6. An Apple export imported before or after the hospital's own records must leave one record per hospital id, with the hospital's content → Task E integration tests `Apple then hospital` and `hospital then Apple`.
7. A person who imported an older Apple export (allergy identified by `sourceURL` only) must not get a second allergy → Task E integration test `old Apple allergy gains the new identifier`.

---

### Task 0: Foundation: two new import kinds wired through shared code

**Files:**
- Modify: `src/import.ts` (ImportKind, detectKind, importAny, export `DOCUMENT_EXT`)
- Modify: `src/identity.ts:5-15` (SourceInfo.kind), `:99-105` (OWN_ID), `:32` (isClinic)
- Modify: `src/current.ts:12` (EPIC_TAGS)
- Modify: `src/engine.ts:124-126` (fillFrom kinds), `:679` (storeNewestImport kinds)
- Modify: `src/whats-new.ts:18` (SOURCES)
- Modify: `src/cli.ts:16-47` (import argument parsing)
- Modify: `vitest.config.ts` (unit include)
- Create: `src/fhir-export/import.ts`, `src/dicom/import.ts` (stubs)
- Test: `tests/import.test.ts`, `tests/identity.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces:
  - `type ImportKind = 'pdf' | 'ehi' | 'apple' | 'ccda' | 'fhir-export' | 'dicom'`
  - `export const DOCUMENT_EXT = /\.(pdf|png|jpe?g|tiff?)$/i` in `src/import.ts`; `detectKind` and `cli.ts` use it in place of their literal regexes.
  - `importAny(client, cfg, path, opts: { tz?: string; fhirBase?: string } & BatchOpts)`
  - `src/fhir-export/import.ts`: `export async function importFhirExport(client: MedplumClient, cfg: GaConfig, path: string, patientId: string, opts: { fhirBase: string } & BatchOpts): Promise<FhirExportReport>` and `export type FhirExportReport = ImportReport & { skippedTypes: Record<string, number>; attachmentsUnplaced: number }`. Stub body: `throw new GaError('fhir-export import not implemented yet')`.
  - `src/dicom/import.ts`: `export async function importDicom(client: MedplumClient, cfg: GaConfig, dir: string, patientId: string): Promise<DicomReport>` and `export type DicomReport = ImportReport & { studies: number; series: number; instances: number; documents: number; skipped: number; unsupported: number; archive: 'stored' | 'already-present' }`. Stub body throws `GaError('dicom import not implemented yet')`.
  - `SourceInfo.kind` gains `'fhir-export' | 'dicom'`; `OWN_ID['fhir-export'] = { name: 'FHIR export', ok: (x) => x.startsWith('urn:ga-server:id:smart:') }`; `OWN_ID.dicom = { name: 'DICOM', ok: (x) => x === 'urn:dicom:uid' }`.
  - Tags `src-fhir-export` (in `isClinic`, `EPIC_TAGS`, whats-new `SOURCES` as `'Epic FHIR export'`) and `src-dicom` (in `isClinic`, whats-new as `'DICOM imaging'`).
  - `fillFrom` applies for kinds `ehi`, `smart`, `fhir-export`, `apple-health`; `storeNewestImport` runs for `ccda`, `ehi`, `fhir-export`.
  - `OWN_ID['apple-health'].ok` accepts `x === APPLE || x.startsWith('urn:ga-server:id:smart:')` (Apple clinical copies lead with the hospital's smart identifier, Task E).

- [ ] **Step 1: Write the failing tests**

`tests/import.test.ts`:
```ts
it('detects a .json file as fhir-export', () => expect(detectKind(join(tmp, 'ehr-data.json'))).toBe('fhir-export'));
it('detects a folder with DICOMDIR as dicom', () => { writeFileSync(join(tmp, 'DICOMDIR'), ''); expect(detectKind(tmp)).toBe('dicom'); });
it('treats .tif and .tiff as documents', () => { expect(detectKind('/x/a.tiff')).toBe('pdf'); expect(detectKind('/x/a.TIF')).toBe('pdf'); });
```
`tests/identity.test.ts`:
```ts
it('fhir-export takes the smart identifier as its own', () =>
  expect(stableIdentifier({ resourceType: 'Condition', identifier: [{ system: 'urn:ga-server:id:smart:h', value: 'Condition/1' }] } as Condition, { kind: 'fhir-export', file: 'f', date: '2025-01-01', writer: 'importer' }, '')).toEqual({ system: 'urn:ga-server:id:smart:h', value: 'Condition/1' }));
it('apple-health accepts a leading smart identifier', () =>
  expect(stableIdentifier({ resourceType: 'Condition', identifier: [{ system: 'urn:ga-server:id:smart:h', value: 'Condition/1' }] } as Condition, { kind: 'apple-health', file: 'f', date: '2025-01-01', writer: 'importer' }, '')).toEqual({ system: 'urn:ga-server:id:smart:h', value: 'Condition/1' }));
it('fhir-export and dicom records are clinic records', () => {
  expect(isClinic({ resourceType: 'Observation', meta: { tag: [{ system: TAG, code: 'src-fhir-export' }] } } as Resource)).toBe(true);
  expect(isClinic({ resourceType: 'ImagingStudy', meta: { tag: [{ system: TAG, code: 'src-dicom' }] } } as Resource)).toBe(true);
});
```
`tests/cli.test.ts` (same style as its existing usage tests):
```ts
it('fhir-export import needs --fhir-base', () => expect(runCli(['import', jsonFile])).toMatch('usage: ga import <fhir-export.json> --fhir-base <FHIR base URL>'));
it('rejects a --fhir-base that is not a URL', () => expect(runCli(['import', jsonFile, '--fhir-base', 'nope'])).toMatch('--fhir-base needs a URL'));
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit tests/import.test.ts tests/identity.test.ts tests/cli.test.ts`
Expected: the new tests FAIL (`ccda` returned, type errors, no usage message).

- [ ] **Step 3: Implement the interfaces above**

`detectKind` order: `DOCUMENT_EXT` → `pdf`; `isEhiExport`; `isAppleHealthExport`; `.zip` error; `existsSync(join(path, 'DICOMDIR'))` → `dicom`; `/\.json$/i` → `fhir-export`; else `ccda`. In `cli.ts`, for kind `fhir-export` accept exactly `--fhir-base <url>` or `--fhir-base=<url>`, validate with `new URL()`, and pass `fhirBase` to `importAny`; kind `dicom` takes no extra args (`usage: ga import <dicom-folder>`). (The tool's tests ran under vitest while it lived in GA; it now lives in the dataset folder and uses `node --test`.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project unit && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/import.ts src/identity.ts src/current.ts src/engine.ts src/whats-new.ts src/cli.ts vitest.config.ts src/fhir-export src/dicom tests/import.test.ts tests/identity.test.ts tests/cli.test.ts
git commit -m "feat(import): fhir-export and dicom kinds wired through detection, identity, currency and CLI (stub importers)"
```

---

### Task A: Epic FHIR export importer

**Files:**
- Create: `src/fhir-export/read.ts`
- Modify: `src/fhir-export/import.ts` (replace stub)
- Modify: `src/smart/fetch.ts:154` (export `htmlToText`), `src/smart/sync.ts:66` (export `uploadBinaries`)
- Create: `tests/fixtures/fhir-export/mini.json`, `tests/fhir-export-read.test.ts`, `tests/integration/fhir-export.test.ts`, `docs/fhir-export.md`

**Interfaces:**
- Consumes: `importFhirExport`, `FhirExportReport` signatures from Task 0; `mapForGa(rs: Resource[], src: SourceRec)` (`src/smart/fetch.ts:191`); `sourceKey(fhirBase)` (`src/smart/auth.ts:24`); `importResources` (`src/engine.ts:351`); `withImportLock` (as used in `src/ccda.ts`).
- Produces:
  - `src/fhir-export/read.ts`: `export function readFhirExport(path: string): { resources: Resource[]; skippedTypes: Record<string, number>; attachmentsUnplaced: number; date: string }`
  - The input format `{ fhir: Record<string, Resource[]>; attachments?: { resourceType: string; resourceId: string; path: string; contentType: string; contentBase64: string }[] }` is the contract Task D writes.

`readFhirExport` rules: types kept are `Patient`, the keys of `COMPARTMENT` and `Practitioner`, `PractitionerRole`, `Organization`, `Location`, `Medication`; others are counted in `skippedTypes`. Each attachment goes to the dotted `path` under the resource `<resourceType>/<resourceId>` as `{ ...existing, contentType, data: contentBase64 }`. Inside `mapForGa` (so sync and Apple copies get it too), each DiagnosticReport `presentedForm` entry with inline `text/html` or rtf data becomes `text/plain; charset=utf-8` with the same `note()` conversion DocumentReference attachments use; test it in `tests/smart-fetch.test.ts` (`converts report html to text`). `date` = newest `meta.lastUpdated`, else the newest of `effectiveDateTime`/`issued`/`date`/`authoredOn`/`recordedDate`, as an ISO string.

- [ ] **Step 1: Write the fixture and failing unit tests**

`mini.json`: a synthetic export with one Patient, one Observation, one Condition, one DocumentReference with `content[0].attachment.url = "Binary/b1"`, one DiagnosticReport, one `Account` (unsupported type), and three attachments: html for the DocumentReference (`content.0.attachment`), html for the DiagnosticReport (`presentedForm.0`), and one pointing at `DocumentReference/missing`.

`tests/fhir-export-read.test.ts`:
```ts
it('places attachments and counts the unplaced one', () => {
  const r = readFhirExport(MINI);
  const doc = r.resources.find((x) => x.resourceType === 'DocumentReference') as DocumentReference;
  expect(doc.content[0].attachment.data).toBeDefined();
  expect(r.attachmentsUnplaced).toBe(1);
});
it('counts unsupported types', () => expect(readFhirExport(MINI).skippedTypes).toEqual({ Account: 1 }));
it('places report html for mapForGa to convert', () => {
  const dr = readFhirExport(MINI).resources.find((x) => x.resourceType === 'DiagnosticReport') as DiagnosticReport;
  expect(dr.presentedForm?.[0]).toMatchObject({ contentType: 'text/html' });
  expect(dr.presentedForm?.[0].data).toBeDefined();
});
it('refuses a file without a fhir object', () => expect(() => readFhirExport(NOT_EXPORT)).toThrow('not a FHIR export: expected {"fhir": {...}}'));
it('file import and portal sync give the same identifier', () => {
  const base = 'https://fhir.example.org/api/FHIR/R4/';
  const src = { key: sourceKey(base), name: 'x', fhirBase: base };
  const fromFile = mapForGa(readFhirExport(MINI).resources, src).resources.find((x) => x.resourceType === 'Condition')!;
  expect((fromFile as Condition).identifier?.[0]).toEqual({ system: `urn:ga-server:id:smart:${sourceKey(base)}`, value: 'Condition/c1' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit tests/fhir-export-read.test.ts`
Expected: FAIL (`readFhirExport` not defined).

- [ ] **Step 3: Implement `readFhirExport` in `src/fhir-export/read.ts`**, and the `presentedForm` conversion in `mapForGa` with its test `converts report html to text` in `tests/smart-fetch.test.ts` (a DiagnosticReport with `presentedForm: [{ contentType: 'text/html', data: base64('<p>Impression: normal</p>') }]` maps to `contentType: 'text/plain; charset=utf-8'` and text `Impression: normal`).

- [ ] **Step 4: Run unit tests**: same command, expected PASS.

- [ ] **Step 5: Write the failing integration tests** in `tests/integration/fhir-export.test.ts` (test patient via `createTestPatient`, cleaned up via `cleanupTestPatient`, as in `tests/integration/smart-sync.test.ts`):
```ts
it('imports the export', async () => {
  const r = await importFhirExport(client, cfg, MINI, patientId, { fhirBase: BASE });
  expect(r.created).toBeGreaterThanOrEqual(5);
  expect(r.attachmentsUnplaced).toBe(1);
  const c = await client.searchOne('Condition', { identifier: `urn:ga-server:id:smart:${sourceKey(BASE)}|Condition/c1`, subject: `Patient/${patientId}` });
  expect(c?.meta?.tag?.map((t) => t.code)).toContain('src-fhir-export');
});
it('re-import is a no-op', async () => {
  const r = await importFhirExport(client, cfg, MINI, patientId, { fhirBase: BASE });
  expect(r.created).toBe(0); expect(r.updated).toBe(0);
});
it('an added note updates the record', async () => {
  // MINI_NOTE: MINI with Condition c1 carrying note [{ text: 'patient note', time: '2025-12-04T02:26:05Z' }]
  await importFhirExport(client, cfg, MINI_NOTE, patientId, { fhirBase: BASE });
  const c = await client.searchOne('Condition', { identifier: `urn:ga-server:id:smart:${sourceKey(BASE)}|Condition/c1`, subject: `Patient/${patientId}` });
  expect(c?.note?.map((n) => n.text)).toContain('patient note');
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run --project integration tests/integration/fhir-export.test.ts`
Expected: FAIL (stub throws `fhir-export import not implemented yet`).

- [ ] **Step 7: Implement `importFhirExport`**

`SourceRec = { key: sourceKey(fhirBase), name: new URL(fhirBase).hostname, fhirBase }`; `readFhirExport` → `mapForGa` → inside `withImportLock`: `storeDocument(client, path, patientId, 'application/json')` for the file hash, then `uploadBinaries` (exported from `sync.ts`), then `importResources(client, resources, { kind: 'fhir-export', file: resolve(path), date, writer: 'importer', dateOf: (r) => r.meta?.lastUpdated, fillOnly: (r) => !r.meta?.lastUpdated }, patientId, fileHash)`. Return the report plus `skippedTypes` and `attachmentsUnplaced`. If `an added note updates the record` still fails, the fix belongs in how the engine decides an update for this kind (`decide`/`fillSource` in `src/engine.ts`): change only the `fhir-export` branch and add a unit test for it in `tests/engine.test.ts`.

- [ ] **Step 8: Run unit + integration + typecheck**

Run: `npx vitest run --project unit && npx vitest run --project integration tests/integration/fhir-export.test.ts tests/integration/smart-sync.test.ts && npm run typecheck`
Expected: all PASS (smart-sync proves the exports changed nothing for sync).

- [ ] **Step 9: Write `docs/fhir-export.md`**: command, `--fhir-base` and why (later portal sync links), counts in the report, what is skipped.

- [ ] **Step 10: Commit**

```bash
git add src/fhir-export src/smart/fetch.ts src/smart/sync.ts tests/smart-fetch.test.ts tests/fixtures/fhir-export tests/fhir-export-read.test.ts tests/integration/fhir-export.test.ts docs/fhir-export.md
git commit -m "feat(import): Epic FHIR export file importer, identified like a portal sync"
```

---

### Task B: DICOM study importer

**Files:**
- Create: `src/dicom/read.ts`, `src/dicom/map.ts`
- Modify: `src/dicom/import.ts` (replace stub), `src/share/scope.ts:34` (`NEVER_DOCS`)
- Create: `tests/fixtures/dicom/` (generated by `tests/fixtures/dicom/make.ts`), `tests/dicom-read.test.ts`, `tests/dicom-map.test.ts`, `tests/integration/dicom.test.ts`, `docs/dicom.md`

**Interfaces:**
- Consumes: `importDicom`, `DicomReport` from Task 0; `archiveFolder(client, dir, patientId, system)` (`src/archive.ts:29`); `storeDocument` (`src/document.ts:7`); `importResources`.
- Produces:
  - `src/dicom/read.ts`: `export type DicomHeader = { sopClass: string; sopInstance: string; transferSyntax: string; studyUid?: string; seriesUid?: string; studyDate?: string; studyTime?: string; modality?: string; studyDescription?: string; seriesDescription?: string; seriesNumber?: number; instanceNumber?: number; bodyPart?: string }` and `export function readHeader(file: string): DicomHeader | 'not-dicom' | 'unsupported'`, plus `export function encapsulatedPdf(file: string): Buffer | undefined`.
  - `src/dicom/map.ts`: `export function toImagingStudies(headers: DicomHeader[]): ImagingStudy[]`.

Tags read: (0002,0010) TransferSyntaxUID, (0008,0016), (0008,0018), (0008,0020), (0008,0030), (0008,0060), (0008,1030), (0008,103E), (0018,0015), (0020,000D), (0020,000E), (0020,0011), (0020,0013). Group 0002 is always Explicit VR LE; the rest follows the transfer syntax: `1.2.840.10008.1.2` implicit LE, any other except `1.2.840.10008.1.2.2` (big endian) and `1.2.840.10008.1.2.1.99` (deflated) explicit LE; those two → `'unsupported'`. Read at most the first 256 KB (`readSync` into a buffer); `encapsulatedPdf` reads the whole file and returns (0042,0011) only for SOP class `1.2.840.10008.5.1.4.1.1.104.1`. `started` = StudyDate as `YYYY-MM-DD` only (DICOM gives no zone, and a FHIR dateTime with a time needs one); StudyTime is kept in `description` when present (`<StudyDescription> (study time hh:mm)`).

- [ ] **Step 1: Write the fixture generator and failing tests**

`make.ts` writes synthetic files: `ct/1` and `ct/2` (explicit VR LE, same study and series, SOP 1.2.840.10008.5.1.4.1.1.2, a 4-byte pixel data element), `implicit/1` (implicit VR LE), `seq/1` (explicit, an undefined-length SQ before the series UID), `pdf/1` (SOP …104.1 with a tiny `%PDF-1.4…%%EOF` in (0042,0011)), `big/1` (transfer syntax 1.2.840.10008.1.2.2), and a non-DICOM `Preview.jpg` (a few random bytes).

`tests/dicom-read.test.ts`:
```ts
it('reads study and series from explicit VR', () => expect(readHeader(F('ct/1'))).toMatchObject({ studyUid: '1.2.3', seriesUid: '1.2.3.4', modality: 'CT', instanceNumber: 1 }));
it('reads implicit VR', () => expect(readHeader(F('implicit/1'))).toMatchObject({ studyUid: '1.2.3' }));
it('skips undefined-length sequences', () => expect(readHeader(F('seq/1'))).toMatchObject({ seriesUid: '1.2.3.9' }));
it('skips non-DICOM files', () => expect(readHeader(F('Preview.jpg'))).toBe('not-dicom'));
it('marks big endian unsupported', () => expect(readHeader(F('big/1'))).toBe('unsupported'));
it('extracts the encapsulated PDF', () => expect(encapsulatedPdf(F('pdf/1'))?.subarray(0, 5).toString()).toBe('%PDF-'));
```
`tests/dicom-map.test.ts`:
```ts
it('builds one study with its series and instances', () => {
  const [s] = toImagingStudies([readHeader(F('ct/1')), readHeader(F('ct/2'))] as DicomHeader[]);
  expect(s.identifier).toEqual([{ system: 'urn:dicom:uid', value: 'urn:oid:1.2.3' }]);
  expect(s.numberOfSeries).toBe(1); expect(s.numberOfInstances).toBe(2);
  expect(s.series?.[0].instance?.map((i) => i.number)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node tests/fixtures/dicom/make.ts && npx vitest run --project unit tests/dicom-read.test.ts tests/dicom-map.test.ts`
Expected: FAIL (`readHeader` not defined).

- [ ] **Step 3: Implement `readHeader`, `encapsulatedPdf` (read.ts) and `toImagingStudies` (map.ts).** Check in the generated fixtures (they are small).

- [ ] **Step 4: Run unit tests**: same command, expected PASS.

- [ ] **Step 5: Write the failing integration test** `tests/integration/dicom.test.ts` on a temp copy of the fixtures plus an empty `DICOMDIR`:
```ts
it('imports study, overview PDF and archive', async () => {
  const r = await importDicom(client, cfg, dir, patientId);
  expect(r).toMatchObject({ studies: 1, documents: 1, unsupported: 1, archive: 'stored' });
  expect(r.skipped).toBeGreaterThanOrEqual(2); // DICOMDIR, Preview.jpg
  const doc = await client.searchOne('DocumentReference', { identifier: 'urn:ga-server:id:dicom-archive|', subject: `Patient/${patientId}` });
  expect(doc).toBeDefined();
});
it('re-import is a no-op', async () => expect(await importDicom(client, cfg, dir, patientId)).toMatchObject({ created: 0, archive: 'already-present' }));
it('never shares the archive', () => expect(NEVER_DOCS.has('urn:ga-server:id:dicom-archive')).toBe(true));
```

- [ ] **Step 6: Run to verify it fails**: `npx vitest run --project integration tests/integration/dicom.test.ts`, expected FAIL (stub).

- [ ] **Step 7: Implement `importDicom`**

Walk `dir` recursively (`readdirSync(..., { recursive: true })`), `readHeader` each file, count `skipped`/`unsupported`. Build studies with `toImagingStudies`. For each encapsulated PDF write it to `archiveTmp(dir)`-style temp file, `storeDocument(client, tmpPdf, patientId, 'application/pdf', [{ system: 'urn:dicom:uid', value: 'urn:oid:<sopInstance>' }])`, then set `context.related` to the study's reference once the study exists. `importResources(client, studies, { kind: 'dicom', file: resolve(dir), date: <newest started>, writer: 'importer' }, patientId, '')`. Then `archiveFolder(client, dir, patientId, 'urn:ga-server:id:dicom-archive')`. Add the archive system to `NEVER_DOCS`.

- [ ] **Step 8: Run unit + integration + typecheck**

Run: `npx vitest run --project unit && npx vitest run --project integration tests/integration/dicom.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Write `docs/dicom.md`** (what is read, what is stored, archive never shared, transfer syntaxes supported).

- [ ] **Step 10: Commit**

```bash
git add src/dicom src/share/scope.ts tests/fixtures/dicom tests/dicom-read.test.ts tests/dicom-map.test.ts tests/integration/dicom.test.ts docs/dicom.md
git commit -m "feat(import): DICOM study importer: ImagingStudy from headers, encapsulated PDFs, archived folder"
```

---

### Task C: TIFF scans in ga_import

**Files:**
- Modify: `src/mcp.ts:41` (`TYPES`), `src/tools/imports.ts:111` and the remote `ga_import` type check, `src/llm.ts:7`
- Modify: `.claude/skills/ga-import/extract.md`, `.claude/skills/ga-import/SKILL.md`, AGENTS.md "PDF extraction" section (same text as extract.md step 1)
- Test: `tests/mcp-tools.test.ts`, `tests/tools-imports.test.ts`, `tests/llm.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_EXT` from Task 0 (use it in `tools/imports.ts:111` instead of the literal).
- Produces: `TYPES['.tif'] = TYPES['.tiff'] = 'image/tiff'` in `src/mcp.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/mcp-tools.test.ts, beside the existing importExtracted sourceFile tests
it('accepts a TIFF source file', async () => {
  const r = await importExtracted(client, cfg, [obs], tiffPath);
  expect(r.created).toBe(1);
});
// tests/llm.test.ts
it('refuses TIFF for --llm api', async () => expect(extractWithApi('/x/a.tiff', 'k')).rejects.toThrow('convert the TIFF to PNG first'));
// tests/tools-imports.test.ts
it('routes an uploaded TIFF to agent extraction', async () =>
  expect(await importFileTool({ fileId: tiffUploadId })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('this is a PDF or image') }] }));
// importFileTool / tiffUploadId: the file's existing helpers for calling import_file on an upload, with a .tiff upload
```

- [ ] **Step 2: Run to verify they fail**: `npx vitest run --project unit tests/mcp-tools.test.ts tests/llm.test.ts tests/tools-imports.test.ts`, expected the 3 new tests FAIL.

- [ ] **Step 3: Implement**: add the two `TYPES` entries; `llm.ts` throws `GaError('convert the TIFF to PNG first (the API takes PDF, PNG and JPEG)')` for `.tif`/`.tiff`; `tools/imports.ts` uses `DOCUMENT_EXT`.

- [ ] **Step 4: Update the docs**: extract.md step 1 and the AGENTS.md mirror gain: "A TIFF: make a PNG copy in your scratch directory (`sips -s format png <file> --out <copy>`) to read, and pass the original TIFF as `sourceFile`." SKILL.md lists `.tif`/`.tiff` with PDFs and images.

- [ ] **Step 5: Run unit tests + typecheck**: `npx vitest run --project unit && npm run typecheck`, expected PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp.ts src/tools/imports.ts src/llm.ts .claude/skills/ga-import AGENTS.md tests/mcp-tools.test.ts tests/llm.test.ts tests/tools-imports.test.ts
git commit -m "feat(import): ga_import accepts TIFF scans (agent reads a PNG copy)"
```

---

### Task D: personalrecord rebuild (standalone project)

> Moved (Task M): the tool as built below now lives in the dataset's `derived/ga-rebuild/<date>/tool/`, with `node:test` tests instead of vitest; GA keeps only a synthetic sample of its output (`tests/fixtures/fhir-export/rebuilt-sample.json`).

**Files:**
- Create: `tools/personalrecord/README.md`, `tools/personalrecord/cli.ts`, `tools/personalrecord/rebuild.ts`, `tools/personalrecord/annotations.ts`
- Create: `tools/personalrecord/test/rebuild.test.ts`, `tools/personalrecord/test/annotations.test.ts`, `tools/personalrecord/test/boundary.test.ts`, `tools/personalrecord/test/fixtures/{bundle.json,annotations.json,known.json}` (synthetic)

**Interfaces:**
- Consumes: nothing from GA. Writes Task A's input format (`{ fhir: Record<string, Resource[]>; attachments: [] }`).
- Produces:
  - `rebuild.ts`: `export type RebuildReport = { emitted: Record<string, number>; alreadyKnown: number; beforeCutoff: number; notEpic: number; otherSource: number; cutoff: string }` and `export function rebuild(bundle: Bundle, known: Record<string, Resource[]>, opts: { includeBeforeCutoff?: boolean }): { resources: Resource[]; report: RebuildReport }`
  - `annotations.ts`: `export type PrAnnotation = { annotation_type: 'ended' | 'ongoing' | 'date_change' | 'comment'; created_at: string; code_display: string; effective_datetime_original: string | null; annotation_data: string }` and `export function attachAnnotations(anns: PrAnnotation[], known: Record<string, Resource[]>, rebuilt: Resource[]): { resources: Resource[]; unmatched: { code: string; reason: 'none' | 'several' }[] }` (returns `rebuilt` with notes added, plus verbatim copies of matched known resources with the note appended).
  - CLI: `node cli.ts <dir> --known <ehr-data.json> --out <file.json> [--include-before-cutoff]` reads `<dir>/bundle.json` and `<dir>/annotations.json`, writes `--out`, prints `{ ...RebuildReport, annotationsMatched, annotationsUnmatched }`.

Rebuild mapping (id = the bundle id without its prefix; `date` = the Observation's `effectiveDateTime`; `NOTE` = `{ text: 'Reconstructed from a personalrecord export; original structure lost.' }`; never `subject`, `meta`, the app's `extension`s, or the non-FHIR fields `source`, `data_type`, `element_id`):

| Prefix | Resource |
|---|---|
| none | `Observation`: the bundle Observation's FHIR fields as they are, plus `NOTE` in `note` |
| `condition-` | `Condition`: `code`, `recordedDate: date`, `note: [NOTE, {text: valueString}]` when valueString differs from `code.text` |
| `medrx-` | `MedicationRequest`: `status: 'unknown'`, `intent: 'order'`, `medicationCodeableConcept`: `code` if it has codings or text, else `{ text: valueString }`; `authoredOn: date`; `note: [NOTE]` |
| `docref-` | `DocumentReference`: `status: 'current'`, `type: code`, `date: date` as instant, `content: [{ attachment: { contentType: 'text/plain; charset=utf-8', data: base64(valueString), title: code.text } }]` |
| `dr-` | `DiagnosticReport`: `status: 'final'`, `code`, `effectiveDateTime: date`, `conclusion: valueString` |
| `imm-` | `Immunization`: `status: 'completed'`, `vaccineCode: code`, `occurrenceDateTime: date` |
| `proc-` | `Procedure`: `status: 'completed'`, `code`, `performedDateTime: date` |
| any other (`attach-`, `f-`, `e-` …) | not emitted, counted in `notEpic` |

Filters, in order: `source` extension ≠ `ehr_data` → `otherSource`; id not `/^e[A-Za-z0-9.\-]{15,}$/` → `notEpic`; id in `known` → `alreadyKnown`; date ≤ cutoff (newest clinical date in `known`) and not `includeBeforeCutoff` → `beforeCutoff`.

Annotation note: `{ authorString: 'Patient', time: created_at, text: '<Ended|Ongoing|Date corrected to <annotated_date>|Comment>: <text or status_date> (personalrecord annotation)' }`.

- [ ] **Step 1: Write the synthetic fixtures and failing tests**

`rebuild.test.ts`:
```ts
it('rebuilds a medication order after the cutoff', () => {
  const { resources } = rebuild(BUNDLE, KNOWN, {});
  const m = resources.find((r) => r.resourceType === 'MedicationRequest') as MedicationRequest;
  expect(m).toMatchObject({ id: 'eMED00000000000000001', status: 'unknown', intent: 'order', authoredOn: '2026-01-07' });
  expect(m.meta).toBeUndefined();
});
it('skips known ids and records before the cutoff', () => {
  expect(rebuild(BUNDLE, KNOWN, {}).report).toMatchObject({ alreadyKnown: 1, beforeCutoff: 1, otherSource: 1, notEpic: 1 });
});
it('includes records before the cutoff on request', () => expect(rebuild(BUNDLE, KNOWN, { includeBeforeCutoff: true }).report.beforeCutoff).toBe(0));
it('carries a note text into a DocumentReference attachment', () => {
  const d = rebuild(BUNDLE, KNOWN, {}).resources.find((r) => r.resourceType === 'DocumentReference') as DocumentReference;
  expect(Buffer.from(d.content[0].attachment.data!, 'base64').toString()).toBe('synthetic note text');
});
```
`annotations.test.ts`:
```ts
it('appends the note to a verbatim copy of the known resource', () => {
  const { resources } = attachAnnotations([ENDED_CONDITION], KNOWN, []);
  expect(resources[0]).toEqual({ ...KNOWN.Condition[0], note: [...(KNOWN.Condition[0].note ?? []), expect.objectContaining({ authorString: 'Patient', text: expect.stringContaining('Ended') })] });
});
it('reports an annotation matching two resources', () => expect(attachAnnotations([AMBIGUOUS], KNOWN, []).unmatched).toEqual([{ code: 'Synthetic test', reason: 'several' }]));
```
`boundary.test.ts`: every `.ts` under `tools/personalrecord` (tests excluded) imports only `node:*`, `@medplum/fhirtypes` and `./` files (same approach as `src/store/test/boundary.test.ts`).

- [ ] **Step 2: Run to verify they fail**: `npx vitest run --project unit tools/personalrecord`, expected FAIL.

- [ ] **Step 3: Implement `rebuild`, `attachAnnotations` and `cli.ts`.** `cli.ts` reads `bundle.json` with `JSON.parse(readFileSync(...))` (418 MB; run with `node --max-old-space-size=4096`, stated in README).

- [ ] **Step 4: Run tests + typecheck**: `npx vitest run --project unit tools/personalrecord && npm run typecheck`, expected PASS.

- [ ] **Step 5: Write `tools/personalrecord/README.md`** (purpose, command, report fields, the mapping table, the memory flag, "no GA imports").

- [ ] **Step 6: Commit**

```bash
git add tools/personalrecord
git commit -m "feat(tools): personalrecord rebuild: typed FHIR from the app's flattened bundle, owner annotations as notes"
```

---

### Task E: Apple Health imports every R4 clinical record

**Files:**
- Modify: `src/apple/read.ts:8,74` (`AhClinical` gains `receivedDate`, `sourceName`), `src/apple/clinical.ts:19-40` (`mapClinical`), `src/apple/import.ts` (one `importResources` call for clinical records; old-allergy pre-pass)
- Create: `tests/fixtures/apple/clinical/` (synthetic export: `export.xml` with 6 `ClinicalRecord`s and their JSON files), `tests/integration/apple-clinical.test.ts`
- Test: `tests/apple-map.test.ts`, `tests/apple-read.test.ts`

**Interfaces:**
- Consumes: `mapForGa(rs, src)` (`src/smart/fetch.ts:191`), `sourceKey(fhirBase)` (`src/smart/auth.ts:24`), Task 0's `OWN_ID['apple-health']` and `fillFrom` change; for tests only, `importFhirExport` is not used (E tests the hospital side with `syncSource`'s mapping via `mapForGa` + `importResources` kind `smart`, so E does not wait for A).
- Produces: `export type AhClinical = { sourceURL: string; fhirVersion: string; resourceFilePath: string; receivedDate?: string; sourceName?: string }`; `mapClinical(dir: string, refs: AhClinical[]): { resources: Resource[]; skips: { clinicalVersionUnsupported: number; clinicalUnreadable: number } }` (the `clinicalTypeUnsupported` count goes away); `export function fhirBaseOf(sourceURL: string): { base: string; key: string } | undefined` in `src/apple/clinical.ts`.

`receivedDate` is Apple's `"2025-11-02 00:15:45 -0800"`; store it as ISO `2025-11-02T00:15:45-08:00`. `fhirBaseOf` strips the trailing `/<Type>/<id>` from `sourceURL`; a URL it cannot parse → the record is counted in `clinicalUnreadable`.

- [ ] **Step 1: Write the fixture and failing unit tests**

Fixture `ClinicalRecord`s (all synthetic, base `https://fhir.example.org/api/FHIR/R4`): a Patient, an AllergyIntolerance, a Condition, an Observation whose JSON has a stray `\d` inside a string, a MedicationRequest with `fhirVersion="1.0.2"`, and a DiagnosticReport with inline html `presentedForm`.

`tests/apple-map.test.ts`:
```ts
it('imports every R4 type, identified like a portal sync', () => {
  const { resources } = mapClinical(DIR, refs);
  const c = resources.find((r) => r.resourceType === 'Condition') as Condition;
  expect(c.identifier?.[0]).toEqual({ system: `urn:ga-server:id:smart:${sourceKey('https://fhir.example.org/api/FHIR/R4')}`, value: 'Condition/c1' });
  expect(c.identifier?.[1]).toEqual({ system: APPLE, value: 'https://fhir.example.org/api/FHIR/R4/Condition/c1' });
});
it('repairs a stray backslash', () => expect(mapClinical(DIR, refs).resources.some((r) => r.resourceType === 'Observation')).toBe(true));
it('counts DSTU2 records', () => expect(mapClinical(DIR, refs).skips).toEqual({ clinicalVersionUnsupported: 1, clinicalUnreadable: 0 }));
it('finds the FHIR base of a sourceURL', () => expect(fhirBaseOf('https://h.example/R4/Observation/x.1')?.base).toBe('https://h.example/R4'));
```
`tests/apple-read.test.ts`:
```ts
it('reads receivedDate and sourceName', () => expect(clinicalOf(FIXTURE)[0]).toMatchObject({ receivedDate: '2025-11-02T00:15:45-08:00', sourceName: 'Synthetic Hospital' }));
```

- [ ] **Step 2: Run to verify they fail**: `npx vitest run --project unit tests/apple-map.test.ts tests/apple-read.test.ts`, expected the new tests FAIL.

- [ ] **Step 3: Implement** `fhirBaseOf`, the new `mapClinical` (group refs by base, `mapForGa(group, { key, name: sourceName ?? host, fhirBase: base })`, append the APPLE identifier, the backslash repair `s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')`), and `receivedDate`/`sourceName` in `read.ts`.

- [ ] **Step 4: Run unit tests**: same command plus `tests/apple-memory.test.ts tests/apple-batches.test.ts`, expected PASS (the memory budget still holds).

- [ ] **Step 5: Write the failing integration tests** `tests/integration/apple-clinical.test.ts` (fresh test patient per test):
```ts
it('Apple only: every R4 record lands', async () => {
  await importAppleHealth(client, cfg, FIXTURE, patientId);
  for (const t of ['AllergyIntolerance', 'Condition', 'Observation', 'DiagnosticReport']) expect(await count(t)).toBe(1);
});
it('Apple then hospital', async () => {
  await importAppleHealth(client, cfg, FIXTURE, patientId);
  await importHospital(HOSPITAL_CONDITION_C1_WITH_LAST_UPDATED); // mapForGa + importResources kind 'smart'
  const all = await client.searchResources('Condition', { subject: `Patient/${patientId}` });
  expect(all).toHaveLength(1); expect(all[0].code?.text).toBe('hospital wording');
});
it('hospital then Apple', async () => {
  await importHospital(HOSPITAL_CONDITION_C1_WITH_LAST_UPDATED);
  await importAppleHealth(client, cfg, FIXTURE, patientId);
  const all = await client.searchResources('Condition', { subject: `Patient/${patientId}` });
  expect(all).toHaveLength(1); expect(all[0].code?.text).toBe('hospital wording');
});
it('old Apple allergy gains the new identifier', async () => {
  await client.createResource(OLD_ALLERGY); // identifier only APPLE|<sourceURL>, tagged src-apple-health
  await importAppleHealth(client, cfg, FIXTURE, patientId);
  expect(await count('AllergyIntolerance')).toBe(1);
});
it('re-import is a no-op', async () => {
  await importAppleHealth(client, cfg, FIXTURE, patientId);
  expect((await importAppleHealth(client, cfg, FIXTURE, patientId)).created).toBe(0);
});
```

- [ ] **Step 6: Run to verify they fail**: `npx vitest run --project integration tests/integration/apple-clinical.test.ts`, expected FAIL.

- [ ] **Step 7: Implement in `src/apple/import.ts`**: one `importResources(client, clinical, { kind: 'apple-health', file, date, writer: 'importer', dateOf: (r) => receivedOf.get(r) , fillOnly: () => true }, patientId, '')` call for all clinical records, after the readings. Before it, the old-allergy pre-pass: for each AllergyIntolerance, `searchOne('AllergyIntolerance', { identifier: `${APPLE}|${sourceURL}`, patient: `Patient/${patientId}` })`; if found without the smart identifier, add it with `updateResource`. Do not change `src/engine.ts` (owned by Task 0 and, for its contingency, Task A); if `Apple then hospital` fails, report it as a finding rather than editing the engine.

- [ ] **Step 8: Run unit + integration + typecheck**

Run: `npx vitest run --project unit && npx vitest run --project integration tests/integration/apple-clinical.test.ts tests/integration/apple.test.ts tests/integration/apple-batches.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/apple tests/apple-map.test.ts tests/apple-read.test.ts tests/integration/apple-clinical.test.ts tests/fixtures/apple/clinical
git commit -m "feat(apple): import every R4 clinical record, identified like a portal sync of its hospital"
```

---

### Task R2: Scanned PDFs and PNGs (data run, no code; any time)

- [ ] **Step 1:** For each of the 3 PDFs, then the 3 PNGs, follow `.claude/skills/ga-import/extract.md` and call `ga_import` once per file.
- [ ] **Step 2:** A report with no printed collection date: ask the owner (one AskUserQuestion per report; offer the date from the personalrecord annotation where one exists, labelled as such), never infer from the filename.
- [ ] **Step 3:** After each `ga_import`, map every `unmapped` term with `map_concept`. Record counts and `possibleDuplicates` in the run log.

---

### Task Z: Remaining runs, AGENTS.md, totals (serial, after A–D are merged)

- [ ] **Step 1: Merge** A, B, C, D, E onto main; `npx vitest run --project unit && npm run typecheck`, expected PASS.
- [ ] **Step 1b: Apple Health:** `node src/cli.ts import <dataset>/device-data/apple-health/2025-11-10`. Expected: `clinicalVersionUnsupported` 0, `clinicalUnreadable` 0, 1,788 clinical records. Record counts in the run log `docs/superpowers/spikes/2026-11-10-dataset-import-run.md` (counts only).
- [ ] **Step 2: Epic FHIR export:** `node src/cli.ts import <dataset>/clinical-records/mgb-epic-fhir/2025-09/ehr-data.json --fhir-base https://ws-interconnect-fhir.partners.org/Interconnect-FHIR-MU-PRD/api/FHIR/R4/`. Expected: `skippedTypes` `{}`, `attachmentsUnplaced` 0, and created + updated + merged + skipped + invalid = 2,880 (record the actual split; any `invalid` is listed in the run log by type). Map `unmapped` with `map_concept`. Run it again: expected created 0. Check no duplicates against the Apple copies: `fhir_search` `Condition` `_count=500` returns 174 (the file's count), not 174 + 15.
- [ ] **Step 3: personalrecord rebuild:** `cd <dataset>/derived/ga-rebuild/<date>/tool && node --max-old-space-size=4096 cli.ts ../../../personalrecord/2026-06-01 --known <ehr-data.json> --out ../personalrecord-rebuilt.json`. Expected about 182 emitted (all dated after 2025-09-29). Show the owner `annotationsUnmatched`. Then `node src/cli.ts import <scratch>/personalrecord-rebuilt.json --fhir-base <same base>`.
- [ ] **Step 4: DICOM:** `node src/cli.ts import <dataset>/imaging/dental-ct-dicom/2025-12-24`. Expected: 1 study, 1 document, `unsupported` 0, archive stored.
- [ ] **Step 5: TIFF scans:** the 3 TIFFs by Task C's extract.md step, as in R2.
- [ ] **Step 6: AGENTS.md:** no new tool, so the intro tool list stays. In "Apple Health data", replace "Health Records inside the export are hospital copies: trust the hospital source over the Apple copy." with: "Health Records inside the export (FHIR R4) are imported, identified like a portal sync of their hospital, so a sync or Epic export links to them; the hospital version wins. DSTU2 records are counted, not imported." Add sections "Epic FHIR export file" (command, `--fhir-base`, identifiers shared with portal sync, tag `src-fhir-export`) and "DICOM imaging" (command, ImagingStudy, overview PDFs, `urn:ga-server:id:dicom-archive` never shared), and add both archives/sources to "Sharing" never-shared list where relevant. Link `docs/fhir-export.md`, `docs/dicom.md`; the rebuild tool's README lives in the dataset's `derived/ga-rebuild/<date>/tool/`.
- [ ] **Step 7: Totals:** call `health_summary` and `whats_new` (no `markSeen`), and fill the run log with per-dataset counts, the datasets not imported and why (Apple clinical copies, `export_cda.xml` incl. its differing patient name, app metadata), and any `possible-duplicate` or `source-conflict` counts.
- [ ] **Step 8: Commit**

```bash
git add AGENTS.md docs/superpowers/spikes/2026-11-10-dataset-import-run.md
git commit -m "docs: FHIR export and DICOM imports in AGENTS.md; dataset import run log"
```
