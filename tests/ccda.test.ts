import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { CareTeam, Composition, Condition, Encounter, FamilyMemberHistory, Medication, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { ccdaConverter, ccdaDate, ccdaFiles, convertCcdaLocal, custodian, importPath, repair, sectionName } from '../src/ccda.ts';
import { convertXmlToCcda } from '../vendor/medplum-ccda/index.ts';
import type { GaConfig } from '../src/config.ts';
import { onStore } from './temp-store.ts';
import { isPlanned } from '../src/current.ts';
import { labResults, labRow, type LabRow } from '../src/labs.ts';
import { vitals } from '../src/vitals.ts';
import { reviewList } from '../src/concepts-cli.ts';
import { whatsNew } from '../src/whats-new.ts';

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
  expect(convertCcdaLocal(allergies).notImported.filter((n) => n.section === 'Allergies')).toEqual([]);
  // Two records from one act must not hide an act that made none.
  const empty = '<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.3"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/></act></entry>';
  expect(convertCcdaLocal(problems.replace('<text>Hyperlipidemia</text>', `<text>Hyperlipidemia</text>${empty}`)).notImported).toEqual([
    { section: 'Problems', templateId: '2.16.840.1.113883.10.20.22.2.5.1', entries: 1, reason: 'entry produced no record' },
  ]);
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
  expect(cond.category?.[0].coding?.[0].code).toBe('problem-list-item'); // repair, by the problem observation id
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
  expect(dx.map((c) => c.clinicalStatus?.coding?.[0].code)).toEqual(['resolved', 'resolved']); // repair: the diagnosis act is completed
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
