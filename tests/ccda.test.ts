import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { takeLock } from '../src/lock.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { MedplumClient } from '@medplum/core';
import type { AllergyIntolerance, CareTeam, Composition, Condition, Encounter, FamilyMemberHistory, Location, Medication, MedicationStatement, Observation, Practitioner, PractitionerRole, Reference, Resource } from '@medplum/fhirtypes';
import { importResources } from '../src/engine.ts';
import type { SourceInfo } from '../src/identity.ts';
import { ccdaConverter, ccdaDate, ccdaFiles, convertCcdaLocal, custodian, importPath, repair, sectionName } from '../src/ccda.ts';
import { convertXmlToCcda } from '../vendor/medplum-ccda/index.ts';
import type { GaConfig } from '../src/config.ts';
import { onStore } from './temp-store.ts';
import { isActive, isPlanned } from '../src/current.ts';
import { labResults, labRow, type LabRow } from '../src/labs.ts';
import { vitals } from '../src/vitals.ts';
import { reviewList } from '../src/concepts-cli.ts';
import { whatsNew } from '../src/whats-new.ts';
import { doseOf, vaccineGaps } from '../src/vaccines.ts';

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

test('repair recovers statuses from the source entries', () => {
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
});

test('the Microsoft path drops its whole-document DocumentReference (storeDocument keeps the file); the in-process path keeps note DocumentReferences', async () => {
  const entry = [{ resource: { resourceType: 'DocumentReference', status: 'current', content: [] } }, { resource: { resourceType: 'Encounter', class: { code: 'AMB' } } }];
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: { resourceType: 'Bundle', type: 'batch', entry } }), { status: 200 }));
  try {
    const { convertCcdaMs } = await import('../src/ccda.ts');
    expect((await convertCcdaMs('<ClinicalDocument/>', 'http://converter/')).map((r) => r.resourceType)).toEqual(['Encounter']);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(convertCcdaLocal(EPIC).resources.filter((r) => r.resourceType === 'DocumentReference')).toHaveLength(2);
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
    const body = xml.split(`<title>${s.title}</title>`)[1].split('</section>')[0];
    const entries = (body.match(/<entry[\s>]/g) ?? []).length + (body.match(/<supply\b/g) ?? []).length; // a medication's supply is a record too
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
test('a concern act with more than one problem or allergy observation: one record each; a concern with none is still named', () => {
  const problems = SYNTHETIC.replace('</entryRelationship>\n            </act>', `</entryRelationship>${SECOND}\n            </act>`);
  const out = convertCcdaLocal(problems);
  expect(out.notImported).toEqual([]);
  expect(out.resources.filter((r) => r.resourceType === 'Condition').map((c) => (c as Condition).identifier?.[0].value)).toContain('syn-problem-x');
  const allergies = EPIC.replace('</participant>\n                </observation>\n              </entryRelationship>', `</participant>\n                </observation>\n              </entryRelationship>${SECOND}`);
  expect(convertCcdaLocal(allergies).resources.filter((r) => r.resourceType === 'AllergyIntolerance')).toHaveLength(2);
  // The second observation's value (a problem code) is no allergy type: named, never a silent food allergy.
  expect(convertCcdaLocal(allergies).notImported.filter((n) => n.section === 'Allergies')).toEqual([
    { section: 'Allergies', templateId: '2.16.840.1.113883.10.20.22.4.7', entries: 1, reason: 'allergy type not converted' },
  ]);
  // Two records from one act must not hide an act that made none.
  const empty = '<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/></act></entry>';
  expect(convertCcdaLocal(problems.replace('<text>Hyperlipidemia</text>', `<text>Hyperlipidemia</text>${empty}`)).notImported).toEqual([
    { section: 'Problems', templateId: '2.16.840.1.113883.10.20.22.2.5.1', entries: 1, reason: 'entry produced no record' },
  ]);
});

test('a result organizer component the library does not read (an act) is named', () => {
  const proc = '<component><act classCode="ACT" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.6.1"/></act></component>';
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
  // Everything is imported: sections (Task 4), visit diagnoses (Task 5), values (Task 7).
  expect(out.notImported).toEqual([]);
  // The REAL value (medplum#11241): a unitless number, no UCUM claim.
  expect(out.resources.find((r) => r.resourceType === 'Observation' && JSON.stringify(r).includes('EX-RES-2'))).toMatchObject({ valueQuantity: { value: 1.1 } });
  // A coded ordinal (dipstick Negative) is a code, as on the Microsoft path, not an empty quantity.
  expect(out.resources.find((r) => r.resourceType === 'Observation' && JSON.stringify(r).includes('EX-RES-4'))).toMatchObject({ valueCodeableConcept: { coding: [{ code: 'LA6577-6' }] } });
  // The result's interpretation, in the system the Microsoft path and FHIR use.
  expect(out.resources.find((r) => r.resourceType === 'Observation' && JSON.stringify(r).includes('EX-RES-1'))).toMatchObject({
    interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'N', display: 'Normal' }] }],
  });
  const types = out.resources.map((r) => r.resourceType);
  expect(types).toContain('MedicationStatement'); // Epic lists Medications' entries-optional root first: no throw
  const [cond] = out.resources.filter((r) => r.resourceType === 'Condition') as Condition[];
  expect(cond.category?.[0].coding?.[0].code).toBe('problem-list-item');
  // The document id keys the Composition, so a re-issued document updates it instead of adding a second one.
  expect((out.resources.find((r) => r.resourceType === 'Composition') as Composition).identifier).toEqual({ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.8.688883.900001', value: 'EPICSTYLE-DOC-1' });
});

test('encounter diagnoses become Conditions linked to their encounter', () => {
  // A second diagnosis act on the fixture's one encounter.
  const act = EPIC.slice(EPIC.indexOf('<entryRelationship typeCode="SUBJ">\n                <act'), EPIC.indexOf('</encounter>'));
  const two = EPIC.replace('</encounter>', `${act.replace('EX-VISITDX-1', 'EX-VISITDX-2').replace('code="36971009"', 'code="195662009"')}</encounter>`);
  const out = convertCcdaLocal(two);
  const [enc] = out.resources.filter((r) => r.resourceType === 'Encounter');
  const dx = (out.resources.filter((r) => r.resourceType === 'Condition') as Condition[]).filter((c) => c.category?.[0].coding?.[0].code === 'encounter-diagnosis');
  expect(dx.map((c) => c.identifier?.[0].value)).toEqual(['EX-VISITDX-1', 'EX-VISITDX-2']);
  expect(dx.map((c) => c.encounter?.reference)).toEqual([`Encounter/${enc.id}`, `Encounter/${enc.id}`]);
  expect(dx.map((c) => c.clinicalStatus?.coding?.[0].code)).toEqual(['resolved', 'resolved']); // the diagnosis act is completed (library, PATCHES row 53)
  expect(out.notImported.filter((n) => n.section === 'Encounters')).toEqual([]);
  // A visit diagnosis reusing a problem-list observation id stays a visit diagnosis; the problem stays on the list.
  const reused = convertCcdaLocal(EPIC.replace('768076.2" extension="EX-VISITDX-1"', '768076.1" extension="EX-PROBLEM-1"'));
  expect((reused.resources.filter((r) => r.resourceType === 'Condition') as Condition[]).map((c) => [c.category?.[0].coding?.[0].code, !!c.encounter]))
    .toEqual([['problem-list-item', false], ['encounter-diagnosis', true]]);
  // A diagnosis observation the library does not read (not SUBJ) is named.
  const comp = EPIC.replace('                  <entryRelationship typeCode="SUBJ">\n                    <observation', '                  <entryRelationship typeCode="COMP">\n                    <observation');
  expect(convertCcdaLocal(comp).notImported.filter((n) => n.section === 'Encounters')).toEqual([
    { section: 'Encounters', templateId: '2.16.840.1.113883.10.20.22.4.80', entries: 1, reason: 'encounter diagnosis not converted' },
  ]);
});

test('a Health Concern is a visit diagnosis, not a problem-list item, so it is not a current problem (as on the Microsoft path)', () => {
  const doc = SYNTHETIC.replace('<templateId root="2.16.840.1.113883.10.20.22.2.5.1" extension="2015-08-01"/>\n          <code code="11450-4" codeSystem="2.16.840.1.113883.6.1" displayName="Problem list"/>',
    '<templateId root="2.16.840.1.113883.10.20.22.2.58" extension="2015-08-01"/>\n          <code code="75310-3" codeSystem="2.16.840.1.113883.6.1" displayName="Health concerns document"/>');
  expect(doc).not.toBe(SYNTHETIC);
  const conds = convertCcdaLocal(doc).resources.filter((r) => r.resourceType === 'Condition') as Condition[];
  expect(conds.length).toBeGreaterThan(0);
  for (const c of conds) expect(c.category?.flatMap((x) => x.coding?.map((y) => y.code))).toEqual(['encounter-diagnosis']);
});

