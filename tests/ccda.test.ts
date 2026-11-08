import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Composition, Condition, Encounter, Medication, MedicationStatement, Resource } from '@medplum/fhirtypes';
import { ccdaConverter, ccdaDate, ccdaFiles, convertCcdaLocal, custodian, importPath, repair } from '../src/ccda.ts';
import type { GaConfig } from '../src/config.ts';
import { onStore } from './temp-store.ts';

test('ccdaDate parses effectiveTime', () => {
  const doc = (v: string) => `<ClinicalDocument><code/><effectiveTime value="${v}"/><component><effectiveTime value="19990101"/></component></ClinicalDocument>`;
  expect(ccdaDate(doc('20240315120000-0500'))).toBe('2024-03-15T12:00:00-05:00');
  expect(ccdaDate(doc('20240315'))).toBe('2024-03-15');
  expect(ccdaDate(doc('202403151200+0100'))).toBe('2024-03-15T12:00:00+01:00');
  // No timezone: keep only the date rather than invent one.
  expect(ccdaDate(doc('20240315120000'))).toBe('2024-03-15');
  expect(() => ccdaDate('<ClinicalDocument/>')).toThrow(/effectiveTime/);
});

test('ccdaFiles keeps ClinicalDocument xml and skips other xml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-ccda-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'DOC0001.XML'), '<?xml version="1.0"?>\n<!-- c -->\n<ClinicalDocument xmlns="urn:hl7-org:v3"/>');
  writeFileSync(join(dir, 'METADATA.XML'), '<?xml version="1.0"?><SubmitObjectsRequest/>');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  expect(ccdaFiles(dir)).toEqual([join(dir, 'sub', 'DOC0001.XML')]);
});

