// Medplum 5.2.14 packages/server/src/fhir/search.test.ts, second part (from "Chained search sort order"), ported side by side
// as in search.test.ts. Medplum's beforeAll fixtures are made once per side, on first use.
import type { Bundle, Patient, Task } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, error, marker, names, paritySides, q, ref, same, search, type Side } from './harness.ts';

const UCUM = 'http://unitsofmeasure.org';
const SNOMED = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const has = (b: Bundle, r: { id: string }) => !!b.entry?.some((e) => e.resource?.id === r.id);
const pause = () => new Promise((r) => setTimeout(r, 20)); // distinct meta.lastUpdated milliseconds

describe.skipIf(SQLITE)('Medplum search.test.ts (parity, part 2)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);
  // A fixture made once per side, the first time a test needs it.
  const once = <T>(make: (s: Side) => Promise<T>) => {
    const made = new Map<string, Promise<T>>();
    return (s: Side) => { if (!made.has(s.name)) made.set(s.name, make(s)); return made.get(s.name)!; };
  };

  test('project-scoped Repository w/ %j › Chained search sort order [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const identifier = marker();
    const link1 = await s.create({ resourceType: 'Patient', identifier: [{ value: identifier }] });
    const link2 = await s.create({ resourceType: 'Patient', identifier: [{ value: identifier }] });
    const patientIds: string[] = [];
    for (let i = 1; i < 10; i++) {
      const patient = await s.create({ resourceType: 'Patient', birthDate: '1994-11-0' + i, link: [{ type: 'seealso', other: ref(link1) }, { type: 'seealso', other: ref(link2) }] });
      patientIds.unshift(patient.id);
    }
    const result = await search(s, `Patient?link:Patient.identifier=${identifier}&_sort=-birthdate`);
    expect(result.entry?.map((e) => (e.resource as Patient).birthDate)).toEqual(['09', '08', '07', '06', '05', '04', '03', '02', '01'].map((d) => `1994-11-${d}`));
    expect(result.entry?.map((e) => e.resource?.id)).toEqual(patientIds);
  }));

  // The shared project holds other linked Patients: the result is narrowed to the ones this test made, in the order returned.
  test('project-scoped Repository w/ %j › Chained search with negated filter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const link1 = await s.create({ resourceType: 'Patient', identifier: [{ value: crypto.randomUUID() }] });
    const link2 = await s.create({ resourceType: 'Patient', identifier: [{ value: crypto.randomUUID() }] });
    const patientIds: string[] = [];
    for (let i = 1; i < 10; i++) {
      const middlePatient = await s.create({ resourceType: 'Patient', link: [{ type: 'seealso', other: ref(link1) }, { type: 'seealso', other: ref(link2) }] });
      const patient = await s.create({ resourceType: 'Patient', birthDate: '1994-11-0' + i, link: [{ type: 'seealso', other: ref(middlePatient) }] });
      patientIds.unshift(patient.id);
    }
    const result = await search(s, `Patient?link:Patient.link:Patient.identifier:not=${crypto.randomUUID()}&_sort=-birthdate&_count=1000`);
    const mine = result.entry?.filter((e) => patientIds.includes(e.resource!.id!)) ?? [];
    expect(mine.map((e) => (e.resource as Patient).birthDate)).toEqual(['09', '08', '07', '06', '05', '04', '03', '02', '01'].map((d) => `1994-11-${d}`));
    expect(mine.map((e) => e.resource?.id)).toEqual(patientIds);
  }));

  test('project-scoped Repository w/ %j › Chained search on canonical reference [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const url = 'http://example.com/' + crypto.randomUUID();
    const q = crypto.randomUUID();
    const questionnaire = await s.create({ resourceType: 'Questionnaire', status: 'unknown', url, identifier: [{ value: q }] });
    const ev = crypto.randomUUID();
    const evidenceVariable = await s.create({ resourceType: 'EvidenceVariable', status: 'unknown', relatedArtifact: [{ type: 'derived-from', resource: url }], identifier: [{ value: ev }] } as never) as { id: string };
    const result = await search(s, `Questionnaire?_has:EvidenceVariable:derived-from:identifier=${ev}`);
    expect(result.entry).toHaveLength(1);
    expect(result.entry?.[0]?.resource?.id).toBe(questionnaire.id);
    const result2 = await search(s, `EvidenceVariable?derived-from:Questionnaire.identifier=${q}`);
    expect(result2.entry).toHaveLength(1);
    expect(result2.entry?.[0]?.resource?.id).toBe(evidenceVariable.id);
    const study = await s.create({ resourceType: 'ResearchStudy', status: 'active', outcomeMeasure: [{ reference: ref(evidenceVariable as { resourceType: string; id: string }) }] } as never) as { id: string };
    const result3 = await search(s, `ResearchStudy?outcome-measure-reference:EvidenceVariable.derived-from:Questionnaire.identifier=${q}`);
    expect(result3.entry).toHaveLength(1);
    expect(result3.entry?.[0]?.resource?.id).toBe(study.id);
  }));

  test('project-scoped Repository w/ %j › Rejects too long chained search [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const e = await error(s, 'Patient?_has:Observation:subject:encounter:Encounter._has:DiagnosticReport:encounter:result.specimen.parent.collected=2023');
    expect(e).toEqual({ status: 400, text: 'Search chains longer than three links are not currently supported' });
    return e;
  }));

  test('project-scoped Repository w/ %j › Invalid chained search parameters: %s [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const out = [];
    for (const [searchString, errorMsg] of [
      ['Patient?organization.invalid.name=Kaiser', 'Invalid search parameter in chain: Organization?invalid'],
      ['Patient?organization.invalid=true', 'Invalid search parameter at end of chain: Organization?invalid'],
      ['Patient?general-practitioner.qualification-period=2023', 'Unable to identify next resource type for search parameter: Patient?general-practitioner'],
      ['Patient?_has:Observation:invalid:status=active', 'Invalid search parameter in chain: Observation?invalid'],
      ['Patient?_has:Observation:encounter:status=active', 'Invalid reverse chain link: search parameter Observation?encounter does not refer to Patient'],
      ['Patient?_has:Observation:status=active', 'Invalid search chain: _has:Observation:status'],
    ]) {
      const e = await error(s, searchString);
      expect(e, searchString).toEqual({ status: 400, text: errorMsg });
      out.push(e);
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Chained search with modifier [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const patient = await s.create({ resourceType: 'Patient' });
    const encounter = await s.create({ resourceType: 'Encounter', status: 'finished', class: { system: 'http://example.com/appt-type', code } });
    await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'Throat culture' }, subject: ref(patient), encounter: ref(encounter) });
    const result = await search(s, `Patient?_has:Observation:subject:encounter:Encounter.class=${code}&_has:Observation:subject:encounter:Encounter.status:not=cancelled`);
    expect(result.entry?.[0]?.resource?.id).toBe(patient.id);
  }));

  test('project-scoped Repository w/ %j › Invalid canonical chained search link [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const text = 'ResearchStudy cannot be chained via canonical reference (EvidenceVariable:derived-from)';
    const out = [await error(s, 'EvidenceVariable?derived-from:ResearchStudy.status=active'), await error(s, 'ResearchStudy?_has:EvidenceVariable:derived-from:_id=foo')];
    expect(out).toEqual([{ status: 400, text }, { status: 400, text }]);
    return out;
  }));

  test('project-scoped Repository w/ %j › Chained search deduplication [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID(), code2 = crypto.randomUUID();
    const patient = await s.create({ resourceType: 'Patient' });
    await s.create({ resourceType: 'Observation', status: 'final', code: { coding: [{ code }], text: 'Throat culture' }, subject: ref(patient) });
    await s.create({ resourceType: 'Observation', status: 'final', code: { coding: [{ code: code2 }], text: 'Blood test' }, subject: ref(patient) });
    const result = await search(s, `Patient?_has:Observation:subject:code=${code},${code2}`);
    expect(names(result, { patient })).toEqual(['patient']);
  }));

  test('project-scoped Repository w/ %j › Token search deduplication [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID(), code2 = crypto.randomUUID();
    const observation = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'Blood test' }, component: [{ code: { coding: [{ code }] } }, { code: { coding: [{ code: code2 }] } }] });
    const result = await search(s, `Observation?component-code=${code},${code2}`);
    expect(names(result, { observation })).toEqual(['observation']);
  }));

  test('project-scoped Repository w/ %j › Include references success [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const order = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: ref(patient) });
    const bundle = await search(s, `ServiceRequest?_include=ServiceRequest:subject&_total=accurate&_id=${order.id}`);
    expect(bundle.total).toBe(1);
    expect(names(bundle, { order, patient })).toEqual(['order', 'include:patient']);
  }));

  test('project-scoped Repository w/ %j › Include canonical success [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const canonicalURL = 'http://example.com/fhir/Questionnaire/PHQ-9/' + crypto.randomUUID();
    const questionnaire = await s.create({ resourceType: 'Questionnaire', status: 'active', url: canonicalURL });
    const response = await s.create({ resourceType: 'QuestionnaireResponse', status: 'in-progress', questionnaire: canonicalURL });
    const bundle = await search(s, `QuestionnaireResponse?_include=QuestionnaireResponse:questionnaire&_total=accurate&_id=${response.id}`);
    expect(bundle.total).toBe(1);
    expect(names(bundle, { response, questionnaire })).toEqual(['response', 'include:questionnaire']);
  }));

  test('project-scoped Repository w/ %j › Include PlanDefinition mixed types [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const canonical = 'http://example.com/fhir/R4/ActivityDefinition/' + crypto.randomUUID();
    const uri = 'http://example.com/fhir/R4/ActivityDefinition/' + crypto.randomUUID();
    const plan = await s.create({ resourceType: 'PlanDefinition', status: 'active', action: [{ definitionCanonical: canonical }, { definitionUri: uri }] });
    const activity1 = await s.create({ resourceType: 'ActivityDefinition', status: 'active', url: canonical });
    const activity2 = await s.create({ resourceType: 'ActivityDefinition', status: 'active', url: uri });
    const bundle = await search(s, `PlanDefinition?_include=PlanDefinition:definition&_total=accurate&_id=${plan.id}`);
    expect(bundle.total).toBe(1);
    expect(names(bundle, { plan, activity1, activity2 })).toEqual(['plan', 'include:activity1', 'include:activity2']);
  }));

  test('project-scoped Repository w/ %j › Include references invalid search param [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const e = await error(s, 'ServiceRequest?_include=ServiceRequest:xyz');
    expect(e).toEqual({ status: 400, text: 'Invalid include parameter: ServiceRequest:xyz' });
    return e;
  }));

  test('project-scoped Repository w/ %j › Reverse include Provenance [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const practitioner1 = await s.create({ resourceType: 'Practitioner', name: [{ given: ['Homer'], family }] });
    const practitioner2 = await s.create({ resourceType: 'Practitioner', name: [{ given: ['Marge'], family }] });
    const path = q('Practitioner', ['name', family], ['_revinclude', 'Provenance:target']);
    const searchResult1 = await search(s, path);
    expect(names(searchResult1, { practitioner1, practitioner2 }).sort()).toEqual(['practitioner1', 'practitioner2']);
    const provenance1 = await s.create({ resourceType: 'Provenance', target: [ref(practitioner1)], agent: [{ who: ref(practitioner1) }], recorded: new Date().toISOString() });
    const provenance2 = await s.create({ resourceType: 'Provenance', target: [ref(practitioner2)], agent: [{ who: ref(practitioner2) }], recorded: new Date().toISOString() });
    const searchResult2 = await search(s, path);
    const got = names(searchResult2, { practitioner1, practitioner2, provenance1, provenance2 }).sort();
    expect(got).toEqual(['include:provenance1', 'include:provenance2', 'practitioner1', 'practitioner2']);
    return got;
  }));

  const auditEvent = (s: Side, entity: string[] = []) => s.create({
    resourceType: 'AuditEvent', recorded: '2026-01-01T00:00:00.000Z', type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest' },
    agent: [{ requestor: true }], source: { observer: { display: 'test' } }, entity: entity.map((reference) => ({ what: { reference } })),
  });

  test('project-scoped Repository w/ %j › Reverse include canonical [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const canonicalURL = 'http://example.com/fhir/Questionnaire/PHQ-9/' + crypto.randomUUID();
    const questionnaire = await s.create({ resourceType: 'Questionnaire', status: 'active', url: canonicalURL });
    const response = await s.create({ resourceType: 'QuestionnaireResponse', status: 'in-progress', questionnaire: canonicalURL });
    const bundle = await search(s, `Questionnaire?_revinclude=QuestionnaireResponse:questionnaire&_total=accurate&_id=${questionnaire.id}`);
    expect(bundle.total).toBe(1);
    expect(names(bundle, { questionnaire, response })).toEqual(['questionnaire', 'include:response']);
  }));

  test('project-scoped Repository w/ %j › _include:iterate [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    // patient → linked1 → linked3 → (org2, practitioner2); patient → linked2 → practitioner2; patient → org1, practitioner1.
    // org2 is left out: Patient:organization has no :iterate.
    const id = marker();
    const org1 = await s.create({ resourceType: 'Organization', name: 'org1' });
    const org2 = await s.create({ resourceType: 'Organization', name: 'org2' });
    const practitioner1 = await s.create({ resourceType: 'Practitioner' });
    const practitioner2 = await s.create({ resourceType: 'Practitioner' });
    const linked3 = await s.create({ resourceType: 'Patient', managingOrganization: ref(org2), generalPractitioner: [ref(practitioner2)] });
    const linked1 = await s.create({ resourceType: 'Patient', link: [{ other: ref(linked3), type: 'replaces' }] });
    const linked2 = await s.create({ resourceType: 'Patient', generalPractitioner: [ref(practitioner2)] });
    const patient = await s.create({ resourceType: 'Patient', identifier: [{ value: id }], link: [{ other: ref(linked1), type: 'replaces' }, { other: ref(linked2), type: 'replaces' }],
      managingOrganization: ref(org1), generalPractitioner: [ref(practitioner1)] });
    const bundle = await search(s, `Patient?identifier=${id}&_include=Patient:organization&_include:iterate=Patient:link&_include:iterate=Patient:general-practitioner`);
    const got = names(bundle, { patient, linked1, linked2, linked3, org1, org2, practitioner1, practitioner2 }).sort();
    expect(got).toEqual(['include:linked1', 'include:linked2', 'include:linked3', 'include:org1', 'include:practitioner1', 'include:practitioner2', 'patient']);
    return got;
  }));

  test('project-scoped Repository w/ %j › _include with target type [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const task = await s.create({ resourceType: 'Task', status: 'completed', intent: 'order' });
    const referencedAuditEvent = await auditEvent(s);
    const audit = await auditEvent(s, [`Task/${task.id}`, `AuditEvent/${referencedAuditEvent.id}`]);
    const bundle = await search(s, `AuditEvent?entity=Task/${task.id}&_include=AuditEvent:entity:Task`);
    const got = names(bundle, { task, referencedAuditEvent, audit }).sort();
    expect(got).toEqual(['audit', 'include:task']);
    return got;
  }));

  test('project-scoped Repository w/ %j › _revinclude with target type [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const identifier = crypto.randomUUID();
    const task = await s.create({ resourceType: 'Task', status: 'completed', intent: 'order', identifier: [{ value: identifier }] });
    const audit = await auditEvent(s, [`Task/${task.id}`]);
    const matched = await search(s, `Task?identifier=${identifier}&_revinclude=AuditEvent:entity:Task`);
    expect(names(matched, { task, audit }).sort()).toEqual(['include:audit', 'task']);
    const notMatched = await search(s, `Task?identifier=${identifier}&_revinclude=AuditEvent:entity:Patient`);
    expect(notMatched.entry?.filter((e) => e.search?.mode === 'include')).toHaveLength(0);
    return [names(matched, { task, audit }).sort(), names(notMatched, { task, audit })];
  }));

  test('project-scoped Repository w/ %j › _revinclude:iterate [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    // patient ← linked1 ← linked3 (left out: Patient:link has no :iterate); patient ← linked2 ← observation3;
    // patient ← observation1 ← observation2 (has-member) ← observation4.
    const id = marker();
    const patient = await s.create({ resourceType: 'Patient', identifier: [{ value: id }] });
    const linked1 = await s.create({ resourceType: 'Patient', link: [{ other: ref(patient), type: 'replaced-by' }] });
    const linked2 = await s.create({ resourceType: 'Patient', link: [{ other: ref(patient), type: 'replaced-by' }] });
    await s.create({ resourceType: 'Patient', link: [{ other: ref(linked1), type: 'replaced-by' }] });
    const obs = (extra: object) => s.create({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: LOINC, code: 'fake' }] }, ...extra });
    const observation1 = await obs({ subject: ref(patient) });
    const observation2 = await obs({ subject: { display: 'Someone' }, hasMember: [ref(observation1)] });
    const observation3 = await obs({ subject: ref(linked2) });
    const observation4 = await obs({ subject: { display: 'Someone' }, hasMember: [ref(observation2)] });
    const bundle = await search(s, `Patient?identifier=${id}&_revinclude=Patient:link&_revinclude:iterate=Observation:subject&_revinclude:iterate=Observation:has-member`);
    const got = names(bundle, { patient, linked1, linked2, observation1, observation2, observation3, observation4 }).sort();
    expect(got).toEqual(['include:linked1', 'include:linked2', 'include:observation1', 'include:observation2', 'include:observation3', 'include:observation4', 'patient']);
    return got;
  }));

  test('project-scoped Repository w/ %j › _include depth limit [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    // root → linked1 → … → linked6: a sixth round of Patient:link is past Medplum's limit (5).
    const id = marker();
    let next = await s.create<Patient>({ resourceType: 'Patient' });
    for (let i = 0; i < 5; i++) next = await s.create<Patient>({ resourceType: 'Patient', link: [{ other: ref(next), type: 'replaces' }] });
    await s.create({ resourceType: 'Patient', identifier: [{ value: id }], link: [{ other: ref(next), type: 'replaces' }] });
    return error(s, `Patient?identifier=${id}&_include:iterate=Patient:link`);
  }));

  test('project-scoped Repository w/ %j › _include on empty search results [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const bundle = await search(s, `Patient?identifier=${marker()}&_include:iterate=Patient:link`);
    expect([bundle.resourceType, bundle.type, bundle.entry ?? [], bundle.total]).toEqual(['Bundle', 'searchset', [], undefined]);
  }));

  test('project-scoped Repository w/ %j › _include on page boundary [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const mrn = crypto.randomUUID();
    const gp1 = await s.create({ resourceType: 'Practitioner' });
    const patient1 = await s.create({ resourceType: 'Patient', identifier: [{ value: mrn }], generalPractitioner: [ref(gp1)] });
    await pause();
    const gp2 = await s.create({ resourceType: 'Practitioner' });
    const patient2 = await s.create({ resourceType: 'Patient', identifier: [{ value: mrn }], generalPractitioner: [ref(gp2)] });
    const named = { gp1, patient1, gp2, patient2 };
    const page = (count: number) => search(s, `Patient?identifier=${mrn}&_sort=_lastUpdated&_include=Patient:general-practitioner&_count=${count}`);
    const one = await page(1);
    expect(names(one, named)).toEqual(['patient1', 'include:gp1']);
    const two = await page(2);
    expect(names(two, named)).toEqual(['patient1', 'patient2', 'include:gp1', 'include:gp2']);
    return [names(one, named), names(two, named)];
  }));

  test('project-scoped Repository w/ %j › Include with invalid reference [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const order = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/p_${patient.id}` } });
    const bundle = await search(s, `ServiceRequest?_include=ServiceRequest:subject&_total=accurate&_id=${order.id}`);
    expect(bundle.total).toBe(1);
    expect(names(bundle, { order, patient })).toEqual(['order']);
  }));

  test('project-scoped Repository w/ %j › DiagnosticReport category with system [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const dr = await s.create({ resourceType: 'DiagnosticReport', status: 'final', code: { coding: [{ code }] }, category: [{ coding: [{ system: LOINC, code: 'LP217198-3' }] }] });
    const bundle = await search(s, q('DiagnosticReport', ['code', code], ['category', `${LOINC}|LP217198-3`], ['_count', '1']));
    expect(has(bundle, dr)).toBe(true);
  }));

  const encounterDate = (s: Side, period: { start: string; end: string }, value: string) => async () => {
    const e = await s.create({ resourceType: 'Encounter', identifier: [{ value: crypto.randomUUID() }], status: 'finished', class: { code: 'test' }, period });
    const bundle = await search(s, q('Encounter', ['identifier', e.identifier[0].value], ['date', `gt${value}`], ['_count', '1']));
    expect(has(bundle, e)).toBe(true);
  };

  test('project-scoped Repository w/ %j › Encounter.period date search [server/src/fhir/search.test.ts]', () => same(sides, (s) => encounterDate(s, { start: '2020-02-01', end: '2020-02-02' }, '2020-01-01')()));

  test('project-scoped Repository w/ %j › Encounter.period dateTime search [server/src/fhir/search.test.ts]', () => same(sides, (s) => encounterDate(s, { start: '2020-02-01T13:30:00Z', end: '2020-02-01T14:15:00Z' }, '2020-02-01T12:00Z')()));

  const twoConditions = async (s: Side) => {
    const p = await s.create({ resourceType: 'Patient', name: [{ family: crypto.randomUUID() }] });
    const c1 = await s.create({ resourceType: 'Condition', subject: ref(p), code: { coding: [{ system: SNOMED, code: '165002' }] } });
    const c2 = await s.create({ resourceType: 'Condition', subject: ref(p), code: { coding: [{ system: 'https://example.com', code: 'test' }] } });
    return { p, c1, c2 };
  };

  test('project-scoped Repository w/ %j › Condition.code system search [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const { p, c1, c2 } = await twoConditions(s);
    const bundle = await search(s, q('Condition', ['subject', `Patient/${p.id}`], ['code', `${SNOMED}|`]));
    expect(names(bundle, { c1, c2 })).toEqual(['c1']);
  }));

  test('project-scoped Repository w/ %j › Condition.code :not next URL [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const { p } = await twoConditions(s);
    const bundle = await search(s, `Condition?subject=Patient/${p.id}&code:not=x&_count=1&_total=accurate`);
    expect(bundle.entry?.length).toBe(1);
    const nextUrl = bundle.link?.find((l) => l.relation === 'next')?.url;
    expect(nextUrl).toBeDefined();
    expect(nextUrl).toContain('code:not=x');
  }));

  test('project-scoped Repository w/ %j › Resource meta search params › Search by dedicated token column search parameter, identifier [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patientIdentifier = crypto.randomUUID();
    const patient = await s.create({
      resourceType: 'Patient', identifier: [{ system: 'http://example.com', value: patientIdentifier }],
      meta: {
        profile: ['http://example.com/fhir/a-patient-profile'], security: [{ system: 'http://hl7.org/fhir/v3/Confidentiality', code: 'N' }],
        source: 'http://example.org', tag: [{ system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' }],
      },
    });
    const bundle1 = await search(s, q('Patient', ['identifier', patientIdentifier], ['_profile', 'http://example.com/fhir/a-patient-profile']));
    expect(has(bundle1, patient)).toBe(true);
  }));

  test('project-scoped Repository w/ %j › Token :text search [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const obs1 = await s.create({ resourceType: 'Observation', status: 'final', code: { text: crypto.randomUUID() }, subject: ref(patient) });
    const obs2 = await s.create({ resourceType: 'Observation', status: 'final', code: { coding: [{ display: crypto.randomUUID() }] }, subject: ref(patient) });
    const result1 = await search(s, q('Observation', ['code:text', obs1.code.text as string]));
    expect(result1.entry?.[0]?.resource?.id).toBe(obs1.id);
    const result2 = await search(s, q('Observation', ['code:text', obs2.code.coding?.[0]?.display as string]));
    expect(result2.entry?.[0]?.resource?.id).toBe(obs2.id);
  }));

  // R4 eq: "the range of the search value fully contains the range of the target value". A dateTime search value is that
  // instant (to its precision), which does not contain the day 2000-01-01, so the store matches none; Medplum compares a date
  // parameter to the search value's date, with or without its range-search feature (this test is not feature-gated).
  test('differs on purpose: project-scoped Repository w/ %j › birthdate covers all hours: %d (%s) [server/src/fhir/search.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const out = [];
      for (const [hour, tz] of [[0, 'Z'], [1, 'Z'], [6, 'Z'], [12, 'Z'], [23, 'Z'], [0, '-08:00'], [23, '-08:00'], [0, '+03:00'], [23, '+03:00']] as const) {
        const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Evelyn'] }], birthDate: '2000-01-01', managingOrganization: { reference: 'Organization/' + crypto.randomUUID() } });
        const result1 = await search(s, q('Patient', ['organization', patient.managingOrganization.reference], ['birthdate', `2000-01-01T${String(hour).padStart(2, '0')}:00:00${tz}`]));
        out.push(result1.entry?.length ?? 0);
      }
      return out;
    });
    expect(medplum).toEqual(Array(9).fill(1));
    expect(store).toEqual(Array(9).fill(0));
  });

  // Medplum's test expects the match only with its range-search feature (it skips without). This Medplum, without the feature,
  // and the store both refuse a comma list of dates (@medplum/core's parser), loudly; see the store README's next phase.
  test('project-scoped Repository w/ %j › birthdate with multiple values [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Evelyn'] }], birthDate: '2000-01-01', managingOrganization: { reference: 'Organization/' + crypto.randomUUID() } });
    const e = await error(s, q('Patient', ['organization', patient.managingOrganization.reference], ['birthdate', '2000-01-01,2001-01-01']));
    expect(e).toEqual({ status: 400, text: 'Invalid format for date search parameter: 2000-01-01,2001-01-01' });
    return e;
  }));

  test('project-scoped Repository w/ %j › reverse chain with prefix modifier [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient', birthDate: '2000-01-01', name: [{ given: ['Eve'] }], managingOrganization: { reference: 'Organization/' + crypto.randomUUID() } });
    await s.create({ resourceType: 'Observation', effectiveDateTime: '2000-01-01', status: 'final', code: { text: 'Temp.' }, subject: ref(patient), valueQuantity: { value: 101, code: '[degF]', system: UCUM } });
    // Medplum's project is shared: the patient must be among the matches (Medplum's own test has only this one).
    const result = await search(s, 'Patient?_has:Observation:subject:value-quantity=gt100&_count=1000');
    expect(has(result, patient)).toBe(true);
  }));

  test('project-scoped Repository w/ %j › Lookup table exact match with comma disjunction [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const named: Record<string, { id: string }> = {};
    for (const [n, given] of [['p1', 'x'], ['p2', 'xx'], ['p3', 'y'], ['p4', 'yy']]) named[n] = await s.create({ resourceType: 'Patient', name: [{ given: [given], family }] });
    const bundle = await search(s, q('Patient', ['_total', 'accurate'], ['given:exact', 'x,y'], ['family:exact', family]));
    expect(names(bundle, named).sort()).toEqual(['p1', 'p3']);
    expect(bundle.total).toBe(2);
  }));

  test('project-scoped Repository w/ %j › Duplicate rows from token lookup [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const p = await s.create({ resourceType: 'Patient' });
    const sr = await s.create({ resourceType: 'ServiceRequest', subject: ref(p), status: 'active', intent: 'order', category: [{ text: code, coding: [{ system: 'https://example.com/category', code }] }] });
    const bundle = await search(s, q('ServiceRequest', ['category', code]));
    expect(names(bundle, { sr })).toEqual(['sr']);
  }));

  const dueTask = once(async (s) => {
    const code = crypto.randomUUID();
    const task = await s.create({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ code }] }, restriction: { period: { start: '2025-05-15T12:00:00.000Z', end: '2025-05-15T13:00:00.000Z' } } });
    return { code, task };
  });

  // R4 gt/ge: "the range above the search value intersects (i.e. overlaps) with the range of the target value". Task.restriction
  // .period runs 12:00 to 13:00, so gt 12:00:00, gt 12:00:01 and ge 12:00:01 match it (Medplum's range-search feature agrees);
  // Medplum without that feature, as this server runs, compares the period's start only.
  test('differs on purpose: project-scoped Repository w/ %j › Filter Task by due-date › with %s %s [server/src/fhir/search.test.ts]', async () => {
    const [start, startPlusOneSecond] = ['2025-05-15T12:00:00.000Z', '2025-05-15T12:00:01.000Z'];
    const cases: [string, string, boolean, boolean][] = [ // prefix, value, Medplum without range-search, R4 (range-search)
      ['lt', start, false, false], ['le', start, true, true], ['ge', start, true, true], ['gt', start, false, true],
      ['lt', startPlusOneSecond, true, true], ['le', startPlusOneSecond, true, true], ['ge', startPlusOneSecond, false, true], ['gt', startPlusOneSecond, false, true],
      ['gt', '2025-05-01', true, true], ['gt', '2025-06-01', false, false],
    ];
    const [medplum, store] = await both(sides, async (s) => {
      const { code, task } = await dueTask(s);
      const out = [];
      for (const [prefix, value] of cases) {
        const bundle = await search(s, q('Task', ['code', code], ['due-date', `${prefix}${value}`], ['_sort', 'due-date']));
        expect((bundle.entry ?? []).every((e) => e.resource?.id === task.id)).toBe(true);
        out.push((bundle.entry?.length ?? 0) === 1);
      }
      return out;
    });
    expect(medplum).toEqual(cases.map((c) => c[2]));
    expect(store).toEqual(cases.map((c) => c[3]));
  });

  test('project-scoped Repository w/ %j › Filter Task by due-date › multiple resources [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const base: Task = { resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ code }] } };
    const task1 = await s.create({ ...base });
    const task2 = await s.create({ ...base, restriction: { period: { start: '2023-06-02T00:00:00.000Z' } } });
    const task3 = await s.create({ ...base, restriction: { period: { end: '2023-06-03T00:00:00.000Z' } } });
    const bundle = await search(s, q('Task', ['code', code], ['due-date', 'gt2023-06-01T00:00:00.000Z'], ['_sort', 'due-date']));
    expect(names(bundle, { task1, task2, task3 })).toEqual(['task2', 'task3']);
  }));

  test('project-scoped Repository w/ %j › Organization by name [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const org = await s.create({ resourceType: 'Organization', name: crypto.randomUUID() });
    const result = await search(s, q('Organization', ['name', `wrongname,${org.name.slice(0, 5)}`]));
    expect(names(result, { org })).toEqual(['org']);
  }));

  test('project-scoped Repository w/ %j › Practitioner by email is case insensitive [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const email = 'UPPER@EXAMPLE.COM';
    const practitioner = await s.create({ resourceType: 'Practitioner', telecom: [{ system: 'email', value: email }] });
    const result = await search(s, q('Practitioner', ['telecom', 'uPpeR@ExAmPlE.CoM']));
    expect(names(result, { practitioner })).toEqual(['practitioner']);
  }));

  test('project-scoped Repository w/ %j › Practitioner by identifier is case sensitive [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const value = 'MiXeD-cAsE';
    const practitioner = await s.create({ resourceType: 'Practitioner', identifier: [{ system: 'http://example.com', value }] });
    const out = [];
    for (const [query, shouldFind] of [[value, true], [value.toLocaleLowerCase(), false], [value.toLocaleUpperCase(), false]] as const) {
      const result = await search(s, q('Practitioner', ['identifier', query]));
      expect(names(result, { practitioner }), query).toEqual(shouldFind ? ['practitioner'] : []);
      out.push(names(result, { practitioner }));
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Patient by name with stop word [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const seed = crypto.randomUUID();
    await s.create({ resourceType: 'Patient', name: [{ given: [seed + 'Justin', 'Wynn'], family: 'Sanders' + seed }] });
    const result = await search(s, q('Patient', ['name:contains', `${seed.slice(-3)}just`]));
    expect(result.entry?.length).toBe(1);
  }));

  test('project-scoped Repository w/ %j › Sort by ID [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const org = await s.create({ resourceType: 'Organization', name: 'org1' });
    await s.create({ resourceType: 'Patient', managingOrganization: ref(org) });
    await s.create({ resourceType: 'Patient', managingOrganization: ref(org) });
    const result1 = await search(s, `Patient?organization=Organization/${org.id}&_sort=_id`);
    expect(result1.entry).toHaveLength(2);
    expect(result1.entry?.[0]?.resource?.id?.localeCompare(result1.entry?.[1]?.resource?.id as string)).toBe(-1);
    const result2 = await search(s, `Patient?organization=Organization/${org.id}&_sort=-_id`);
    expect(result2.entry).toHaveLength(2);
    expect(result2.entry?.[0]?.resource?.id?.localeCompare(result2.entry?.[1]?.resource?.id as string)).toBe(1);
  }));

  test('project-scoped Repository w/ %j › Numeric parameter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const ident = crypto.randomUUID();
    const prediction = (p: number, low: number | undefined, high: number) => ({ outcome: { text: 'Breast Cancer' }, probabilityDecimal: p,
      whenRange: { ...(low !== undefined && { low: { value: low, unit: 'years' } }), high: { value: high, unit: 'years' } } });
    await s.create({ resourceType: 'RiskAssessment', status: 'final', identifier: [{ value: ident }], subject: { reference: 'Patient/test' },
      prediction: [prediction(0.000168, undefined, 53), prediction(0.000368, 54, 57), prediction(0.000594, 58, 62), prediction(0.000838, 63, 67)] });
    const result = await search(s, q('RiskAssessment', ['identifier', ident], ['probability', 'gt0.0005']));
    expect(result.entry).toHaveLength(1);
  }));

  test('project-scoped Repository w/ %j › Sort by unknown search parameter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const e = await error(s, 'Patient?_sort=xyz');
    expect(e.status).toBe(400);
    expect(e.text).toMatch(/^Unknown search parameter: xyz$/);
    return e;
  }));

  // Medplum special-cases MeasureReport.period (a trial of range columns): eq and ne as overlap, lt and gt against the far end
  // of the search value. The store treats it as every date parameter: R4 eq (the search value's range contains the period)
  // and lt/gt from the search value's own start and end. le, ge, sa and eb agree.
  test('differs on purpose: project-scoped Repository w/ %j › Date range search [server/src/fhir/search.test.ts]', async () => {
    const values = ['2019-12-31', '2020-01-01', '2020-01-02', '2020-01-15', '2020-01-16',
      '2020-01-01T11:59:59.000Z', '2020-01-01T12:00:00.000Z', '2020-01-15T11:59:59.000Z', '2020-01-15T12:00:00.000Z', '2020-01-15T12:00:01.000Z'];
    const same4 = { // 1: found, per value above
      le: [0, 1, 1, 1, 1, 0, 1, 1, 1, 1], ge: [1, 1, 1, 1, 0, 1, 1, 1, 1, 0], sa: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0], eb: [0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    const [medplum, store] = await both(sides, async (s) => {
      const ident = crypto.randomUUID();
      await s.create({ resourceType: 'MeasureReport', status: 'complete', type: 'individual', measure: 'http://example.com', identifier: [{ value: ident }],
        period: { start: '2020-01-01T12:00:00.000Z', end: '2020-01-15T12:00:00.000Z' } });
      const got: Record<string, number[]> = {};
      for (const prefix of ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'sa', 'eb']) {
        got[prefix] = [];
        for (const v of values) got[prefix].push((await search(s, q('MeasureReport', ['identifier', ident], ['period', `${prefix}${v}`]))).entry?.length ? 1 : 0);
      }
      return got;
    });
    expect(medplum).toEqual({ ...same4, // Medplum's test
      eq: [0, 1, 1, 1, 0, 0, 1, 1, 1, 0], ne: [1, 0, 0, 0, 1, 1, 0, 0, 0, 1], lt: [0, 1, 1, 1, 1, 0, 0, 1, 1, 1], gt: [1, 1, 1, 1, 0, 1, 1, 1, 0, 0] });
    expect(store).toEqual({ ...same4,
      eq: Array(10).fill(0), ne: Array(10).fill(1), lt: [0, 0, 1, 1, 1, 0, 0, 1, 1, 1], gt: [1, 1, 1, 0, 0, 1, 1, 1, 0, 0] });
  });

  // Medplum's {resourceType: 'Patient', types: [...]} search is Patient?_type=...: both servers search the _type list and ignore
  // the path type. Next links: Medplum's are .../Patient?..._offset= or _cursor=, the store's ...R4?..._cursor=; each side
  // follows its own.
  const next = (b: Bundle) => b.link?.find((l) => l.relation === 'next')?.url;
  const follow = async (s: Side, path: string) => {
    const ids: string[] = [], sizes: number[] = [], links: string[] = [];
    for (let p: string | undefined = path; p;) {
      const b = await search(s, p);
      sizes.push(b.entry?.length ?? 0);
      ids.push(...(b.entry ?? []).map((e) => e.resource!.id!));
      const n = next(b);
      if (n) links.push(n);
      p = n?.slice(`${s.base}fhir/R4`.length).replace(/^\//, '');
    }
    return { ids, sizes, links };
  };
  const nextKind = (s: Side) => (s.name === 'medplum' ? '_offset=' : '_cursor=');

  test('project-scoped Repository w/ %j › Multiple resource types with _type [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const obs = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient) });
    const bundle = await search(s, `Patient?_type=Patient,Observation&_compartment=Patient/${patient.id}`);
    expect(bundle.entry?.length).toBe(2);
    expect(has(bundle, patient)).toBeTruthy();
    expect(has(bundle, obs)).toBeTruthy();
  }));

  // README, deliberate differences: the store pages a system search by cursor; the set, order and page sizes are the same.
  test('differs on purpose: project-scoped Repository w/ %j › Multiple resource types with _type uses offset pagination across combined results [server/src/fhir/search.test.ts]', () => both(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const expectedIds = [patient.id];
    for (let i = 0; i < 4; i++) expectedIds.push((await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient) })).id);
    const { ids, sizes, links } = await follow(s, `Patient?_type=Patient,Observation&_compartment=Patient/${patient.id}&_sort=_id&_count=2`);
    for (const l of links) {
      expect(new URL(l).searchParams.get('_type')).toBe('Patient,Observation');
      expect(l).toContain(nextKind(s)); // each side's own: Medplum pages by offset here, the store by cursor
    }
    expect(sizes).toStrictEqual([2, 2, 1]);
    expect([...ids].sort()).toEqual([...expectedIds].sort());
    expect(ids).toEqual([...ids].sort()); // in _id order across pages and types
  }));

  test('project-scoped Repository w/ %j › searchByReference › Cursor pagination with multiple resource types from _type [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const expectedIds = [patient.id];
    for (let i = 0; i < 49; i++) expectedIds.push((await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'cursor_type_test' }, subject: ref(patient) })).id);
    const { ids, links } = await follow(s, `Patient?_type=Patient,Observation&_compartment=Patient/${patient.id}&_sort=_lastUpdated&_count=20`);
    for (const l of links) {
      expect(new URL(l).searchParams.get('_type')).toBe('Patient,Observation');
      expect(l).toContain('_cursor=');
    }
    expect(ids.length).toBe(50);
    expect([...ids].sort()).toEqual([...expectedIds].sort());
    expect(ids).toEqual(expectedIds); // created in order, so _lastUpdated order
  }));

  // Beyond Medplum's tests: _type checked against Medplum's answers.
  test('_type: a parameter one type lacks is 400 with Medplum\'s text', () => same(sides, async (s) => error(s, '?_type=Patient,Observation&code=x')));

  test('_type: the last _type counts, a type listed twice is one', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const obs = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient) });
    const named = { patient, obs };
    const c = `_compartment=Patient/${patient.id}`;
    return [
      names(await search(s, `?_type=Patient&_type=Observation&${c}`), named),
      names(await search(s, `?_type=Nope&_type=Patient&${c}`), named),
      await error(s, `?_type=Patient&_type=Nope&${c}`),
      names(await search(s, `?_type=Patient,Patient&${c}`), named),
    ];
  }));

  test('_type with _include and _revinclude', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const obs = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient) });
    const cond = await s.create({ resourceType: 'Condition', subject: ref(patient) });
    const named = { patient, obs, cond };
    return [
      names(await search(s, `?_type=Observation,Condition&subject=Patient/${patient.id}&_include=Observation:subject&_sort=_lastUpdated`), named),
      names(await search(s, `?_type=Patient&_id=${patient.id}&_revinclude=Observation:subject&_revinclude=Condition:subject`), named),
    ];
  }));

  test('_type with _summary, _elements and _total', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient), valueString: 'x' });
    await s.create({ resourceType: 'Condition', subject: ref(patient), note: [{ text: 'x' }] });
    const c = `_type=Observation,Condition&_compartment=Patient/${patient.id}&_sort=_lastUpdated`;
    const keys = (b: Bundle) => b.entry?.map((e) => Object.keys(e.resource!).filter((k) => k !== 'meta').sort());
    const tags = (b: Bundle) => b.entry?.map((e) => e.resource!.meta?.tag?.map((t) => t.code));
    const elements = await search(s, `?${c}&_elements=subject&_total=accurate`);
    const summary = await search(s, `?${c}&_summary=true`);
    return [elements.total, keys(elements), tags(elements), keys(summary), tags(summary)];
  }));

  // README, deliberate differences: R4's POST [base]/_search is the system search; Medplum 5.2.14 has no such route.
  test('differs on purpose: POST _search at the system level', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const patient = await s.create({ resourceType: 'Patient' });
      const g = await s.call('POST', '_search', `_type=Patient,Observation&_compartment=Patient/${patient.id}`, { 'content-type': 'application/x-www-form-urlencoded' });
      return { status: g.status, text: g.json?.issue?.[0]?.details?.text, ids: g.json?.entry?.map((e: { resource: { id: string } }) => e.resource.id), patient: patient.id };
    });
    expect([medplum.status, medplum.text]).toEqual([400, 'Incorrect resource type: expected _search, but found <EMPTY>']);
    expect([store.status, store.ids]).toEqual([200, [store.patient]]);
  });

  // README, deliberate differences: _summary=count counts every listed type (Medplum's count of a _type search counts one).
  test('differs on purpose: _type with _summary=count', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const patient = await s.create({ resourceType: 'Patient' });
      await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient) });
      await s.create({ resourceType: 'Condition', subject: ref(patient) });
      return (await search(s, `?_type=Observation,Condition&_compartment=Patient/${patient.id}&_summary=count`)).total;
    });
    expect(medplum).toBe(1);
    expect(store).toBe(2);
  });

  // Medplum's code=cursor_test matches the code's text by plain equality (the store needs :text; README): a coded marker here.
  test('project-scoped Repository w/ %j › searchByReference › Cursor pagination [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = marker();
    for (let i = 0; i < 50; i++) await s.create({ resourceType: 'Task', status: 'accepted', intent: 'order', code: { coding: [{ code }] } });
    const { ids, links } = await follow(s, `Task?code=${code}&_sort=_lastUpdated`);
    for (const l of links) expect(l.includes('_cursor')).toBe(true);
    expect(ids.length).toBe(50);
  }));

  test('project-scoped Repository w/ %j › Binary search not allowed [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const e = await error(s, 'Binary');
    expect(e.status).toBe(400);
    expect(e.text).toContain('Cannot search on Binary resource type');
    return e;
  }));

  test('project-scoped Repository w/ %j › US Core Search Parameters › USCoreCareTeamRole [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const careTeam = await s.create({ resourceType: 'CareTeam', participant: [{ member: { reference: 'Practitioner/123' }, role: [{ coding: [{ system: SNOMED, code: '102262009', display: 'Chocolate (substance)' }] }] }] });
    const bundle1 = await search(s, 'CareTeam?role=102262009');
    expect(names(bundle1, { careTeam })).toEqual(['careTeam']);
  }));

  test('project-scoped Repository w/ %j › US Core Search Parameters › USCoreConditionAssertedDate [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const resource = await s.create({ resourceType: 'Condition', extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/condition-assertedDate', valueDateTime: '2000-03-18' }],
      subject: { reference: 'Patient/123', display: 'Matt Long' } });
    const bundle1 = await search(s, q('Condition', ['asserted-date', `sa${new Date(1999, 11, 30).toISOString()}`]));
    expect(names(bundle1, { resource })).toEqual(['resource']);
  }));

  test('project-scoped Repository w/ %j › US Core Search Parameters › USCoreEncounterDischargeDisposition [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const resource = await s.create({ resourceType: 'Encounter', status: 'unknown', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' },
      hospitalization: { dischargeDisposition: { coding: [{ system: 'http://www.nubc.org/patient-discharge', code: '01', display: 'Discharged to Home' }] } } });
    expect(names(await search(s, 'Encounter?discharge-disposition=01'), { resource })).toEqual(['resource']);
    expect((await search(s, 'Encounter?discharge-disposition=55')).entry?.length ?? 0).toBe(0);
  }));

  test('project-scoped Repository w/ %j › US Core Search Parameters › USCoreGoalDescription [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const resource = await s.create({ resourceType: 'Goal', lifecycleStatus: 'active',
      description: { coding: [{ system: SNOMED, code: '406156006', display: 'In paid employment' }], text: 'This text is ignored in search.' }, subject: { reference: 'Patient/example', display: 'Amy Shaw' } });
    expect(names(await search(s, 'Goal?description=406156006'), { resource })).toEqual(['resource']);
  }));

  test('project-scoped Repository w/ %j › US Core Search Parameters › USCorePatient race, ethnicity, genderIdentity [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const oid = 'urn:oid:2.16.840.1.113883.6.238';
    const sub = (url: string, code: string, display: string) => ({ url, valueCoding: { system: oid, code, display } });
    const resource = await s.create({
      resourceType: 'Patient',
      extension: [
        { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race', extension: [sub('ombCategory', '2106-3', 'White'), sub('ombCategory', '1002-5', 'American Indian or Alaska Native'),
          sub('ombCategory', '2028-9', 'Asian'), sub('detailed', '1586-7', 'Shoshone'), sub('detailed', '2036-2', 'Filipino'), { url: 'text', valueString: 'Mixed' }] },
        { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity', extension: [sub('ombCategory', '2135-2', 'Hispanic or Latino'), sub('detailed', '2184-0', 'Dominican'),
          sub('detailed', '2148-5', 'Mexican'), { url: 'text', valueString: 'Hispanic or Latino' }] },
        { url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-genderIdentity',
          valueCodeableConcept: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor', code: 'ASKU', display: 'asked but unknown' }], text: 'asked but unknown' } },
      ],
    });
    // Medplum's project is shared: this patient must be the one match among this file's records of each.
    for (const query of ['race=1002-5', 'race=1586-7', 'ethnicity=2135-2', 'ethnicity=2184-0', 'gender-identity=ASKU']) {
      expect(names(await search(s, `Patient?${query}`), { resource }), query).toEqual(['resource']);
    }
  }));

  test('project-scoped Repository w/ %j › Reference search with inline resource [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const date = new Date().toISOString();
    const composition = await s.create({ resourceType: 'Composition', status: 'final', type: { text: 'test' }, date, author: [{ reference: 'Practitioner/example' }], title: 'Test Composition' });
    const bundle = await s.create({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: composition }] } as Bundle);
    const searchResult1 = await search(s, `Bundle?composition=Composition/${composition.id}`);
    expect(names(searchResult1, { bundle })).toEqual(['bundle']);
    const searchResult2 = await search(s, `Bundle?composition.date=${encodeURIComponent(date)}`);
    expect(names(searchResult2, { bundle })).toEqual(['bundle']);
  }));

  test('project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param: bare uuid matches (DeviceRequest.encounter) [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const encounter = await s.create({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: ref(patient) });
    const deviceRequest = await s.create({ resourceType: 'DeviceRequest', status: 'active', intent: 'order', subject: ref(patient), encounter: ref(encounter), codeCodeableConcept: { text: 'Test device' } });
    expect(names(await search(s, `DeviceRequest?encounter=${encounter.id}`), { deviceRequest })).toEqual(['deviceRequest']);
    expect(names(await search(s, `DeviceRequest?encounter=Encounter/${encounter.id}`), { deviceRequest })).toEqual(['deviceRequest']);
  }));

  test('project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param: bare uuid matches (PractitionerRole.practitioner) [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const practitioner = await s.create({ resourceType: 'Practitioner' });
    const role = await s.create({ resourceType: 'PractitionerRole', practitioner: ref(practitioner) });
    expect(names(await search(s, `PractitionerRole?practitioner=${practitioner.id}`), { role })).toEqual(['role']);
  }));

  test('project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Single-target reference param on array column: bare uuid matches (Encounter.location) [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const location = await s.create({ resourceType: 'Location', name: crypto.randomUUID() });
    const encounter = await s.create({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, location: [{ location: ref(location) }] });
    expect(names(await search(s, `Encounter?location=${location.id}`), { encounter })).toEqual(['encounter']);
  }));

  test('project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Back-compat: bare uuid on multi-target subject column still defaults to Patient [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const observation = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'back-compat probe' }, subject: ref(patient) });
    expect(has(await search(s, `Observation?subject=${patient.id}`), observation)).toBe(true);
  }));

  test('project-scoped Repository w/ %j › Reference search bare-id prefix derivation › Non-uuid bare value is not rewritten (avoids corrupting unrelated values) [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    expect((await search(s, 'DeviceRequest?encounter=not-a-uuid')).entry ?? []).toHaveLength(0);
  }));

  const weights = once(async (s) => {
    for (const weight of [70, 75, 80, 85, 90]) {
      await s.create({ resourceType: 'Observation', status: 'final', code: { coding: [{ code: '29463-7' }] }, valueQuantity: { value: weight, unit: 'kg', system: UCUM, code: 'kg' } });
    }
  });
  const quantity = (query: string, want: number[]) => () => same(sides, async (s) => {
    await weights(s);
    const result = await search(s, `Observation?code=29463-7&value-quantity=${query}`);
    const got = result.entry?.map((e) => (e.resource as { valueQuantity?: { value?: number } }).valueQuantity?.value).sort();
    expect(got).toEqual(want);
    return got;
  });
  test('project-scoped Repository w/ %j › Quantity search › Basic [server/src/fhir/search.test.ts]', quantity('gt80', [85, 90]));
  test('project-scoped Repository w/ %j › Quantity search › With units [server/src/fhir/search.test.ts]', quantity(`gt80|${UCUM}|kg`, [85, 90]));
  test('project-scoped Repository w/ %j › Quantity search › Approximately [server/src/fhir/search.test.ts]', quantity(`ap80|${UCUM}|kg`, [75, 80, 85]));

  // Medplum's test expects all three to match with its range-search feature (and skips without it). The instant matches the
  // day 2028-06-01 on Medplum in both modes; the store follows R4 eq (an instant does not contain a day) and differs from both.
  // lt2028-06-06 matches on the store as with range-search; this Medplum, without the feature, ignores the prefix of a
  // multi-valued date (no match). Both refuse 2028-06 (Medplum accepts it only with range-search).
  test('differs on purpose: project-scoped Repository w/ %j › Date array columns match search value %s [server/src/fhir/search.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const out = [];
      for (const value of ['2028-06-01T23:45:56.890-11:00', '2028-06', 'lt2028-06-06']) {
        const identifier = crypto.randomUUID();
        await s.create({ resourceType: 'Goal', identifier: [{ value: identifier }], lifecycleStatus: 'active', description: { text: 'Test' }, subject: { reference: 'Patient/example' }, target: [{ dueDate: '2028-06-01' }] });
        const g = await s.call('GET', q('Goal', ['identifier', identifier], ['target-date', value]));
        out.push(g.status === 200 ? g.json.entry?.length ?? 0 : g.json.issue?.[0]?.details?.text);
      }
      return out;
    });
    expect(medplum).toEqual([1, 'Invalid date value: 2028-06', 0]);
    expect(store).toEqual([0, 'Invalid date value: 2028-06', 1]);
  });

  // systemRepo can set meta.lastUpdated; over HTTP each side's own lastUpdated values stand in for "1 and 2 seconds ago".
  test('systemRepo › Filter by _lastUpdated [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const patient2 = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Alice'], family }] });
    await pause();
    const patient1 = await s.create<Patient>({ resourceType: 'Patient', name: [{ given: ['Alice'], family }] });
    const [t1, t2] = [patient1.meta?.lastUpdated as string, patient2.meta?.lastUpdated as string];
    const before2 = new Date(Date.parse(t2) - 1000).toISOString();
    const named = { patient1, patient2 };
    const out = [];
    for (const [query, want] of [
      [[['_lastUpdated', `gt${t2}`]], ['patient1']], [[['_lastUpdated', `ge${t2}`]], ['patient1', 'patient2']],
      [[['_lastUpdated', `gt${before2}`], ['_lastUpdated', `lt${t1}`]], ['patient2']], [[['_lastUpdated', `gt${before2}`], ['_lastUpdated', `le${t1}`]], ['patient1', 'patient2']],
    ] as [[string, string][], string[]][]) {
      const got = names(await search(s, q('Patient', ['name', family], ...query)), named).sort();
      expect(got, JSON.stringify(query)).toEqual(want);
      out.push(got);
    }
    return out;
  }));

  test('systemRepo › Sort by _lastUpdated [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice1'], family }] });
    await pause();
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice2'], family }] });
    const bundle3 = await search(s, q('Patient', ['name', family], ['_sort', '_lastUpdated']));
    expect(names(bundle3, { patient1, patient2 })).toEqual(['patient1', 'patient2']);
    const bundle4 = await search(s, q('Patient', ['name', family], ['_sort', '-_lastUpdated']));
    expect(names(bundle4, { patient1, patient2 })).toEqual(['patient2', 'patient1']);
  }));
});