test('a TS or BL value that does not parse is named; one in another case or with a nullFlavor is converted', () => {
  const inr = (v: string) => {
    const out = convertCcdaLocal(EPIC.replace('<value xsi:type="REAL" value="1.1"/>', v));
    return { notImported: out.notImported, obs: out.resources.find((r): r is Observation => r.resourceType === 'Observation' && JSON.stringify(r.identifier).includes('EX-RES-2')) };
  };
  for (const [v, type] of [['<value xsi:type="TS" value="garbage"/>', 'TS'], ['<value xsi:type="BL" value="yes"/>', 'BL']]) {
    const { notImported, obs } = inr(v);
    expect(notImported).toEqual([{ section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.2', entries: 1, reason: `${type} value not converted` }]);
    expect([obs?.valueDateTime, obs?.valueBoolean]).toEqual([undefined, undefined]);
  }
  expect(inr('<value xsi:type="BL" value="TRUE"/>')).toMatchObject({ notImported: [], obs: { valueBoolean: true } });
  expect(inr('<value xsi:type="TS" nullFlavor="UNK"/>')).toMatchObject({ notImported: [], obs: { dataAbsentReason: { coding: [{ code: 'unknown' }] } } });
});

test('TS and BL values are converted (valueDateTime, valueBoolean), not named; lab rows show them', () => {
  for (const [v, field, row] of [['<value xsi:type="TS" value="20240101"/>', 'valueDateTime', '2024-01-01'], ['<value xsi:type="BL" value="true"/>', 'valueBoolean', 'true']] as const) {
    const out = convertCcdaLocal(EPIC.replace('<value xsi:type="REAL" value="1.1"/>', v));
    expect(out.notImported).toEqual([]);
    const inr = out.resources.find((r): r is Observation => r.resourceType === 'Observation' && JSON.stringify(r.identifier).includes('EX-RES-2'));
    expect(inr?.[field]).toBeDefined();
    expect(labRow(inr as Observation).value).toBe(row);
  }
});

test('a binary ED value (no FHIR value type) is named; a text one is converted', () => {
  const pdf = convertCcdaLocal(EPIC.replace('<value xsi:type="ED"><reference value="#res3"/></value>', '<value xsi:type="ED" mediaType="application/pdf" representation="B64">JVBERi0=</value>'));
  expect(pdf.notImported).toContainEqual({ section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.2', entries: 1, reason: 'ED value not converted' });
});

test('care team: every member and performer is a participant; a member without performer or a non-act component is named', () => {
  const second = '<component><act classCode="PCPR" moodCode="EVN"><code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>'
    + '<performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="1111111111"/></assignedEntity></performer>'
    + '<performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="2222222222"/></assignedEntity></performer></act></component>'
    + '<component><act classCode="PCPR" moodCode="EVN"><code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/></act></component>'
    + '<component><observation classCode="OBS" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/></observation></component>';
  const out = convertCcdaLocal(EPIC.replace('</act>\n              </component>\n            </organizer>', `</act>\n              </component>${second}\n            </organizer>`));
  const team = out.resources.find((r) => r.resourceType === 'CareTeam') as CareTeam;
  expect(team.participant).toHaveLength(3);
  expect(out.notImported).toEqual(expect.arrayContaining([
    { section: 'Care Team', templateId: '2.16.840.1.113883.10.20.22.4.500', entries: 1, reason: 'care team member without performer' },
    { section: 'Care Team', templateId: '2.16.840.1.113883.10.20.22.4.500', entries: 1, reason: 'organizer component not converted' },
  ]));
});

test('payers: one Coverage per policy; a guarantor and the policy holder\'s own details are named', () => {
  const extra = '<performer typeCode="PRF"><templateId root="2.16.840.1.113883.10.20.22.4.88"/><assignedEntity><id nullFlavor="NI"/><code code="GUAR" codeSystem="2.16.840.1.113883.5.111"/></assignedEntity></performer>'
    + '<participant typeCode="HLD"><participantRole><id root="2.25.1" extension="S-1"/><playingEntity><name><given>Holder</given></name></playingEntity></participantRole></participant>';
  const second = '<entryRelationship typeCode="COMP"><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.61"/><id root="2.25.2" extension="EX-POLICY-2"/><code code="HMO" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/></act></entryRelationship>';
  const xml = EPIC.replace('<code code="PPO" codeSystem="2.16.840.1.113883.5.4" displayName="Preferred provider organization policy"/>\n                  <statusCode code="completed"/>',
    `<code code="PPO" codeSystem="2.16.840.1.113883.5.4" displayName="Preferred provider organization policy"/>\n                  <statusCode code="completed"/>${extra}`)
    .replace('</entryRelationship>\n            </act>\n          </entry>\n        </section>\n      </component>\n      <!-- Plan', `</entryRelationship>${second}\n            </act>\n          </entry>\n        </section>\n      </component>\n      <!-- Plan`);
  const out = convertCcdaLocal(xml);
  expect(out.resources.filter((r) => r.resourceType === 'Coverage')).toHaveLength(2);
  expect(out.notImported.filter((n) => n.section === 'Insurance')).toEqual([
    { section: 'Insurance', templateId: '2.16.840.1.113883.10.20.22.4.61', entries: 1, reason: 'guarantor not converted' },
    { section: 'Insurance', templateId: '2.16.840.1.113883.10.20.22.4.61', entries: 1, reason: 'policy holder details not converted' },
  ]);
  // A coverage act without a policy produced no record.
  const none = convertCcdaLocal(EPIC.replace(/<entryRelationship typeCode="COMP">\s*<act classCode="ACT" moodCode="EVN">\s*<templateId root="2.16.840.1.113883.10.20.22.4.61"\/>[\s\S]*?<\/entryRelationship>/, ''));
  expect(none.notImported).toContainEqual({ section: 'Insurance', templateId: '2.16.840.1.113883.10.20.22.2.18', entries: 1, reason: 'section not supported by the converter' });
});

test('goals and plan of care: an observation value the goal or request path cannot read, and child observations, are named', () => {
  const planned = EPIC.replace('<code code="24323-8" codeSystem="2.16.840.1.113883.6.1" displayName="Comprehensive metabolic panel"/>\n              <statusCode code="active"/>',
    '<code code="24323-8" codeSystem="2.16.840.1.113883.6.1" displayName="Comprehensive metabolic panel"/>\n              <statusCode code="active"/><value xsi:type="PQ" value="5" unit="kg"/>'
    + '<entryRelationship typeCode="RSON"><observation classCode="OBS" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/></observation></entryRelationship>');
  // The fixture's planned CMP (moodCode RQO) is a ServiceRequest: it holds no value or child observation.
  expect(convertCcdaLocal(planned).notImported.filter((n) => n.section === 'Plan of Treatment')).toEqual([
    { section: 'Plan of Treatment', templateId: '2.16.840.1.113883.10.20.22.4.44', entries: 1, reason: 'PQ value not converted' },
    { section: 'Plan of Treatment', templateId: '2.16.840.1.113883.10.20.22.4.44', entries: 1, reason: 'observation in planned request not converted' },
  ]);
  // The same observation as a goal (moodCode GOL) is a Goal: it reads only coded or text values and no child observation.
  const goal = planned.replace('<observation classCode="OBS" moodCode="RQO">', '<observation classCode="OBS" moodCode="GOL">');
  expect(convertCcdaLocal(goal).notImported.filter((n) => n.section === 'Plan of Treatment')).toEqual([
    { section: 'Plan of Treatment', templateId: '2.16.840.1.113883.10.20.22.4.44', entries: 1, reason: 'PQ value not converted' },
    { section: 'Plan of Treatment', templateId: '2.16.840.1.113883.10.20.22.4.44', entries: 1, reason: 'observation in goal not converted' },
  ]);
});

test('family history: a relative\'s condition is a FamilyMemberHistory, never the patient\'s own Observation; what it cannot hold is named', () => {
  const out = convertCcdaLocal(EPIC);
  const [fh] = out.resources.filter((r) => r.resourceType === 'FamilyMemberHistory') as FamilyMemberHistory[];
  expect(fh).toMatchObject({
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.778100', value: 'EX-FH-1' }],
    relationship: { coding: [{ code: 'FTH' }] },
    sex: { coding: [{ system: 'http://hl7.org/fhir/administrative-gender', code: 'male' }] },
    condition: [{ code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003' }] }, onsetAge: { value: 60, code: 'a' } }],
    bornDate: '1940-03-15', // the Microsoft path's bornString
    deceasedDate: '2010-06-01',
  });
  // An age at onset and the observation's own time: FHIR has one onset, the age; the time is named.
  const timed = EPIC.replace('<value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96" displayName="Hypertension"/>\n                  <entryRelationship',
    '<effectiveTime value="20000101"/><value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96" displayName="Hypertension"/>\n                  <entryRelationship');
  expect(convertCcdaLocal(timed).notImported).toEqual([{ section: 'Family History', templateId: '2.16.840.1.113883.10.20.22.4.46', entries: 1, reason: 'family history onset date not converted' }]);
  // An age with no number is no onset: the time is the onset, nothing named.
  const ageless = timed.replace('<value xsi:type="PQ" value="60" unit="a"/>', '<value xsi:type="PQ" nullFlavor="UNK"/>');
  expect(convertCcdaLocal(ageless).notImported).toEqual([]);
  expect((convertCcdaLocal(ageless).resources.find((r) => r.resourceType === 'FamilyMemberHistory') as FamilyMemberHistory).condition?.[0].onsetPeriod).toEqual({ start: '2000-01-01' });
  // A death time beside deceasedInd="false" contradicts it: kept out of the record, and named.
  const alive = EPIC.replace(/<sdtc:deceasedInd value="true"\/>/, '<sdtc:deceasedInd value="false"/>');
  expect((convertCcdaLocal(alive).resources.find((r) => r.resourceType === 'FamilyMemberHistory') as FamilyMemberHistory).deceasedBoolean).toBe(false);
  expect(convertCcdaLocal(alive).notImported).toEqual([{ section: 'Family History', templateId: '2.16.840.1.113883.10.20.22.4.45', entries: 1, reason: 'family history death date not converted' }]);
  expect(out.resources.some((r) => r.resourceType === 'Observation' && /445518008|64572001/.test(JSON.stringify(r)))).toBe(false);
  // A negated condition (FHIR has none) and a related observation other than age at onset or death are named.
  const xml = EPIC.replace('<observation classCode="OBS" moodCode="EVN">\n                  <templateId root="2.16.840.1.113883.10.20.22.4.46"/>', '<observation classCode="OBS" moodCode="EVN" negationInd="true">\n                  <templateId root="2.16.840.1.113883.10.20.22.4.46"/>');
  expect(convertCcdaLocal(xml).notImported).toEqual([{ section: 'Family History', templateId: '2.16.840.1.113883.10.20.22.4.46', entries: 1, reason: 'family history observation not converted' }]);
  const note = '<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN"><code code="1" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/><value xsi:type="ST">x</value></observation></entryRelationship>';
  expect(convertCcdaLocal(EPIC.replace('<value xsi:type="PQ" value="60" unit="a"/>\n                    </observation>\n                  </entryRelationship>', `<value xsi:type="PQ" value="60" unit="a"/>\n                    </observation>\n                  </entryRelationship>${note}`)).notImported)
    .toEqual([{ section: 'Family History', templateId: '2.16.840.1.113883.10.20.22.4.46', entries: 1, reason: 'family history detail not converted' }]);
});

test('social history, functional status and reason for visit each keep their own category, never vital-signs; social history is dated', () => {
  const out = convertCcdaLocal(EPIC);
  const obs = (id: string) => out.resources.find((r): r is Observation => r.resourceType === 'Observation' && JSON.stringify(r.identifier).includes(id));
  const cats = (id: string) => obs(id)?.category?.map((c) => c.coding?.[0].code);
  expect(cats('EX-SMOKING-1')).toEqual(['social-history']);
  expect(cats('EX-ALCOHOL-1')).toEqual(['social-history']); // a vendor template only: its section says so
  expect(cats('EX-FUNC-1')).toEqual(['survey']);
  expect(cats('EX-RFV-1')).toEqual(['29299-5']); // nothing classifies it: its section's code (Reason for visit)
  expect(obs('EX-ALCOHOL-1')?.effectiveDateTime).toBe('2024-02-10'); // <low> only (medplum#11244)
  expect(obs('EX-TOBACCO-1')?.effectivePeriod).toEqual({ start: '2000-01-01', end: '2010-01-01' });
});

test('an INT value is a unitless quantity, as on the Microsoft path, so GA\'s readers show it', () => {
  const sdoh = convertCcdaLocal(EPIC).resources.find((r): r is Observation => r.resourceType === 'Observation' && JSON.stringify(r.identifier).includes('EX-SDOH-1'));
  expect(sdoh).toMatchObject({ valueQuantity: { value: 3 } });
  expect(sdoh?.valueInteger).toBeUndefined();
  expect(labRow(sdoh as Observation).value).toBe('3');
  expect(sdoh?.category?.map((c) => c.coding?.[0].code)).toEqual(['survey', 'social-history']);
});

test('an observation with a value but no code is imported (its code data-absent); one with neither is named', () => {
  const child = (value: string) => `<entryRelationship typeCode="COMP"><observation classCode="OBS" moodCode="EVN"><code nullFlavor="UNK"/><statusCode code="completed"/>${value}</observation></entryRelationship>`;
  const xml = (value: string) => EPIC.replace('<value xsi:type="ST">Not currently</value>', `<value xsi:type="ST">Not currently</value>${child(value)}`);
  const kept = convertCcdaLocal(xml('<value xsi:type="ST">Lives alone</value>'));
  expect(kept.notImported).toEqual([]);
  expect(kept.resources.some((r) => r.resourceType === 'Observation' && (r as Observation).valueString === 'Lives alone')).toBe(true);
  expect(convertCcdaLocal(xml('')).notImported).toEqual([{ section: 'Social History', entries: 1, reason: 'observation without a code' }]);
});

test('every section of the Epic-style fixture is imported', () => {
  const out = convertCcdaLocal(EPIC);
  const comp = out.resources.find((r) => r.resourceType === 'Composition') as Composition;
  const byRef = new Map(out.resources.map((r) => [`${r.resourceType}/${r.id}`, r]));
  const made = Object.fromEntries((comp.section ?? []).map((s) => [s.title, [...new Set((s.entry ?? []).map((e) => byRef.get(e.reference ?? '')?.resourceType))]]));
  expect(made).toEqual({
    'Problem List': ['Condition'], Encounters: ['Encounter'], 'Family History': ['FamilyMemberHistory'], Medications: ['MedicationStatement', 'MedicationRequest'], Results: ['DiagnosticReport'], 'Vital Signs': ['Observation'],
    Immunizations: ['Immunization'], Allergies: ['AllergyIntolerance'], 'Social History': ['Observation'], 'Functional Status': ['Observation'],
    'Patient Instructions': ['DocumentReference'], 'History of Present Illness': ['DocumentReference'], 'Reason for Referral': ['ServiceRequest'],
    'Reason for Visit': ['Observation'], Insurance: ['Coverage'], 'Plan of Treatment': ['CarePlan', 'ServiceRequest'], 'Care Team': ['CareTeam'],
  });
  expect(out.notImported).toEqual([]);
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

test('a newer summary that numbers its narrative anchors anew adds only its Composition (id-less entries key alike)', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const cfg = cfgFor(pid, { ccdaConverter: 'medplum' });
    // An id-less allergy whose text is a narrative anchor (Epic's "no known allergies" entry has no id)
    const xml = EPIC.replace('<text>Example drug allergy</text>', '<text><content ID="al1">Example drug allergy</content></text>')
      .replace(/<id root="1\.2\.840\.114350\.1\.13\.999\.2\.7\.2\.768987(\.1)?" extension="EX-ALLERGY-(OBS-)?1"\/>/g, '')
      .replace('<code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>', '<code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><text><reference value="#al1"/></text>');
    await importPath(client, cfg, writeDoc(xml), pid);
    expect(await client.searchResources('AllergyIntolerance', { patient: `Patient/${pid}` })).toHaveLength(1);
    const newer = xml.replace('extension="EPICSTYLE-DOC-1"', 'extension="EPICSTYLE-DOC-2"').replaceAll('ID="', 'ID="n2-').replaceAll('value="#', 'value="#n2-');
    expect(await importPath(client, cfg, writeDoc(newer), pid)).toMatchObject({ created: 1, invalid: 0, possibleDuplicates: 0 });
    expect(await client.searchResources('AllergyIntolerance', { patient: `Patient/${pid}` })).toHaveLength(1);
  });
});

test('a section title with markup: its note is imported, not refused', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const xml = EPIC.replace('<title>Patient Instructions</title>', '<title>Patient <content styleCode="Bold">Instructions</content></title>');
    expect(await importPath(client, cfgFor(pid), writeDoc(xml), pid)).toMatchObject({ invalid: 0 });
    const notes = await client.searchResources('DocumentReference', { subject: `Patient/${pid}` });
    expect(notes.map((d) => d.content[0].attachment.title)).toContain('Patient Instructions');
  });
});

test('a section title with markup is named as plain text, in order', () => {
  const xml = EPIC.replace('<title>Insurance</title>', '<title>Insurance <content>for</content> Visit &amp; Plan</title>');
  const sections = (convertXmlToCcda(xml).component?.structuredBody?.component ?? []).flatMap((c) => c.section);
  expect(sections.map(sectionName)).toContain('Insurance for Visit & Plan');
});

test('the Epic-style fixture imports with no record refused, and a re-import changes nothing', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const cfg = cfgFor(pid);
    const file = writeDoc(EPIC);
    const first = await importPath(client, cfg, file, pid);
    expect(first).toMatchObject({ invalid: 0, possibleDuplicates: 0 });
    expect(first.created).toBeGreaterThan(0);
    expect(first.notImported).toEqual([]);
    const visitDx = async () => (await client.searchResources('Condition', { subject: `Patient/${pid}` })).filter((c) => c.category?.[0]?.coding?.[0]?.code === 'encounter-diagnosis');
    const [enc] = await client.searchResources('Encounter', { subject: `Patient/${pid}` });
    expect((await visitDx()).map((c) => c.encounter?.reference)).toEqual([`Encounter/${enc.id}`]);
    expect(await client.searchResources('FamilyMemberHistory', { patient: `Patient/${pid}` })).toHaveLength(1);
    // The result panel is a report whose results are the stored lab Observations.
    const [report] = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` });
    const labs = await client.searchResources('Observation', { subject: `Patient/${pid}`, category: 'laboratory' });
    expect(report.result?.map((r) => r.reference).sort()).toEqual(labs.map((o) => `Observation/${o.id}`).sort());
    expect(labs).toHaveLength(4);
    const [coverage] = await client.searchResources('Coverage', {});
    expect(coverage.beneficiary.reference).toBe(`Patient/${pid}`);
    expect(await importPath(client, cfg, file, pid)).toMatchObject({ created: 0, updated: 0, invalid: 0, possibleDuplicates: 0 });
    // A newer summary repeating the visit: still one visit diagnosis, pointing at the one stored Encounter.
    await importPath(client, cfg, writeDoc(EPIC.replace('EPICSTYLE-DOC-1', 'EPICSTYLE-DOC-2')), pid);
    expect(await client.searchResources('Encounter', { subject: `Patient/${pid}` })).toHaveLength(1);
    expect((await visitDx()).map((c) => c.encounter?.reference)).toEqual([`Encounter/${enc.id}`]);
    // The CareTeam and the Composition are in the patient's compartment.
    expect(await client.searchResources('CareTeam', { subject: `Patient/${pid}` })).toHaveLength(1);
    expect(await client.searchResources('Composition', { subject: `Patient/${pid}` })).toHaveLength(2);
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

test('a taking entry stays a MedicationStatement with its source id and name', () => {
  const meds = convertCcdaLocal(EPIC).resources.filter((r) => /^Medication/.test(r.resourceType));
  expect(meds.map((r) => r.resourceType)).toEqual(['MedicationStatement', 'MedicationRequest']); // the request: its supply order
  expect(meds[0]).toMatchObject({
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.798268', value: 'EX-MED-1' }],
    status: 'active',
    effectivePeriod: { start: '2023-01-15' },
    // The narrative's name (what the clinician sees), RxNorm kept.
    medicationCodeableConcept: { text: 'examplepril 10 mg tablet', coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076' }] },
  });
});

test('a negated medication list entry (negationInd, statusCode active) stays not-taken and is not a current medication', () => {
  const doc = EPIC.replace('<substanceAdministration classCode="SBADM" moodCode="EVN">', '<substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="true">');
  const st = convertCcdaLocal(doc).resources.find((r) => r.resourceType === 'MedicationStatement') as MedicationStatement;
  expect(st.status).toBe('not-taken');
  expect(isActive(st)).toBe(false);
});

test('a medication list entry in INT mood is a MedicationStatement too, with its source id and status', () => {
  const meds = convertCcdaLocal(SYNTHETIC).resources.filter((r) => /^Medication/.test(r.resourceType));
  expect(meds.map((r) => r.resourceType)).toEqual(['MedicationStatement']); // moodCode INT, as the Microsoft path files it
  expect(meds[0]).toMatchObject({ identifier: [{ system: 'urn:oid:2.25.5001', value: 'syn-med-1' }], status: 'active', effectivePeriod: { start: '2023-01-01' } });
  const stopped = convertCcdaLocal(SYNTHETIC.replace('<statusCode code="active"/>\n              <effectiveTime xsi:type="IVL_TS"><low value="20230101"/>', '<statusCode code="aborted"/>\n              <effectiveTime xsi:type="IVL_TS"><low value="20230101"/>'));
  expect(stopped.resources.find((r) => r.resourceType === 'MedicationStatement')).toMatchObject({ status: 'stopped' });
});

test('a supply order inside a medication (the Microsoft path\'s extra orders) is a MedicationRequest named like its medication', () => {
  const { resources, notImported } = convertCcdaLocal(EPIC);
  const order = resources.find((r) => r.resourceType === 'MedicationRequest');
  expect(order).toMatchObject({
    identifier: [{ system: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.798268.1', value: 'EX-ORDER-1' }],
    status: 'completed',
    intent: 'order',
    medicationCodeableConcept: { text: 'examplepril 10 mg tablet', coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076' }] },
    dispenseRequest: { numberOfRepeatsAllowed: 3, quantity: { value: 90 } },
  });
  expect(notImported.filter((n) => n.section === 'Medications')).toEqual([]);
  // A supply the library does not read (an immunization's) is named, not silently skipped.
  const vaccineSupply = EPIC.replace(/(<substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">[\s\S]*?)(<\/substanceAdministration>)/,
    '$1<entryRelationship typeCode="REFR"><supply classCode="SPLY" moodCode="INT"><id root="2.25.9" extension="vx-order"/></supply></entryRelationship>$2');
  expect(vaccineSupply).not.toBe(EPIC);
  expect(convertCcdaLocal(vaccineSupply).notImported).toContainEqual(expect.objectContaining({ section: 'Immunizations', entries: 1, reason: 'entry produced no record' }));
});

test('a supply order that reuses its medication\'s id is still stored next to the medication', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const xml = EPIC.replace('<id root="1.2.840.114350.1.13.999.2.7.2.798268.1" extension="EX-ORDER-1"/>', '<id root="1.2.840.114350.1.13.999.2.7.2.798268" extension="EX-MED-1"/>');
    expect(xml).not.toBe(EPIC);
    expect(await importPath(client, cfgFor(pid), writeDoc(xml), pid)).toMatchObject({ invalid: 0, possibleDuplicates: 0 });
    const stored = async (type: 'MedicationStatement' | 'MedicationRequest') => (await client.searchResources(type, { subject: `Patient/${pid}` })).length;
    expect([await stored('MedicationStatement'), await stored('MedicationRequest')]).toEqual([1, 1]);
  });
});

test('a planned medication and its supply order sharing one id are both stored', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const med = /<substanceAdministration classCode="SBADM" moodCode="EVN">[\s\S]*?<\/substanceAdministration>/.exec(EPIC)?.[0] as string;
    const planned = med.replace('moodCode="EVN"', 'moodCode="INT"').replace('<id root="1.2.840.114350.1.13.999.2.7.2.798268.1" extension="EX-ORDER-1"/>', '<id root="1.2.840.114350.1.13.999.2.7.2.798268" extension="EX-MED-1"/>');
    const xml = EPIC.replace(/(<title>Plan of Treatment<\/title>[\s\S]*?<\/text>)/, `$1<entry>${planned}</entry>`);
    expect(xml).not.toBe(EPIC);
    expect(await importPath(client, cfgFor(pid), writeDoc(xml), pid)).toMatchObject({ invalid: 0 });
    const requests = await client.searchResources('MedicationRequest', { subject: `Patient/${pid}` });
    expect(requests.map((r) => r.identifier?.find((i) => i.value === 'EX-MED-1') && r.dispenseRequest?.quantity?.value).sort()).toEqual([90, undefined, undefined]);
    // Stored with the C-CDA tag: the planned medication and its order are not current medications.
    expect(requests.filter((r) => r.identifier?.some((i) => i.value === 'EX-MED-1')).map(isPlanned)).toEqual([true, true]);
  });
});

test('a dispense is named from the narrative like its medication', () => {
  const xml = EPIC.replace('<supply classCode="SPLY" moodCode="INT">', '<supply classCode="SPLY" moodCode="EVN">');
  expect(xml).not.toBe(EPIC);
  const dispense = convertCcdaLocal(xml).resources.find((r) => r.resourceType === 'MedicationDispense');
  expect(dispense).toMatchObject({ medicationCodeableConcept: { text: 'examplepril 10 mg tablet', coding: [{ code: '314076' }] } });
});

test('GA\'s readers read the in-process output: lab rows with values, units, interpretation and dates; blood pressure as one reading', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    await importPath(client, cfgFor(pid), writeDoc(EPIC), pid);
    const labs = (await labResults(client, pid, {})).rows as LabRow[];
    expect(labs.map(({ date, name, value, range, interpretation }) => ({ date, name, value, range, interpretation }))).toEqual(expect.arrayContaining([
      { date: '2024-02-10', name: 'Glucose', value: '95 mg/dL', range: '70–99 mg/dL', interpretation: 'N' },
      { date: '2024-02-10', name: 'INR', value: '1.1', range: undefined, interpretation: undefined },
      { date: '2024-02-10', name: 'Appearance of Urine', value: 'Specimen looks normal.', range: undefined, interpretation: undefined },
      { date: '2024-02-10', name: 'Protein [Presence] in Urine by Test strip', value: 'Negative', range: undefined, interpretation: undefined },
    ]));
    expect(labs).toHaveLength(4); // the panel is a report, not an empty lab row
    const { rows } = await vitals(client, pid, {});
    expect(rows.map(({ name, value, date }) => ({ name, value, date }))).toEqual([{ name: 'Blood pressure', value: 'Systolic: 128 mm[Hg]; Diastolic: 82 mm[Hg]', date: '2024-02-10' }]);
  });
});

test('an uncoded observation with a value is stored, reviewed and read without a name', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const child = '<entryRelationship typeCode="COMP"><observation classCode="OBS" moodCode="EVN"><code nullFlavor="UNK"/><statusCode code="completed"/><value xsi:type="ST">Lives alone</value></observation></entryRelationship>';
    const report = await importPath(client, cfgFor(pid), writeDoc(EPIC.replace('<value xsi:type="ST">Not currently</value>', `<value xsi:type="ST">Not currently</value>${child}`)), pid);
    expect(report).toMatchObject({ invalid: 0, notImported: [] });
    expect(report.unmapped.every((u) => !!u.name)).toBe(true);
    const [o] = (await client.searchResources('Observation', { subject: `Patient/${pid}` })).filter((x) => x.valueString === 'Lives alone');
    expect(o.code.extension?.[0].valueCode).toBe('unknown');
    expect(labRow(o).value).toBe('Lives alone');
    expect((await reviewList(client, pid, 'unmapped')).every((u) => !!u.name)).toBe(true);
    const news = await whatsNew(client, pid, Promise.resolve([]), { dir: mkdtempSync(join(tmpdir(), 'ga-wn-')), fetch: async () => new Response('{}', { status: 404 }) });
    expect(news).toBeDefined();
  });
});

test('vaccine_gaps counts a converted immunization by its CVX code', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    await importPath(client, cfgFor(pid), writeDoc(EPIC), pid);
    const [imm] = await client.searchResources('Immunization', { patient: `Patient/${pid}` });
    expect(doseOf(imm)).toMatchObject({ date: '2023-10-15', cvx: '140' }); // by code, not only by name
    const flu = (await vaccineGaps(client, pid, '2024-01-01')).results.find((r) => r.vaccine === 'influenza');
    expect(flu).toMatchObject({ status: 'complete', records: [{ date: '2023-10-15' }] });
  });
});

test('allergy category follows the source: a drug allergy is medication/allergy, not food; a value outside the type value set sets neither and is named', () => {
  const allergy = (xml: string) => convertCcdaLocal(xml).resources.find((r): r is AllergyIntolerance => r.resourceType === 'AllergyIntolerance') as AllergyIntolerance;
  expect(allergy(EPIC)).toMatchObject({ category: ['medication'], type: 'allergy' }); // 416098002 Drug allergy
  const intolerance = EPIC.replace('code="416098002" codeSystem="2.16.840.1.113883.6.96" displayName="Drug allergy"', 'code="235719002" codeSystem="2.16.840.1.113883.6.96" displayName="Food intolerance"');
  expect(allergy(intolerance)).toMatchObject({ category: ['food'], type: 'intolerance' });
  const other = EPIC.replace('code="416098002" codeSystem="2.16.840.1.113883.6.96"', 'code="22298006" codeSystem="2.16.840.1.113883.6.96"');
  expect(allergy(other).category).toBeUndefined();
  expect(allergy(other).type).toBeUndefined();
  expect(convertCcdaLocal(other).notImported).toEqual([{ section: 'Allergies', templateId: '2.16.840.1.113883.10.20.22.4.7', entries: 1, reason: 'allergy type not converted' }]);
  // A generic code (propensity to adverse reaction) states neither, and loses nothing: not named.
  const generic = EPIC.replace('code="416098002" codeSystem="2.16.840.1.113883.6.96"', 'code="420134006" codeSystem="2.16.840.1.113883.6.96"');
  expect([allergy(generic).category, allergy(generic).type]).toEqual([undefined, undefined]);
  expect(convertCcdaLocal(generic).notImported).toEqual([]);
});

test('encounter has its location: the visit points at a stored Location with the clinic\'s id, name, type and address', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    expect(await importPath(client, cfgFor(pid), writeDoc(EPIC), pid)).toMatchObject({ invalid: 0 });
    const [enc] = await client.searchResources('Encounter', { subject: `Patient/${pid}` });
    const loc = await client.readReference(enc.location?.[0].location as Reference<Location>);
    expect(loc.identifier?.[0].value).toBe('EX-DEPT-1');
    expect(loc).toMatchObject({ name: 'Example Clinic', type: [{ coding: [{ code: '1160-1' }] }], address: { city: 'Testville' } });
  });
});

test('a practitioner named twice with different details is one stored Practitioner, not a content-hash split', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    // The header author again on the allergy, now with a phone number.
    const authored = EPIC.replace(/(extension="EX-ALLERGY-1"\/>[\s\S]*?<\/effectiveTime>)/, `$1<author><time value="20150401"/><assignedAuthor>
      <id root="1.2.840.114350.1.13.999.2.7.2.697780" extension="EX-PROV-1"/><telecom use="WP" value="tel:+1-555-555-0101"/>
      <assignedPerson><name><given>Example</given><family>Clinician</family></name></assignedPerson></assignedAuthor></author>`);
    expect(await importPath(client, cfgFor(pid), writeDoc(authored), pid)).toMatchObject({ invalid: 0 });
    const prov = await client.searchResources('Practitioner', { identifier: 'urn:oid:1.2.840.114350.1.13.999.2.7.2.697780|EX-PROV-1' });
    expect(prov).toHaveLength(1);
    expect(prov[0].telecom?.[0].value).toBe('+1-555-555-0101');
  });
});

test('a vaccine not given (negationInd) is stored not-done and vaccine_gaps does not count it', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    await importPath(client, cfgFor(pid), writeDoc(EPIC.replace('negationInd="false">', 'negationInd="true">')), pid);
    const [imm] = await client.searchResources('Immunization', { patient: `Patient/${pid}` });
    expect(imm.status).toBe('not-done');
    const flu = (await vaccineGaps(client, pid, '2024-01-01')).results.find((r) => r.vaccine === 'influenza');
    expect(flu).toMatchObject({ status: 'due', records: [] });
  });
});

test('a value with a nullFlavor is data-absent and not named; a number that does not parse is named, never an empty or NaN value', () => {
  const inr = (v: string) => {
    const out = convertCcdaLocal(EPIC.replace('<value xsi:type="REAL" value="1.1"/>', v));
    return { notImported: out.notImported, obs: out.resources.find((r): r is Observation => r.resourceType === 'Observation' && JSON.stringify(r.identifier).includes('EX-RES-2')) as Observation };
  };
  for (const type of ['PQ', 'REAL', 'CD', 'ST', 'INT']) {
    const { notImported, obs } = inr(`<value xsi:type="${type}" nullFlavor="UNK"/>`);
    expect(notImported).toEqual([]);
    expect(obs.dataAbsentReason?.coding?.[0].code).toBe('unknown');
    expect([obs.valueQuantity, obs.valueCodeableConcept, obs.valueString]).toEqual([undefined, undefined, undefined]);
  }
  const { notImported, obs } = inr('<value xsi:type="PQ" value="abc" unit="mg/dL"/>');
  expect(notImported).toEqual([{ section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.2', entries: 1, reason: 'PQ value not converted' }]);
  expect(obs.valueQuantity).toBeUndefined();
});

test('id-less PractitionerRoles of different practitioners stay apart on import; a re-import adds none', async () => {
  const visit = (id: string, npi: string) => `<entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="2.16.840.1.113883.19.5" extension="${id}"/><code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
    <effectiveTime value="20240102"/><performer><assignedEntity><id root="2.16.840.1.113883.4.6" extension="${npi}"/></assignedEntity></performer></encounter></entry>`;
  const xml = `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id root="2.16.840.1.113883.19.5" extension="ROLES-DOC"/>
    <recordTarget><patientRole><patient><name><given>T</given><family>P</family></name></patient></patientRole></recordTarget>
    <component><structuredBody><component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Encounters</title><text>x</text>${visit('V-1', 'NPI-A')}${visit('V-2', 'NPI-B')}</section></component></structuredBody></component></ClinicalDocument>`;
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const file = writeDoc(xml);
    await importPath(client, cfgFor(pid), file, pid);
    const who = async () => {
      const encounters = await client.searchResources('Encounter', { subject: `Patient/${pid}` });
      const npis = [];
      for (const e of encounters) {
        const role = await client.readReference(e.participant?.[0].individual as Reference<PractitionerRole>);
        const doc = await client.readReference(role.practitioner as Reference<Practitioner>);
        npis.push(doc.identifier?.[0].value);
      }
      return npis.sort();
    };
    expect(await who()).toEqual(['NPI-A', 'NPI-B']);
    expect(await importPath(client, cfgFor(pid), file, pid)).toMatchObject({ created: 0 });
    expect(await who()).toEqual(['NPI-A', 'NPI-B']);
  });
});

test('id-less CareTeams with different members stay apart on import; a re-import adds none', async () => {
  const team = (doc: string, npi: string) => `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id root="2.16.840.1.113883.19.5" extension="${doc}"/><effectiveTime value="20240102"/>
    <recordTarget><patientRole><patient><name><given>T</given><family>P</family></name></patient></patientRole></recordTarget>
    <component><structuredBody><component><section><templateId root="2.16.840.1.113883.10.20.22.2.500"/><code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Care Team</title><text>x</text><entry><organizer classCode="CLUSTER" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.500"/>
      <code code="86744-0" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="active"/>
      <component><act classCode="PCPR" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.500.1"/><code code="85847-2" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="active"/><performer typeCode="PRF"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="${npi}"/></assignedEntity></performer></act></component>
    </organizer></entry></section></component></structuredBody></component></ClinicalDocument>`;
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const [a, b] = [writeDoc(team('TEAM-DOC-1', 'NPI-A')), writeDoc(team('TEAM-DOC-2', 'NPI-B'))];
    await importPath(client, cfgFor(pid), a, pid);
    await importPath(client, cfgFor(pid), b, pid);
    expect(await client.searchResources('CareTeam', { subject: `Patient/${pid}` })).toHaveLength(2);
    expect(await importPath(client, cfgFor(pid), a, pid)).toMatchObject({ created: 0 });
    expect(await client.searchResources('CareTeam', { subject: `Patient/${pid}` })).toHaveLength(2);
  });
});

test('a C-CDA note whose Epic note id is an EHI note GA holds (same Epic org) merges into it: one record, both identifiers', async () => {
  const root = '1.2.840.114350.1.13.999.2.7.2.727879'; // a synthetic Epic org root, the note-id suffix
  const xml = `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id root="2.16.840.1.113883.19.5" extension="NOTE-DOC"/><effectiveTime value="20240210"/>
    <recordTarget><patientRole><patient><name><given>T</given><family>P</family></name></patient></patientRole></recordTarget>
    <component><structuredBody><component><section><templateId root="2.16.840.1.113883.10.20.22.2.65"/><code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Progress Notes</title><text><paragraph ID="n1">Seen today, improving.</paragraph></text>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.202"/><id root="${root}" extension="5551"/>
      <code code="34109-9" codeSystem="2.16.840.1.113883.6.1"/><text><reference value="#n1"/></text><statusCode code="completed"/><effectiveTime value="20240210"/></act></entry>
    </section></component></structuredBody></component></ClinicalDocument>`;
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    // Two EHI exports (orgs 999 and 888, told apart by their visits' Epic ids) whose notes share a NOTE_ID.
    const ehi = (org: string) => ({ meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] }, subject: { reference: `Patient/${pid}` }, system: `urn:ga-server:id:ehi:org-${org}` });
    const ehiNote = (org: string, id: string) => client.createResource({ resourceType: 'DocumentReference', status: 'current', meta: ehi(org).meta, subject: ehi(org).subject,
      identifier: [{ system: ehi(org).system, value: `HNO_INFO|${id}` }], content: [{ attachment: { contentType: 'text/plain', data: 'eA==' } }] });
    for (const org of ['999', '888']) {
      await client.createResource({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, meta: ehi(org).meta, subject: ehi(org).subject,
        identifier: [{ system: ehi(org).system, value: 'PAT_ENC|1' }, { system: `urn:oid:1.2.840.114350.1.13.${org}.2.7.3.698084.8`, value: '1' }] });
    }
    const kept = await ehiNote('999', '5551');
    const other = await ehiNote('888', '5551');
    await ehiNote('999', '5552');
    await importPath(client, cfgFor(pid), writeDoc(xml), pid);
    const notes = await client.searchResources('DocumentReference', { subject: `Patient/${pid}` });
    const merged = notes.filter((d) => d.identifier?.some((i) => i.system === `urn:oid:${root}`));
    expect(merged.map((d) => d.id)).toEqual([kept.id]); // the same org's note, never the other export's
    expect(notes.find((d) => d.id === other.id)?.identifier).toHaveLength(1);
    expect(notes.filter((d) => !d.identifier?.some((i) => i.system === 'urn:ga-server:id:file'))).toHaveLength(3);
  });
});

test('a C-CDA import waiting on the import lock decides its converter once it holds the lock (a replace that finished meanwhile counts)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-ccda-lock-'));
  vi.stubEnv('GA_CONFIG', join(dir, 'config.json'));
  try {
    await onStore(async ({ client }) => {
      const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
      // A Microsoft-era Composition: the path is Microsoft until ga ccda replace (holding the lock) removes it.
      const old = await client.createResource({ resourceType: 'Composition', status: 'final', type: { text: 'x' }, date: '2024-01-01', title: 'x', author: [{ display: 'x' }],
        subject: { reference: `Patient/${pid}` }, meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ccda' }] } } as Composition);
      const lock = await takeLock(join(dir, 'import.lock'), 0);
      const running = importPath(client, cfgFor(pid), writeDoc(SYNTHETIC), pid);
      await new Promise((r) => setTimeout(r, 300));
      await client.deleteResource('Composition', old.id as string);
      rmSync(lock as string);
      const report = await running; // the Microsoft path would fail (no converter at converterUrl)
      expect(report.notImported).toBeDefined();
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

// Note linking by Epic note id is C-CDA <-> EHI only: a portal note and an EHI note with the same id stay two records.
const NOTE_ROOT = '1.2.840.114350.1.13.999.2.7.2.727879';
const noteSetup = async (client: MedplumClient) => {
  const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
  const sys = 'urn:ga-server:id:ehi:org-999';
  const ehiSrc = { kind: 'ehi', file: '/x/ehi', date: '2024-01-01T00:00:00Z', writer: 'importer' } as SourceInfo;
  await importResources(client, [{ resourceType: 'Encounter', id: 'e1', status: 'finished', class: { code: 'AMB', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' },
    subject: { reference: `Patient/${pid}` }, identifier: [{ system: sys, value: 'PAT_ENC|1' }, { system: 'urn:oid:1.2.840.114350.1.13.999.2.7.3.698084.8', value: '1' }] } as Resource], ehiSrc, pid, 'h0');
  const ehi = (withEpicId: boolean) => importResources(client, [{ resourceType: 'DocumentReference', id: 'n1', status: 'current', subject: { reference: `Patient/${pid}` },
    identifier: [{ system: sys, value: 'HNO_INFO|555' }, ...(withEpicId ? [{ system: `urn:oid:${NOTE_ROOT}`, value: '555' }] : [])],
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('EHI note text').toString('base64') } }] } as Resource], ehiSrc, pid, 'h1');
  const at = '2026-11-01T00:00:00Z';
  const portal = () => importResources(client, [{ resourceType: 'DocumentReference', id: 'p1', status: 'current', subject: { reference: `Patient/${pid}` }, meta: { lastUpdated: '2026-10-01T00:00:00Z' },
    identifier: [{ system: 'urn:ga-server:id:smart:h', value: 'DocumentReference/p1' }, { system: `urn:oid:${NOTE_ROOT}`, value: '555' }],
    content: [{ attachment: { contentType: 'text/html', url: 'Binary/abc' } }] } as Resource],
    { kind: 'smart', file: 'https://h/fhir', date: at, writer: 'importer', dateOf: (r: Resource) => r.meta?.lastUpdated, seenAt: at } as SourceInfo, pid, 'h2');
  const notes = async () => (await client.searchResources('DocumentReference', { subject: `Patient/${pid}` })).filter((d) => !d.identifier?.some((i) => i.system === 'urn:ga-server:id:file'));
  const ehiNote = async () => (await notes()).find((d) => d.identifier?.some((i) => i.system === sys));
  return { pid, ehi, portal, notes, ehiNote };
};

test('a portal note never merges into an EHI note with the same Epic note id, in either order, old or new EHI notes', async () => {
  for (const [first, withEpicId] of [['ehi', false], ['ehi', true], ['portal', true]] as const) {
    await onStore(async ({ client }) => {
      const n = await noteSetup(client);
      if (first === 'ehi') await n.ehi(withEpicId);
      await n.portal();
      if (first === 'portal') await n.ehi(withEpicId);
      expect(await n.notes()).toHaveLength(2);
      const e = await n.ehiNote();
      expect(e?.content?.[0].attachment.contentType).toBe('text/plain');
      expect(e?.meta?.tag?.map((t) => t.code)).toContain('src-ehi');
      expect(e?.identifier?.some((i) => i.system === 'urn:ga-server:id:smart:h')).toBe(false);
    });
  }
});

const NOTE_XML = `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id root="2.16.840.1.113883.19.5" extension="NOTE-DOC"/><effectiveTime value="20240210"/>
    <recordTarget><patientRole><patient><name><given>T</given><family>P</family></name></patient></patientRole></recordTarget>
    <component><structuredBody><component><section><templateId root="2.16.840.1.113883.10.20.22.2.65"/><code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Progress Notes</title><text><paragraph ID="n1">Seen.</paragraph></text>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.202"/><id root="${NOTE_ROOT}" extension="555"/>
      <code code="34109-9" codeSystem="2.16.840.1.113883.6.1"/><text><reference value="#n1"/></text><statusCode code="completed"/></act></entry>
    </section></component></structuredBody></component></ClinicalDocument>`;

test('a portal note never merges into a C-CDA note with the same Epic note id, in either order', async () => {
  for (const first of ['ccda', 'portal']) {
    await onStore(async ({ client }) => {
      const n = await noteSetup(client);
      if (first === 'portal') await n.portal();
      await importPath(client, cfgFor(n.pid), writeDoc(NOTE_XML), n.pid);
      if (first === 'ccda') await n.portal();
      const notes = await n.notes();
      expect(notes).toHaveLength(2);
      const portal = notes.filter((d) => d.identifier?.some((i) => i.system === 'urn:ga-server:id:smart:h'));
      expect(portal).toHaveLength(1);
      expect(portal[0].identifier?.some((i) => i.system === 'urn:ga-server:id:ccda')).toBe(false);
      expect(portal[0].content?.map((c) => c.attachment.contentType)).toEqual(['text/html']);
    });
  }
});

test('a new EHI export\'s note merges into the C-CDA note with its Epic note id (C-CDA first)', async () => {
  await onStore(async ({ client }) => {
    const n = await noteSetup(client);
    await importPath(client, cfgFor(n.pid), writeDoc(NOTE_XML), n.pid);
    await n.ehi(true);
    const [one, ...more] = await n.notes();
    expect(more).toHaveLength(0);
    expect(one.identifier?.map((i) => i.system)).toEqual(expect.arrayContaining(['urn:ga-server:id:ehi:org-999', 'urn:ga-server:id:ccda']));
  });
});

test('a result organizer\'s procedure and encounter components are imported, not named; another kind of component still is', () => {
  const doc = (component: string) => `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <recordTarget><patientRole><patient/></patientRole></recordTarget><component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/><code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title><text>x</text>
    <entry><organizer classCode="BATTERY" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.1"/><id root="2.16.840.1.113883.19.5" extension="P-1"/>
      <code code="24323-8" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/>
      <component><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.2"/><id root="2.16.840.1.113883.19.5" extension="R-1"/>
        <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/><effectiveTime value="20240210"/><value xsi:type="PQ" value="1" unit="mg/dL"/></observation></component>
      ${component}</organizer></entry></section></component></structuredBody></component></ClinicalDocument>`;
  const proc = '<component><procedure classCode="PROC" moodCode="EVN"><code code="82078001" codeSystem="2.16.840.1.113883.6.96"/><effectiveTime value="20240210"/></procedure></component>';
  const enc = '<component><encounter classCode="ENC" moodCode="EVN"><id root="2.16.840.1.113883.19.5" extension="V-1"/></encounter></component>';
  const out = convertCcdaLocal(doc(proc + enc));
  expect(out.notImported).toEqual([]);
  expect(out.resources.map((r) => r.resourceType)).toEqual(expect.arrayContaining(['Procedure', 'Encounter']));
  const act = '<component><act classCode="ACT" moodCode="EVN"><code code="x" codeSystem="2.25.1"/></act></component>';
  expect(convertCcdaLocal(doc(act)).notImported).toEqual([{ section: 'Results', templateId: '2.16.840.1.113883.10.20.22.4.1', entries: 1, reason: 'organizer component not converted' }]);
});

// One visit across documents (in-process converter): keyed by its id, merged field by field.
const visitDoc = (docId: string, date: string, { header = '', body = '' }) => `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <id root="2.16.840.1.113883.19.5" extension="${docId}"/><effectiveTime value="${date}"/>
  <recordTarget><patientRole><patient><name><given>T</given><family>P</family></name></patient></patientRole></recordTarget>${header}
  <component><structuredBody>${body}</structuredBody></component></ClinicalDocument>`;
const visitHeader = (inner: string) => `<componentOf><encompassingEncounter><id root="2.16.840.1.113883.19.5.3" extension="V1"/>${inner}</encompassingEncounter></componentOf>`;
const ATTENDER = '<encounterParticipant typeCode="ATND"><assignedEntity><id root="2.16.840.1.113883.4.6" extension="NPI-9"/></assignedEntity></encounterParticipant>';
const visitEntry = (inner = '') => `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
  <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="2.16.840.1.113883.19.5.3" extension="V1"/>
  <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>${inner}</encounter></entry></section></component>`;
const panel = (p: string, extra = '') => `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.3.1"/><code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/><title>Results</title><text>x</text>
  <entry><organizer classCode="BATTERY" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.1"/><id root="2.16.840.1.113883.19.5" extension="${p}"/>
  <code code="24323-8" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/>
  <component><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.2"/><id root="2.16.840.1.113883.19.5" extension="${p}-R"/>
    <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/><effectiveTime value="20240210"/><value xsi:type="PQ" value="1" unit="mg/dL"/></observation></component>
  ${extra}</organizer></entry></section></component>`;
const visits = async (client: MedplumClient, pid: string) => (await client.searchResources('Encounter', { subject: `Patient/${pid}` })).filter((e) => e.identifier?.some((i) => i.value === 'V1'));

test('one visit across documents: a later document without the header keeps the header\'s participants and period (one Encounter)', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const a = writeDoc(visitDoc('A', '20200103', { header: visitHeader(`<effectiveTime><low value="20200102"/></effectiveTime>${ATTENDER}`), body: visitEntry() }));
    await importPath(client, cfgFor(pid), a, pid);
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('B', '20200201', { body: visitEntry() })), pid);
    const [v, ...more] = await visits(client, pid);
    expect(more).toHaveLength(0);
    expect(v.period?.start).toBe('2020-01-02');
    expect(v.participant?.map((p) => p.type?.[0].coding?.[0].code)).toEqual(['ATND']);
    expect(await importPath(client, cfgFor(pid), a, pid)).toMatchObject({ created: 0, updated: 0 });
  });
});

test('one visit across documents: an older fuller document imported after a newer bare one still adds its details', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('B', '20200201', { body: visitEntry() })), pid);
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('A', '20200103', { header: visitHeader(`<effectiveTime><low value="20200102"/></effectiveTime>${ATTENDER}`), body: visitEntry() })), pid);
    const [v, ...more] = await visits(client, pid);
    expect(more).toHaveLength(0);
    expect(v.period?.start).toBe('2020-01-02');
    expect(v.participant).toHaveLength(1);
    expect(v.extension?.filter((e) => e.url === 'urn:ga-server:ext:arrived')).toHaveLength(1);
    expect(v.extension?.find((e) => e.url === 'urn:ga-server:ext:source-date')?.valueDateTime).toBe('2020-02-01'); // the newer source's
  });
});

test('one visit across documents: a panel\'s bare visit in one document and the full visit in another are one Encounter', async () => {
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const bare = '<component><encounter classCode="ENC" moodCode="EVN"><id root="2.16.840.1.113883.19.5.3" extension="V1"/></encounter></component>';
    const c = writeDoc(visitDoc('C', '20240211', { body: panel('P1', bare) }));
    await importPath(client, cfgFor(pid), c, pid);
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('D', '20240301', { body: visitEntry('<effectiveTime value="20240210"/>') })), pid);
    const [v, ...more] = await visits(client, pid);
    expect(more).toHaveLength(0);
    expect(v.type?.[0].coding?.[0].code).toBe('99213');
    const [report] = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` });
    expect(report.encounter?.reference).toBe(`Encounter/${v.id}`);
    expect(await importPath(client, cfgFor(pid), c, pid)).toMatchObject({ created: 0, updated: 0 });
  });
});