const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody>
  <component><section><entry><substanceAdministration><id root="1.1" extension="m-active"/><statusCode code="active"/></substanceAdministration></entry>
    <entry><substanceAdministration><id root="1.1" extension="m-aborted"/><statusCode code="aborted"/></substanceAdministration></entry>
    <entry><substanceAdministration><id root="AB-CD"/><statusCode code="completed"/></substanceAdministration></entry></section></component>
  <component><section>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-active"/><statusCode code="completed"/></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="completed"/><entryRelationship><observation><id root="2.2" extension="p-done"/><statusCode code="completed"/></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-status-inactive"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/><high value="2021"/></effectiveTime>
      <entryRelationship typeCode="REFR"><observation><code code="33999-4"/><value code="73425007" displayName="Inactive"/></observation></entryRelationship>
    </observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-high"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/><high value="2021"/></effectiveTime></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="2.2" extension="p-open"/><statusCode code="completed"/>
      <effectiveTime><low value="2020"/><high nullFlavor="UNK"/></effectiveTime></observation></entryRelationship></act></entry>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id nullFlavor="NI"/><statusCode code="completed"/>
      <entryRelationship typeCode="REFR"><observation><code code="33999-4"/><value code="413322009" displayName="Resolved"/></observation></entryRelationship>
    </observation></entryRelationship></act></entry>
  </section></component></structuredBody></component></ClinicalDocument>`;
const ms = (system: string, value: string): MedicationStatement =>
  ({ resourceType: 'MedicationStatement', identifier: [{ system, value }], subject: { reference: 'Patient/p' } }) as MedicationStatement;
const cond = (value: string): Condition => ({ resourceType: 'Condition', identifier: [{ system: 'urn:oid:2.2', value }], subject: { reference: 'Patient/p' } });

test('repair recovers statuses from the source entries and drops the converter DocumentReference', () => {
  const out = repair(
    [
      ms('urn:oid:1.1', 'm-active'),
      ms('urn:oid:1.1', 'm-aborted'),
      ms('urn:ietf:rfc:3986', 'urn:uuid:ab-cd'),
      ms('urn:oid:1.1', 'not-in-xml'),
      cond('p-active'),
      cond('p-done'),
      cond('not-in-xml'),
      { resourceType: 'Encounter', class: { code: 'AMB' } } as Encounter,
      { resourceType: 'DocumentReference', status: 'current', content: [] },
    ] as Resource[],
    xml,
  );
  expect(out.filter((r) => r.resourceType === 'MedicationStatement').map((r) => (r as MedicationStatement).status)).toEqual([
    'active',
    'stopped',
    'completed',
    'unknown',
  ]);
  const [a, d, n] = out.filter((r) => r.resourceType === 'Condition') as Condition[];
  expect(a.clinicalStatus?.coding?.[0]?.code).toBe('active');
  expect(d.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
  expect(d.verificationStatus?.coding?.[0]?.code).toBe('confirmed');
  expect(n.clinicalStatus).toBeUndefined();
  expect((out.find((r) => r.resourceType === 'Encounter') as Encounter).status).toBe('unknown');
  expect(out.some((r) => r.resourceType === 'DocumentReference')).toBe(false);
});

test('condition status precedence: status observation > effectiveTime/high > concern act', () => {
  const out = repair(['p-status-inactive', 'p-high', 'p-open', ''].map(cond) as Resource[], xml) as Condition[];
  expect(out.map((c) => c.clinicalStatus?.coding?.[0]?.code)).toEqual(['inactive', 'resolved', 'active', undefined]);
  expect(out[1].verificationStatus?.coding?.[0]?.code).toBe('confirmed');
});

test('repair names medications from the narrative and labels problem-list vs visit diagnoses', () => {
  const doc = `<ClinicalDocument xmlns="urn:hl7-org:v3"><component><structuredBody>
  <component><section><text><list><item><content ID="med1">examplestatin 10 mg tablet</content></item></list></text>
    <entry><substanceAdministration><id root="9.9" extension="m1"/><statusCode code="active"/>
      <consumable><manufacturedProduct><manufacturedMaterial><code code="123" codeSystem="2.16.840.1.113883.6.88"><originalText><reference value="#med1"/></originalText></code></manufacturedMaterial></manufacturedProduct></consumable>
    </substanceAdministration></entry></section></component>
  <component><section><templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <entry><act><statusCode code="active"/><entryRelationship><observation><id root="8.8" extension="pl"/></observation></entryRelationship></act></entry></section></component>
  <component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <entry><encounter><entryRelationship><act><entryRelationship><observation><id root="8.8" extension="dx"/></observation></entryRelationship></act></entryRelationship></encounter></entry></section></component>
  </structuredBody></component></ClinicalDocument>`;
  const out = repair(
    [
      { resourceType: 'Medication', id: 'med-a', code: { coding: [{ system: 'urn:oid:2.16.840.1.113883.6.69', code: '0000-0000-00' }] } },
      { ...ms('urn:oid:9.9', 'm1'), medicationReference: { reference: 'Medication/med-a' } },
      { resourceType: 'Condition', identifier: [{ system: 'urn:oid:8.8', value: 'pl' }], subject: { reference: 'Patient/p' } },
      { resourceType: 'Condition', identifier: [{ system: 'urn:oid:8.8', value: 'dx' }], subject: { reference: 'Patient/p' } },
    ] as Resource[],
    doc,
  );
  const med = out[0] as Medication;
  expect(med.code?.text).toBe('examplestatin 10 mg tablet');
  expect(med.code?.coding).toContainEqual({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '123', display: 'examplestatin 10 mg tablet' });
  expect(med.code?.coding?.[0].code).toBe('0000-0000-00');
  const [pl, dx] = out.slice(2) as Condition[];
  expect(pl.category?.[0].coding?.[0].code).toBe('problem-list-item');
  expect(dx.category?.[0].coding?.[0].code).toBe('encounter-diagnosis');
});

test('custodian: own element only, namespace prefix and entities handled, never a later patient name', () => {
  const doc = (custodianXml: string) => `<ClinicalDocument>${custodianXml}<recordTarget><patientRole><patient><name><given>Pat</given></name></patient></patientRole></recordTarget></ClinicalDocument>`;
  expect(custodian(doc('<custodian><assignedCustodian><representedCustodianOrganization><id root="1"/></representedCustodianOrganization></assignedCustodian></custodian>'))).toBeUndefined();
  expect(custodian(doc('<custodian><assignedCustodian><representedCustodianOrganization/></assignedCustodian></custodian>'))).toBeUndefined();
  expect(custodian(doc('<x:custodian><x:representedCustodianOrganization><x:name> A &amp; B &#233;</x:name></x:representedCustodianOrganization></x:custodian>'))).toBe('A & B \u00e9');
  // A malformed numeric entity falls back to no custodian (the folder name keys the source), never a throw.
  expect(custodian(doc('<custodian><representedCustodianOrganization><name>A &#99999999;</name></representedCustodianOrganization></custodian>'))).toBeUndefined();
});

test('convertCcdaMs with the converter not running names the command that starts it', async () => {
  const { convertCcdaMs } = await import('../src/ccda.ts');
  await expect(convertCcdaMs('<ClinicalDocument/>', 'http://127.0.0.1:9/')).rejects.toThrow('docker compose --profile ccda up -d fhir-converter');
});

const FIXTURES = join(import.meta.dirname, 'fixtures');
const SYNTHETIC = readFileSync(join(FIXTURES, 'ccda-synthetic.xml'), 'utf8');
const EPIC = readFileSync(join(FIXTURES, 'ccda-epic-style.xml'), 'utf8');
const ENTRY_LEVEL = ['section not supported by the converter', 'entry produced no record'];
const sectionTitles = (xml: string) => [...xml.matchAll(/<section>[\s\S]*?<title>([^<]*)<\/title>/g)].map((m) => m[1]);
// Every section is on the Composition (its narrative); every section with entries has records or is named in notImported.
const accounted = (xml: string, out: ReturnType<typeof convertCcdaLocal>) => {
  const comp = out.resources.find((r) => r.resourceType === 'Composition') as Composition;
  expect(comp.section?.map((s) => s.title)).toEqual(sectionTitles(xml));
  for (const s of comp.section ?? []) {
    const entries = (xml.split(`<title>${s.title}</title>`)[1].split('</section>')[0].match(/<entry>/g) ?? []).length;
    expect((s.entry?.length ?? 0) + out.notImported.filter((n) => n.section === s.title && ENTRY_LEVEL.includes(n.reason)).reduce((a, n) => a + n.entries, 0)).toBe(entries);
  }
};

test('the generic fixture converts with nothing unaccounted', () => {
  const out = convertCcdaLocal(SYNTHETIC);
  expect(out.notImported).toEqual([]);
  accounted(SYNTHETIC, out);
});

test('a section inside a section is named, with its entries', () => {
  const sub = '<component><section><templateId root="2.16.840.1.113883.10.20.22.2.99"/><title>Sub</title><text>x</text><entry><act classCode="ACT" moodCode="EVN"/></entry></section></component>';
  const out = convertCcdaLocal(SYNTHETIC.replace('<text>Never smoker</text>', `<text>Never smoker</text>${sub}`));
  expect(out.notImported).toEqual([{ section: 'Social History', templateId: '2.16.840.1.113883.10.20.22.2.99', entries: 1, reason: 'nested section not read' }]);
});

const SECOND = '<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.4"/><id root="2.25.6099" extension="syn-problem-x"/><code code="55607006" codeSystem="2.16.840.1.113883.6.96"/><statusCode code="completed"/><value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96" displayName="Hypertension"/></observation></entryRelationship>';
test('a concern act with more than one problem or allergy observation names the ones not converted', () => {
  const problems = SYNTHETIC.replace('</entryRelationship>\n            </act>', `</entryRelationship>${SECOND}\n            </act>`);
  expect(convertCcdaLocal(problems).notImported).toEqual([
    { section: 'Problems', templateId: '2.16.840.1.113883.10.20.22.4.3', entries: 1, reason: 'additional problem in concern not converted' },
  ]);
  const allergies = EPIC.replace('</participant>\n                </observation>\n              </entryRelationship>', `</participant>\n                </observation>\n              </entryRelationship>${SECOND}`);
  expect(convertCcdaLocal(allergies).notImported).toContainEqual(
    { section: 'Allergies', templateId: '2.16.840.1.113883.10.20.22.4.30', entries: 1, reason: 'additional allergy in concern not converted' },
  );
});

test('an organizer component that is not an observation is named', () => {
  const proc = '<component><procedure classCode="PROC" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.6.1"/></procedure></component>';
  const out = convertCcdaLocal(SYNTHETIC.replace('</component>\n            </organizer>', `</component>${proc}\n            </organizer>`));
  expect(out.notImported).toEqual([{ section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.1', entries: 1, reason: 'organizer component not converted' }]);
});

test('a section without a templateId: its entries the library cannot route are named and the rest of the document still converts', () => {
  const out = convertCcdaLocal(SYNTHETIC.replace('<templateId root="2.16.840.1.113883.10.20.22.2.5.1" extension="2015-08-01"/>', ''));
  expect(out.notImported).toEqual([{ section: 'Problems', entries: 2, reason: 'section not supported by the converter' }]);
  expect(out.resources.filter((r) => r.resourceType === 'Observation').length).toBeGreaterThan(0);
});

test('a goal observation outside the plan reads only coded or text values', () => {
  const goal = '<entry><observation classCode="GOAL" moodCode="GOL"><templateId root="2.16.840.1.113883.10.20.22.4.121"/><id root="2.25.9100" extension="g1"/><code code="1" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/><value xsi:type="PQ" value="5" unit="kg"/></observation></entry>';
  const out = convertCcdaLocal(SYNTHETIC.replace('</entry>\n        </section>\n      </component>\n    </structuredBody>', `</entry>${goal}\n        </section>\n      </component>\n    </structuredBody>`));
  expect(out.resources.some((r) => r.resourceType === 'Goal')).toBe(true);
  expect(out.notImported).toEqual([{ section: 'Social History', templateId: '2.16.840.1.113883.10.20.22.4.121', entries: 1, reason: 'PQ value not converted' }]);
});

test('the Epic-style fixture converts (template order) and lists what it cannot import yet', () => {
  const out = convertCcdaLocal(EPIC);
  accounted(EPIC, out);
  // Shrinks as the library fixes land: sections (Task 4), visit diagnoses (Task 5), values (Task 7).
  expect(out.notImported).toEqual([
    { section: 'Encounters', templateId: '2.16.840.1.113883.10.20.22.4.80', entries: 1, reason: 'encounter diagnosis not converted' },
    { section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.2', entries: 1, reason: 'REAL value not converted' },
    { section: 'Patient Instructions', templateId: '2.16.840.1.113883.10.20.22.2.45', entries: 1, reason: 'section not supported by the converter' },
    { section: 'History of Present Illness', templateId: '1.3.6.1.4.1.19376.1.5.3.1.3.4', entries: 1, reason: 'section not supported by the converter' },
    { section: 'Reason for Referral', templateId: '1.3.6.1.4.1.19376.1.5.3.1.3.1', entries: 1, reason: 'section not supported by the converter' },
    { section: 'Insurance', templateId: '2.16.840.1.113883.10.20.22.2.18', entries: 1, reason: 'section not supported by the converter' },
  ]);
  const types = out.resources.map((r) => r.resourceType);
  expect(types).toContain('MedicationRequest'); // Epic lists Medications' entries-optional root first: no throw
  const [cond] = out.resources.filter((r) => r.resourceType === 'Condition') as Condition[];
  expect(cond.category?.[0].coding?.[0].code).toBe('problem-list-item'); // repair, by the problem observation id
  // The document id keys the Composition, so a re-issued document updates it instead of adding a second one.
  expect((out.resources.find((r) => r.resourceType === 'Composition') as Composition).identifier).toEqual({ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.8.688883.900001', value: 'EPICSTYLE-DOC-1' });
});

test('a binary ED value (no FHIR value type) is named; a text one is converted', () => {
  const pdf = convertCcdaLocal(EPIC.replace('<value xsi:type="ED"><reference value="#res3"/></value>', '<value xsi:type="ED" mediaType="application/pdf" representation="B64">JVBERi0=</value>'));
  expect(pdf.notImported).toContainEqual({ section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.2', entries: 1, reason: 'ED value not converted' });
});

const cfgFor = (patientId: string, o: Partial<GaConfig> = {}): GaConfig => ({ patientId, converterUrl: 'http://127.0.0.1:9/', ...o });
const writeDoc = (xml: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'ga-ccda-')), 'doc.xml');
  writeFileSync(f, xml);
  return f;
};

test('a later document repeating an entry updates it', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const cfg = cfgFor(pid, { ccdaConverter: 'medplum' });
    await importPath(client, cfg, writeDoc(SYNTHETIC), pid);
    // The same document re-issued later: the hyperlipidemia problem (same entry ids) now resolved.
    const later = SYNTHETIC.replaceAll('20240315120000-0500', '20240701120000-0500')
      .replaceAll('<effectiveTime><low value="20220601"/></effectiveTime>', '<effectiveTime><low value="20220601"/><high value="20240601"/></effectiveTime>');
    const r = await importPath(client, cfg, writeDoc(later), pid);
    expect(r).toMatchObject({ created: 0, invalid: 0 });
    expect(r.updated).toBeGreaterThanOrEqual(1);
    const conds = (await client.searchResources('Condition', { subject: `Patient/${pid}` })).filter((c) => c.code?.coding?.some((x) => x.code === '55822004'));
    expect(conds).toHaveLength(1);
    expect(conds[0].clinicalStatus?.coding?.[0]?.code).toBe('resolved');
    // A newer summary (its own document id) repeating the same entries: only its Composition is new.
    const newer = later.replace('extension="synthetic-doc-1"', 'extension="synthetic-doc-2"').replaceAll('20240701120000-0500', '20240901120000-0500');
    const n = await importPath(client, cfg, writeDoc(newer), pid);
    expect(n).toMatchObject({ created: 1, invalid: 0, possibleDuplicates: 0 });
    expect(n.updated).toBeGreaterThanOrEqual(1);
    // Known gap: the library gives the Composition no subject (fix with the CareTeam's, below).
    expect(await client.searchResources('Composition', { _tag: 'urn:ga-server:tag|src-ccda' })).toHaveLength(2);
    expect((await client.searchResources('Condition', { subject: `Patient/${pid}` })).filter((c) => c.code?.coding?.some((x) => x.code === '55822004'))).toHaveLength(1);
  });
});

test('the Epic-style fixture imports with no record refused, and a re-import changes nothing', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const cfg = cfgFor(pid);
    const file = writeDoc(EPIC);
    const first = await importPath(client, cfg, file, pid);
    expect(first).toMatchObject({ invalid: 0, possibleDuplicates: 0 });
    expect(first.created).toBeGreaterThan(0);
    expect(first.notImported?.map((n) => n.section)).toContain('Insurance');
    expect(await importPath(client, cfg, file, pid)).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
    // Known gap: the library gives a CareTeam no subject, so it sits outside the patient compartment (not yet assigned to a fix task).
    const [team] = await client.searchResources('CareTeam', {});
    expect(team.subject).toBeUndefined();
  });
});

test('ccdaConverter picks medplum when the flag is set or the record has no C-CDA records, else microsoft', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    expect(await ccdaConverter(cfgFor(pid), client)).toBe('medplum');
    // Records the new path wrote are not Microsoft-era: two imports in a row both convert in process.
    await importPath(client, cfgFor(pid), writeDoc(SYNTHETIC), pid);
    expect(await ccdaConverter(cfgFor(pid), client)).toBe('medplum');
    // A Microsoft-era C-CDA record: microsoft, unless the flag says medplum.
    await client.createResource({ resourceType: 'Composition', status: 'final', type: { text: 'x' }, date: '2024-01-01', author: [{ display: 'x' }], title: 'x',
      subject: { reference: `Patient/${pid}` }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] } } as Composition);
    expect(await ccdaConverter(cfgFor(pid), client)).toBe('microsoft');
    expect(await ccdaConverter(cfgFor(pid, { ccdaConverter: 'medplum' }), client)).toBe('medplum');
    expect(await ccdaConverter(cfgFor('other'), client)).toBe('medplum'); // per patient record
    // A Microsoft-era Composition stored without a patient also counts.
    await client.createResource({ resourceType: 'Composition', status: 'final', type: { text: 'x' }, date: '2024-01-01', author: [{ display: 'x' }], title: 'x',
      meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] } } as Composition);
    expect(await ccdaConverter(cfgFor('other'), client)).toBe('microsoft');
  });
});