test('an id-less collection procedure shared by two panels links both reports', async () => {
  const draw = '<component><procedure classCode="PROC" moodCode="EVN"><code code="82078001" codeSystem="2.16.840.1.113883.6.96"/><effectiveTime value="20240210080000-0500"/></procedure></component>';
  const two = panel('P1', draw).replace('</section>', panel('P2', draw).replace(/^[\s\S]*?<entry>/, '<entry>').replace(/<\/section><\/component>$/, '') + '</section>');
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const file = writeDoc(visitDoc('E', '20240211', { body: two }));
    await importPath(client, cfgFor(pid), file, pid);
    const procs = await client.searchResources('Procedure', { subject: `Patient/${pid}` });
    const reports = await client.searchResources('DiagnosticReport', { subject: `Patient/${pid}` });
    expect(reports).toHaveLength(2);
    expect(procs).toHaveLength(1);
    expect(procs[0].report?.map((r) => r.reference).sort()).toEqual(reports.map((r) => `DiagnosticReport/${r.id}`).sort());
    expect(await importPath(client, cfgFor(pid), file, pid)).toMatchObject({ created: 0, updated: 0 });
  });
});

test('a C-CDA note never merges into an EHI note of another Epic org; an EHI note is known by its EHI identifier, not its tag', async () => {
  const xml = (org: string) => `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><id root="2.16.840.1.113883.19.5" extension="NOTE-DOC-${org}"/><effectiveTime value="20240210"/>
    <recordTarget><patientRole><patient><name><given>T</given><family>P</family></name></patient></patientRole></recordTarget>
    <component><structuredBody><component><section><templateId root="2.16.840.1.113883.10.20.22.2.65"/><code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Progress Notes</title><text><paragraph ID="n1">Seen.</paragraph></text>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.202"/><id root="1.2.840.114350.1.13.${org}.2.7.2.727879" extension="5551"/>
      <code code="34109-9" codeSystem="2.16.840.1.113883.6.1"/><text><reference value="#n1"/></text><statusCode code="completed"/></act></entry>
    </section></component></structuredBody></component></ClinicalDocument>`;
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const system = 'urn:ga-server:id:ehi:org-888';
    await client.createResource({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${pid}` },
      identifier: [{ system, value: 'PAT_ENC|1' }, { system: 'urn:oid:1.2.840.114350.1.13.888.2.7.3.698084.8', value: '1' }] });
    // Org 888's EHI note without its src-ehi tag (an update by another source drops it): still the EHI note, by its identifier.
    const untagged = await client.createResource({ resourceType: 'DocumentReference', status: 'current', subject: { reference: `Patient/${pid}` },
      identifier: [{ system, value: 'HNO_INFO|5551' }], content: [{ attachment: { contentType: 'text/plain', data: 'eA==' } }] });
    await importPath(client, cfgFor(pid), writeDoc(xml('999')), pid); // another org
    expect((await client.readResource('DocumentReference', untagged.id as string)).identifier).toHaveLength(1);
    await importPath(client, cfgFor(pid), writeDoc(xml('888')), pid); // same org
    expect((await client.readResource('DocumentReference', untagged.id as string)).identifier?.length).toBeGreaterThan(1);
    const notes = (await client.searchResources('DocumentReference', { subject: `Patient/${pid}` })).filter((d) => !d.identifier?.some((i) => i.system === 'urn:ga-server:id:file'));
    expect(notes).toHaveLength(2); // org 999's note and the linked one: no duplicate
  });
});

test('one visit across documents: a period end survives in either order (nested objects merge field by field)', async () => {
  const full = (d: string) => visitDoc(d, '20200110', { header: visitHeader('<effectiveTime><low value="20200102"/><high value="20200105"/></effectiveTime>'), body: visitEntry() });
  const bare = (d: string) => visitDoc(d, '20200201', { body: visitEntry('<effectiveTime><low value="20200102"/></effectiveTime>') });
  for (const order of [[full('A'), bare('B')], [bare('B'), full('A')]]) {
    await onStore(async ({ client }) => {
      const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
      for (const x of order) await importPath(client, cfgFor(pid), writeDoc(x), pid);
      const [v, ...more] = await visits(client, pid);
      expect(more).toHaveLength(0);
      expect(v.period).toEqual({ start: '2020-01-02', end: '2020-01-05' });
    });
  }
});

test('one visit: two entries with the same visit id in one document are one Encounter, and a later document adds no other', async () => {
  const entry = (code: string, when: string) => `<entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="2.16.840.1.113883.19.5.3" extension="V1"/><code code="${code}" codeSystem="2.16.840.1.113883.6.12"/><effectiveTime value="${when}"/></encounter></entry>`;
  const section = (entries: string) => `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>${entries}</section></component>`;
  for (const [first, second] of [['99213', '99215'], ['99215', '99213']]) {
    await onStore(async ({ client }) => {
      const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
      await importPath(client, cfgFor(pid), writeDoc(visitDoc('C', '20210101', { body: section(entry(first, '20210101') + entry(second, '20210301')) })), pid);
      expect(await visits(client, pid)).toHaveLength(1);
      await importPath(client, cfgFor(pid), writeDoc(visitDoc('D', '20210401', { body: section(entry('99213', '20210101')) })), pid);
      const [v, ...more] = await visits(client, pid);
      expect(more).toHaveLength(0);
      expect(v.type?.map((t) => t.coding?.[0].code).sort()).toEqual(['99213', '99215']);
    });
  }
});

test('a visit another source wrote (EHI), linked by its Epic id, keeps its values, extensions and tags; the C-CDA id is added', async () => {
  const csn = '1.2.840.114350.1.13.999.2.7.3.698084.8';
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const ehi = await client.createResource({ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject: { reference: `Patient/${pid}` }, period: { start: '2022-01-01T09:00:00Z', end: '2022-01-01T10:00:00Z' },
      identifier: [{ system: 'urn:ga-server:id:ehi:org-999', value: 'PAT_ENC|123' }, { system: `urn:oid:${csn}`, value: '123' }],
      meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] },
      extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2022-01-02' }, { url: 'urn:test:keep', valueString: 'x' }] });
    const visit = `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
      <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="${csn}" extension="123"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/></encounter></entry></section></component>`;
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('E', '20230101', { body: visit })), pid);
    const after = await client.readResource('Encounter', ehi.id as string);
    expect(after).toMatchObject({ status: 'finished', class: { code: 'AMB' }, period: { start: '2022-01-01T09:00:00Z', end: '2022-01-01T10:00:00Z' } });
    expect(after.extension?.map((e) => e.url)).toContain('urn:test:keep');
    expect(after.identifier?.map((i) => i.system)).toContain('urn:ga-server:id:ccda');
    expect(after.meta?.tag?.map((t) => t.code)).toEqual(['src-ehi']); // another source's visit keeps its own tags
    expect((await client.searchResources('Encounter', { subject: `Patient/${pid}` }))).toHaveLength(1);
  });
});

test('a visit another source wrote keeps its values for every later C-CDA document, not just the first; its times are never cut to a date', async () => {
  const csn = '1.2.840.114350.1.13.999.2.7.3.698084.8';
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const ehi = await client.createResource({ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject: { reference: `Patient/${pid}` }, period: { start: '2022-01-01T09:00:00Z', end: '2022-01-01T10:00:00Z' }, serviceType: { text: 'Cardiology' },
      identifier: [{ system: 'urn:ga-server:id:ehi:org-999', value: 'PAT_ENC|123' }, { system: `urn:oid:${csn}`, value: '123' }],
      meta: { tag: [{ system: 'urn:ga-server:tag', code: 'src-ehi' }] },
      extension: [{ url: 'urn:ga-server:ext:source-date', valueDateTime: '2022-01-02' }, { url: 'urn:test:keep', valueString: 'x' }] });
    const entry = (code: string, eff: string) => `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
      <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="${csn}" extension="123"/>
      <code code="${code}" codeSystem="2.16.840.1.113883.6.12"/>${eff}</encounter></entry></section></component>`;
    const header = `<componentOf><encompassingEncounter><id root="${csn}" extension="123"/><effectiveTime><low value="20220101"/><high value="20220101"/></effectiveTime></encompassingEncounter></componentOf>`;
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('E', '20230101', { body: entry('99213', '<effectiveTime value="20220101"/>') })), pid);
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('F', '20230601', { body: entry('99214', '<effectiveTime value="20220101"/>') })), pid);
    await importPath(client, cfgFor(pid), writeDoc(visitDoc('G', '20230701', { header, body: entry('99215', '') })), pid);
    const after = await client.readResource('Encounter', ehi.id as string);
    expect(after).toMatchObject({ status: 'finished', class: { code: 'AMB' }, period: { start: '2022-01-01T09:00:00Z', end: '2022-01-01T10:00:00Z' }, serviceType: { text: 'Cardiology' } });
    expect(after.type?.map((t) => t.coding?.[0].code).sort()).toEqual(['99213', '99214', '99215']);
    expect(after.extension?.map((e) => e.url)).toContain('urn:test:keep');
    expect(await client.searchResources('Encounter', { subject: `Patient/${pid}` })).toHaveLength(1);
  });
});

test("a portal visit a C-CDA document links keeps its own tags and meta: the newest Epic import and EHI problems' currency never move, across resync and re-import", async () => {
  const { importResources } = await import('../src/engine.ts');
  const { currencyContext, explain } = await import('../src/current.ts');
  const csn = '1.2.840.114350.1.13.999.2.7.3.698084.8';
  await onStore(async ({ client }) => {
    const pid = (await client.createResource({ resourceType: 'Patient' })).id as string;
    const cond = { resourceType: 'Condition', identifier: [{ system: 'urn:ga-server:id:ehi:org-999', value: 'PROBLEM_LIST|1' }], subject: { reference: `Patient/${pid}` },
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }], code: { text: 'hypertension' } } as Resource;
    await importResources(client, [cond], { kind: 'ehi', file: '/x/ehi', org: 'org-999', date: '2024-01-01T00:00:00Z', writer: 'importer' }, pid, 'h1');
    const enc = (end?: string) => ({ resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/${pid}` },
      period: { start: '2022-03-01T09:00:00Z', ...(end && { end }) }, identifier: [{ system: 'urn:ga-server:id:smart:k1', value: 'Encounter/456' }, { system: `urn:oid:${csn}`, value: '456' }] }) as Resource;
    const doc = (id: string, code: string) => writeDoc(visitDoc(id, '20230101', { body: `<component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/><code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
      <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="${csn}" extension="456"/><code code="${code}" codeSystem="2.16.840.1.113883.6.12"/><effectiveTime value="20220301"/></encounter></entry></section></component>` }));
    await importResources(client, [enc()], { kind: 'smart', file: 'https://fhir.x/api', date: '2026-10-01T00:00:00Z', writer: 'importer' }, pid, 'hs');
    const meta0 = (await client.searchResources('Encounter', { subject: `Patient/${pid}` }))[0].meta;
    const check = async () => {
      const encs = await client.searchResources('Encounter', { subject: `Patient/${pid}` });
      const cs = await client.searchResources('Condition', { subject: `Patient/${pid}` });
      expect(encs).toHaveLength(1);
      expect(encs[0].meta?.tag?.map((t) => t.code).sort()).toEqual(meta0?.tag?.map((t) => t.code).sort());
      expect(encs[0].meta?.source).toBe(meta0?.source);
      const ctx = currencyContext([...encs, ...cs], []);
      expect(new Date(ctx.newestImport).toISOString().slice(0, 10)).toBe('2024-01-01');
      expect(explain(cs[0], ctx)?.currency).toBe('current');
    };
    await importPath(client, cfgFor(pid), doc('E', '99214'), pid);
    await check();
    expect((await client.searchResources('Encounter', { subject: `Patient/${pid}` }))[0].identifier?.map((i) => i.system)).toContain('urn:ga-server:id:ccda');
    await importResources(client, [enc('2022-03-01T09:30:00Z')], { kind: 'smart', file: 'https://fhir.x/api', date: '2026-10-02T00:00:00Z', writer: 'importer' }, pid, 'hs2');
    await check();
    await importPath(client, cfgFor(pid), doc('H', '99215'), pid);
    await check();
  });
});
