// Medplum 5.2.14 packages/server/src/fhir/search.test.ts, first part (to "Subject search without resource type"), ported side by
// side (see harness.ts); search-more.test.ts has the rest. Medplum's SearchRequest objects become the query strings
// parseSearchRequest reads back into them; NOT_EQUALS on a token, reference or _id has no HTTP prefix and is :not.
// Medplum's project is shared by the file (Medplum gives each describe one), so searches filter on values the test created.
import { readFileSync } from 'node:fs';
import type { Bundle, Patient, Resource, SearchParameter, ServiceRequest, StructureDefinition } from '@medplum/fhirtypes';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { both, error, marker, names, paritySides, q, ref, same, search, type Side } from './harness.ts';

const SUBSET_TAG = { system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' };
const rels = (b: Bundle) => b.link?.map((l) => l.relation);
const has = (b: Bundle, r: { id: string }) => !!b.entry?.some((e) => e.resource?.id === r.id);
// The R4 definitions Medplum serves as records (the store holds only what is written to it).
const r4 = <T>(file: string) => (JSON.parse(readFileSync(new URL(`../fhir/r4/${file}`, import.meta.resolve('@medplum/definitions')), 'utf8')) as Bundle<T & Resource>).entry!.map((e) => e.resource!);
const r4SearchParams = r4<SearchParameter>('search-parameters.json');

describe.skipIf(SQLITE)('Medplum search.test.ts (parity, part 1)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  test('project-scoped Repository w/ %j › Search total [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }] });
    await s.create({ resourceType: 'Patient', name: [{ given: ['Bob'], family: 'Smith' }] });
    const result1 = await search(s, 'Patient?_count=1');
    expect(result1.total).toBeUndefined();
    expect(result1.link?.length).toBe(3);
    const result2 = await search(s, 'Patient?_total=none');
    expect(result2.total).toBeUndefined();
    const result3 = await search(s, 'Patient?_total=accurate');
    expect(typeof result3.total).toBe('number');
    const result4 = await search(s, 'Patient?_total=estimate');
    expect(typeof result4.total).toBe('number');
    return rels(result1);
  }));

  test('project-scoped Repository w/ %j › Search count=0 [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const result1 = await search(s, 'Patient?_count=0');
    expect(result1.entry).toBeUndefined();
    expect(result1.link?.length).toBe(1);
    return rels(result1);
  }));

  test('project-scoped Repository w/ %j › Search _elements [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const resource = await s.create<Patient>({
      resourceType: 'Patient', birthDate: '2000-01-01',
      _birthDate: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime', valueDateTime: '2000-01-01T00:00:00.001Z' }] },
      multipleBirthInteger: 2, deceasedBoolean: false,
    } as Patient);
    const results = await search(s, q('Patient', ['_id', resource.id], ['_elements', 'birthDate,deceased']));
    expect(results.entry).toHaveLength(1);
    const result = results.entry?.[0]?.resource;
    expect(result).toEqual({
      resourceType: 'Patient', id: resource.id, meta: expect.objectContaining({ tag: [SUBSET_TAG] }),
      birthDate: resource.birthDate, _birthDate: (resource as { _birthDate?: unknown })._birthDate, deceasedBoolean: resource.deceasedBoolean,
    });
    return result;
  }));

  test('project-scoped Repository w/ %j › Search next link [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    for (let i = 0; i < 2; i++) await s.create({ resourceType: 'Patient', name: [{ family }] });
    const out = [];
    for (const [count, n, next] of [[1, 1, true], [2, 2, false], [3, 2, false]] as const) {
      const result = await search(s, q('Patient', ['name', family], ['_count', String(count)]));
      expect(result.entry).toHaveLength(n);
      expect(result.link).toBeDefined();
      expect(!!result.link?.find((e) => e.relation === 'next')).toBe(next);
      out.push(rels(result));
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Search previous link [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    for (let i = 0; i < 2; i++) await s.create({ resourceType: 'Patient', name: [{ family }] });
    const result1 = await search(s, q('Patient', ['name', family], ['_count', '1'], ['_offset', '1']));
    expect(result1.entry).toHaveLength(1);
    expect(result1.link?.find((e) => e.relation === 'previous')).toBeDefined();
    return rels(result1);
  }));

  test('project-scoped Repository w/ %j › Search for Communications by Encounter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }] });
    const encounter1 = await s.create({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'HH', display: 'home health' }, subject: ref(patient1) });
    const comm1 = await s.create({ resourceType: 'Communication', status: 'completed', encounter: ref(encounter1), subject: ref(patient1), sender: ref(patient1), payload: [{ contentString: 'This is a test' }] });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Bob'], family: 'Jones' }] });
    const encounter2 = await s.create({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'HH', display: 'home health' }, subject: ref(patient2) });
    const comm2 = await s.create({ resourceType: 'Communication', status: 'completed', encounter: ref(encounter2), subject: ref(patient2), sender: ref(patient2), payload: [{ contentString: 'This is another test' }] });
    const searchResult = await search(s, q('Communication', ['encounter', `Encounter/${encounter1.id}`]));
    expect(searchResult.entry?.length).toBe(1);
    expect(searchResult.entry?.[0]?.resource?.id).toBe(comm1.id);
    return names(searchResult, { comm1, comm2 });
  }));

  test('project-scoped Repository w/ %j › Search for Communications by ServiceRequest [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }] });
    const serviceRequest1 = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: { text: 'text' }, subject: ref(patient1) });
    const comm1 = await s.create({ resourceType: 'Communication', status: 'completed', basedOn: [ref(serviceRequest1)], subject: ref(patient1), sender: ref(patient1), payload: [{ contentString: 'This is a test' }] });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ given: ['Bob'], family: 'Jones' }] });
    const serviceRequest2 = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: { text: 'test' }, subject: ref(patient2) });
    const comm2 = await s.create({ resourceType: 'Communication', status: 'completed', basedOn: [ref(serviceRequest2)], subject: ref(patient2), sender: ref(patient2), payload: [{ contentString: 'This is another test' }] });
    const searchResult = await search(s, q('Communication', ['based-on', `ServiceRequest/${serviceRequest1.id}`]));
    expect(searchResult.entry?.length).toBe(1);
    expect(searchResult.entry?.[0]?.resource?.id).toBe(comm1.id);
    return names(searchResult, { comm1, comm2 });
  }));

  test('project-scoped Repository w/ %j › Search for QuestionnaireResponse by Questionnaire [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const questionnaire = await s.create({ resourceType: 'Questionnaire', url: 'https://example.com/yet-another-example-questionnaire', status: 'active' });
    const response1 = await s.create({ resourceType: 'QuestionnaireResponse', status: 'completed', questionnaire: questionnaire.url });
    const response2 = await s.create({ resourceType: 'QuestionnaireResponse', status: 'completed', questionnaire: 'https://example.com/a-different-example-questionnaire' });
    const bundle = await search(s, q('QuestionnaireResponse', ['questionnaire', questionnaire.url as string]));
    expect(bundle.entry?.length).toBe(1);
    expect(bundle.entry?.[0]?.resource?.id).toBe(response1.id);
    return names(bundle, { response1, response2 });
  }));

  // Medplum serves the R4 SearchParameters as records; the store side is given the ones the test looks for.
  test('project-scoped Repository w/ %j › Search for token in array [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    if (s.name === 'store') for (const p of r4SearchParams.filter((p) => p.base.includes('Patient') && (p.code === 'name' || p.code === 'email'))) await s.create(p);
    const bundle = await search(s, 'SearchParameter?base=Patient&_count=100');
    const found = ['name', 'email'].map((code) => !!bundle.entry?.find((e) => (e.resource as SearchParameter).code === code));
    expect(found).toEqual([true, true]);
    return found;
  }));

  const sortOnly = (title: string, code: string) => test(title, () => same(sides, async (s) => {
    expect(await search(s, `Patient?_sort=${code}`)).toBeDefined();
  }));
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.id [server/src/fhir/search.test.ts]', '_id');
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.meta.lastUpdated [server/src/fhir/search.test.ts]', '_lastUpdated');
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.identifier [server/src/fhir/search.test.ts]', 'identifier');
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.name [server/src/fhir/search.test.ts]', 'name');
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.given [server/src/fhir/search.test.ts]', 'given');

  test('project-scoped Repository w/ %j › Search sort by Patient.address [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const identifier = marker();
    await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: 'https://www.example.com', value: identifier }],
      address: [{ line: ['1234 Fake Street'], city: 'Fake City', state: 'OK', postalCode: '99999', country: 'US' }] });
    const bundle = await search(s, q('Patient', ['_sort', 'address'], ['identifier', identifier]));
    expect(bundle.entry?.map((e) => (e.resource as Patient).identifier?.[0]?.value)).toStrictEqual([identifier]);
  }));

  test('project-scoped Repository w/ %j › Search sort by Patient.postalCode [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const identifier = marker();
    await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Hopper' }], identifier: [{ system: 'https://www.example.com', value: identifier }],
      address: [{ line: ['1234 Fake Street'], city: 'Fake City', state: 'OK', postalCode: '123456789', country: 'US' }] });
    const bundle = await search(s, q('Patient', ['_sort', 'address-postalcode'], ['identifier', identifier]));
    expect(bundle.entry?.map((e) => (e.resource as Patient).identifier?.[0]?.value)).toStrictEqual([identifier]);
  }));

  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.telecom [server/src/fhir/search.test.ts]', 'telecom');
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.email [server/src/fhir/search.test.ts]', 'email');
  sortOnly('project-scoped Repository w/ %j › Search sort by Patient.birthDate [server/src/fhir/search.test.ts]', 'birthdate');

  test('project-scoped Repository w/ %j › Filter and sort on same search parameter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    await s.create({ resourceType: 'Patient', name: [{ given: ['Marge'], family: 'Simpson' }] });
    await s.create({ resourceType: 'Patient', name: [{ given: ['Homer'], family: 'Simpson' }] });
    const bundle = await search(s, 'Patient?family=Simpson&_sort=family');
    expect(bundle.entry?.length).toBeGreaterThanOrEqual(2);
  }));

  test('project-scoped Repository w/ %j › Search birthDate after delete [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family }], birthDate: '1971-02-02' });
    const path = q('Patient', ['family', family], ['birthdate', '1971-02-02']);
    const searchResult1 = await search(s, path);
    expect(searchResult1.entry?.length).toBe(1);
    expect(searchResult1.entry?.[0]?.resource?.id).toBe(patient.id);
    expect((await s.call('DELETE', `Patient/${patient.id}`)).status).toBe(200);
    expect((await search(s, path)).entry?.length ?? 0).toBe(0);
  }));

  test('project-scoped Repository w/ %j › Search identifier after delete [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const identifier = marker();
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family: 'Smith' }], identifier: [{ system: 'https://www.example.com', value: identifier }] });
    const path = q('Patient', ['identifier', identifier]);
    const searchResult1 = await search(s, path);
    expect(searchResult1.entry?.length).toBe(1);
    expect(searchResult1.entry?.[0]?.resource?.id).toBe(patient.id);
    expect((await s.call('DELETE', `Patient/${patient.id}`)).status).toBe(200);
    expect((await search(s, path)).entry?.length ?? 0).toBe(0);
  }));

  // Medplum serves the R4 StructureDefinitions as records; the store side is given the two the test finds.
  test('project-scoped Repository w/ %j › String filter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    if (s.name === 'store') for (const sd of r4<StructureDefinition>('profiles-resources.json').filter((r) => r.resourceType === 'StructureDefinition' && r.name?.startsWith('Questionnaire'))) await s.create(sd);
    const bundle1 = await search(s, 'StructureDefinition?name=Questionnaire&_sort=name');
    expect(bundle1.entry?.map((e) => (e.resource as { name?: string }).name)).toStrictEqual(['Questionnaire', 'QuestionnaireResponse']);
    const bundle2 = await search(s, 'StructureDefinition?name:exact=Questionnaire');
    expect(bundle2.entry?.length).toBe(1);
    expect((bundle2.entry?.[0]?.resource as { name?: string }).name).toBe('Questionnaire');
  }));

  test('project-scoped Repository w/ %j › String filter with escaped commas [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const name = marker().replaceAll('-', ',');
    const location = await s.create({ resourceType: 'Location', name });
    const bundle = await search(s, q('Location', ['name:exact', name.replaceAll(',', '\\,')]));
    expect(bundle.entry?.length).toBe(1);
    expect(has(bundle, location)).toBe(true);
  }));

  test('project-scoped Repository w/ %j › Filter by _id [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['Alice'], family }] });
    const searchResult1 = await search(s, q('Patient', ['_id', patient.id]));
    expect(searchResult1.entry?.length).toBe(1);
    expect(has(searchResult1, patient)).toBe(true);
    const searchResult2 = await search(s, q('Patient', ['name', family], ['_id:not', patient.id]));
    expect(searchResult2.entry?.length ?? 0).toBe(0);
  }));

  test('project-scoped Repository w/ %j › Filter by _id with %s=%s [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const out = [];
    for (const [modifier, value, expectedMatch] of [['missing', 'false', true], ['missing', 'true', false], ['present', 'true', true], ['present', 'false', false]] as const) {
      const family = marker();
      const patient = await s.create({ resourceType: 'Patient', name: [{ family }] });
      const result = await search(s, q('Patient', ['name:exact', family], [`_id:${modifier}`, value]));
      expect(has(result, patient), `_id:${modifier}=${value}`).toBe(expectedMatch);
      out.push(has(result, patient));
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Filter by chained _id [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const organizationId = crypto.randomUUID();
    const patient = await s.create({ resourceType: 'Patient', managingOrganization: { reference: 'Organization/' + organizationId } });
    const searchResult1 = await search(s, 'Patient?organization._id=' + organizationId);
    expect(searchResult1.entry?.length).toBe(1);
    expect(has(searchResult1, patient)).toBe(true);
  }));

  test('project-scoped Repository w/ %j › Filter by chained _id presence [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const organization = await s.create({ resourceType: 'Organization' });
    const patient = await s.create({ resourceType: 'Patient', managingOrganization: ref(organization) });
    expect(has(await search(s, 'Patient?organization._id:missing=false&_count=1000'), patient)).toBe(true);
    expect(has(await search(s, 'Patient?organization._id:missing=true&_count=1000'), patient)).toBe(false);
  }));

  test('project-scoped Repository w/ %j › Reverse filter by chained _id [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const location = await s.create({ resourceType: 'Location' });
    const healthcareService = await s.create({ resourceType: 'HealthcareService', location: [ref(location)] });
    const searchResult = await search(s, `Location?_has:HealthcareService:location:_id=${healthcareService.id}`);
    expect(searchResult.entry?.[0]?.resource?.id).toBe(location.id);
    expect(has(await search(s, 'Location?_has:HealthcareService:location:_id:missing=false&_count=1000'), location)).toBe(true);
    expect(has(await search(s, 'Location?_has:HealthcareService:location:_id:missing=true&_count=1000'), location)).toBe(false);
  }));

  test('project-scoped Repository w/ %j › Empty _id [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    expect((await search(s, 'Patient?_id=')).entry?.length ?? 0).toBe(0);
  }));

  test('project-scoped Repository w/ %j › Non UUID _id [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    expect((await search(s, 'Patient?_id=x')).entry?.length ?? 0).toBe(0);
  }));

  // Over HTTP @medplum/core's parser rejects a ' ' for 'T' ("Invalid format for date search parameter") before the server's own
  // check that Medplum's test calls directly accepts it: those three are invalid here.
  test('project-scoped Repository w/ %j › Handle_lastUpdated value %s, isValid? %s [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const out = [];
    for (const [value, isValid] of [
      ['xyz', false], ['1985', false], ['1985-11', false], ['1985-11-30', true], ['1985-11-30T05:05', true], ['1985-11-30 05:05', false],
      ['1985-11-30T05:05Z', true], ['1985-11-30 05:05Z', false], ['1985-11-30T05:05:55', true], ['1985-11-30 05:05:55', false],
      ['1985-11-30T05:05:55Z', true], ['1985-11-30T05:05:55.000Z', true], ['1985-11-30T05:05:55.000000000Z', true], ['1985-11-30T05:05:55+05:05', true],
      ['1985-11-30T05:05:55-13:30', true], ['1985-11-30T05:05:55-14:00', true], ['1985-11-30T05:05:55.000000000-14:00', true], ['1985-11-30T05:05:55-15:00', false],
    ] as const) {
      const g = await s.call('GET', q('Patient', ['_lastUpdated', `lt${value}`]));
      if (isValid) {
        expect(g.status, value).toBe(200);
        expect(g.json.entry?.length ?? 0, value).toBe(0);
      } else {
        expect(g.status, value).toBe(400);
        expect([`Invalid date value: ${value}`, `Invalid format for date search parameter: ${value}`], value).toContain(g.json.issue?.[0]?.details?.text);
      }
      out.push([g.status, g.json.issue?.[0]?.details?.text]);
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Handle string with null bytes [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const e = await error(s, q('Patient', ['_id', 'foo\x00bar']));
    expect(e).toEqual({ status: 400, text: 'Search filter value cannot contain null bytes' });
    return e;
  }));

  test('project-scoped Repository w/ %j › Filter by Coding [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const auditEvents = [];
    for (let i = 0; i < 3; i++) {
      auditEvents.push(await s.create({
        resourceType: 'AuditEvent', recorded: new Date().toISOString(), type: { code: crypto.randomUUID() },
        agent: [{ who: { reference: 'Practitioner/' + crypto.randomUUID() }, requestor: true }], source: { observer: { reference: 'Practitioner/' + crypto.randomUUID() } },
      }));
    }
    for (const a of auditEvents) {
      const bundle = await search(s, q('AuditEvent', ['type', a.type.code as string]));
      expect(bundle.entry?.length).toBe(1);
      expect(bundle.entry?.[0]?.resource?.id).toBe(a.id);
    }
  }));

  test('project-scoped Repository w/ %j › Filter by CodeableConcept [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const xs = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['John'], family: 'CodeableConcept' }] });
    const srs: Record<string, { id: string }> = {};
    for (const [i, x] of xs.entries()) srs[`serviceRequest${i + 1}`] = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: ref(patient), code: { coding: [{ code: x }] } });
    const out = [];
    for (const [i, x] of xs.entries()) {
      const bundle = await search(s, q('ServiceRequest', ['code', x]));
      expect(bundle.entry?.length).toBe(1);
      expect(names(bundle, srs)).toEqual([`serviceRequest${i + 1}`]);
      out.push(names(bundle, srs));
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Filter by Quantity.value [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const patient = await s.create({ resourceType: 'Patient', name: [{ given: ['John'], family: 'Quantity' }] });
    const obs: Record<string, { id: string }> = {};
    for (const [i, value] of [1, 5, 10].entries()) {
      obs[`observation${i + 1}`] = await s.create({ resourceType: 'Observation', status: 'final', subject: ref(patient), code: { coding: [{ code }] }, valueQuantity: { value, unit: 'mg' } });
    }
    const bundle1 = await search(s, q('Observation', ['code', code], ['_sort', 'value-quantity']));
    expect(names(bundle1, obs)).toEqual(['observation1', 'observation2', 'observation3']);
    const bundle2 = await search(s, q('Observation', ['code', code], ['_sort', '-value-quantity']));
    expect(names(bundle2, obs)).toEqual(['observation3', 'observation2', 'observation1']);
    const bundle3 = await search(s, q('Observation', ['code', code], ['value-quantity', 'gt8']));
    expect(names(bundle3, obs)).toEqual(['observation3']);
  }));

  // R4 defines :contains for string parameters only and a server SHALL reject a modifier it does not support: the store
  // answers 400. Medplum accepts it on a token (order-detail is a token on a string; it matched the whole value only).
  test('differs on purpose: project-scoped Repository w/ %j › ServiceRequest.orderDetail search [server/src/fhir/search.test.ts]', async () => {
    const [medplum, store] = await both(sides, async (s) => {
      const orderDetailText = crypto.randomUUID();
      const serviceRequest = await s.create({
        resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/' + crypto.randomUUID() }, code: { coding: [{ code: 'order-type' }] },
        orderDetail: [{ text: orderDetailText, coding: [{ system: 'custom-order-system', code: crypto.randomUUID() }] }],
      });
      const g = await s.call('GET', q('ServiceRequest', ['order-detail:contains', orderDetailText]));
      return { status: g.status, found: g.json.entry?.map((e: { resource: { id: string } }) => e.resource.id === serviceRequest.id), text: g.json.issue?.[0]?.details?.text };
    });
    expect(medplum).toEqual({ status: 200, found: [true], text: undefined });
    expect(store.status).toBe(400);
    expect(store.text).toMatch(/:contains/);
  });

  // Three ServiceRequests sharing a category, one code each.
  const threeCodes = async (s: Side, category = crypto.randomUUID()) => {
    const codes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const srs: Record<string, { id: string }> = {};
    for (const [i, code] of codes.entries()) {
      srs[`serviceRequest${i + 1}`] = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/' + crypto.randomUUID() },
        category: [{ coding: [{ code: category }] }], code: { coding: [{ code }] } });
    }
    return { category, codes, srs };
  };

  test('project-scoped Repository w/ %j › Comma separated value [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const { category, codes, srs } = await threeCodes(s);
    const bundle1 = await search(s, q('ServiceRequest', ['category', category], ['code', `${codes[0]},${codes[1]}`]));
    expect(names(bundle1, srs).sort()).toEqual(['serviceRequest1', 'serviceRequest2']);
  }));

  test('project-scoped Repository w/ %j › Token not equals [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const category = crypto.randomUUID(), code1 = crypto.randomUUID(), code2 = crypto.randomUUID();
    const sr = (code: string) => s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/' + crypto.randomUUID() }, category: [{ coding: [{ code: category }] }], code: { coding: [{ code }] } });
    const serviceRequest1 = await sr(code1), serviceRequest2 = await sr(code2);
    const bundle1 = await search(s, q('ServiceRequest', ['category', category], ['code:not', code1]));
    expect(names(bundle1, { serviceRequest1, serviceRequest2 })).toEqual(['serviceRequest2']);
  }));

  test('project-scoped Repository w/ %j › Token not equals matches missing value [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const patient1 = await s.create({ resourceType: 'Patient', name: [{ family }], gender: 'male' });
    const patient2 = await s.create({ resourceType: 'Patient', name: [{ family }] });
    const bundle1 = await search(s, q('Patient', ['name', family], ['gender:not', 'male']));
    expect(names(bundle1, { patient1, patient2 })).toEqual(['patient2']);
  }));

  test('project-scoped Repository w/ %j › Token array not equals [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const category1 = crypto.randomUUID(), category2 = crypto.randomUUID(), code = crypto.randomUUID();
    const sr = (category: string) => s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/' + crypto.randomUUID() }, category: [{ coding: [{ code: category }] }], code: { coding: [{ code }] } });
    const serviceRequest1 = await sr(category1), serviceRequest2 = await sr(category2);
    const bundle1 = await search(s, q('ServiceRequest', ['code', code], ['category:not', category1]));
    expect(names(bundle1, { serviceRequest1, serviceRequest2 })).toEqual(['serviceRequest2']);
  }));

  test('project-scoped Repository w/ %j › Null token array not equals [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const category1 = crypto.randomUUID(), code = crypto.randomUUID();
    const base: Omit<ServiceRequest, 'subject'> = { resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: { coding: [{ code }] } };
    const serviceRequest1 = await s.create({ ...base, subject: { reference: 'Patient/' + crypto.randomUUID() }, category: [{ coding: [{ code: category1 }] }] });
    const serviceRequest2 = await s.create({ ...base, subject: { reference: 'Patient/' + crypto.randomUUID() } });
    const bundle1 = await search(s, q('ServiceRequest', ['code', code], ['category:not', category1]));
    expect(names(bundle1, { serviceRequest1, serviceRequest2 })).toEqual(['serviceRequest2']);
  }));

  test('project-scoped Repository w/ %j › Missing [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const base: Omit<ServiceRequest, 'subject'> = { resourceType: 'ServiceRequest', status: 'active', intent: 'order', code: { coding: [{ code }] } };
    const serviceRequest1 = await s.create({ ...base, subject: { reference: 'Patient/' + crypto.randomUUID() }, specimen: [{ reference: 'Specimen/' + crypto.randomUUID() }], encounter: { reference: 'Encounter/' + crypto.randomUUID() } });
    const serviceRequest2 = await s.create({ ...base, subject: { reference: 'Patient/' + crypto.randomUUID() } });
    const out = [];
    for (const [param, value, want] of [['specimen', 'true', 'serviceRequest2'], ['specimen', 'false', 'serviceRequest1'], ['encounter', 'true', 'serviceRequest2'], ['encounter', 'false', 'serviceRequest1']]) {
      const bundle = await search(s, q('ServiceRequest', ['code', code], [`${param}:missing`, value]));
      expect(names(bundle, { serviceRequest1, serviceRequest2 }), `${param}:missing=${value}`).toEqual([want]);
      out.push(names(bundle, { serviceRequest1, serviceRequest2 }));
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Missing with logical (identifier) references [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patientIdentifier = crypto.randomUUID();
    const patient = await s.create({
      resourceType: 'Patient', identifier: [{ system: 'http://example.com/guid', value: patientIdentifier }],
      generalPractitioner: [{ identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '9876543210' } }],
      managingOrganization: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '0123456789' } },
    });
    for (const param of ['organization', 'general-practitioner']) {
      const results = await search(s, `Patient?identifier=${patientIdentifier}&${param}:missing=false`);
      expect(names(results, { patient }), param).toEqual(['patient']);
    }
  }));

  test('project-scoped Repository w/ %j › Starts after [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const code = crypto.randomUUID();
    const now = new Date();
    const [m1, m2, m3] = [1000, 2000, 3000].map((d) => new Date(now.getTime() - d).toISOString());
    const appt = (start: string) => s.create({ resourceType: 'Appointment', status: 'booked', serviceType: [{ coding: [{ code }] }],
      participant: [{ status: 'accepted', actor: { reference: 'Patient/' + crypto.randomUUID() } }], start, end: now.toISOString() });
    const appt1 = await appt(m1), appt2 = await appt(m2);
    const out = [];
    for (const [query, want] of [
      [[['date', `sa${m2}`]], ['appt1']], [[['date', `ge${m2}`]], ['appt1', 'appt2']],
      [[['date', `sa${m3}`], ['date', `eb${m1}`]], ['appt2']], [[['date', `sa${m3}`], ['date', `le${m1}`]], ['appt1', 'appt2']],
    ] as [[string, string][], string[]][]) {
      const bundle = await search(s, q('Appointment', ['service-type', code], ...query));
      expect(names(bundle, { appt1, appt2 }).sort(), JSON.stringify(query)).toEqual(want);
      out.push(names(bundle, { appt1, appt2 }).sort());
    }
    return out;
  }));

  test('project-scoped Repository w/ %j › Boolean search [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const patient = await s.create({ resourceType: 'Patient', name: [{ family }], active: true });
    const searchResult = await search(s, q('Patient', ['name', family], ['active', 'true']));
    expect(names(searchResult, { patient })).toEqual(['patient']);
  }));

  test('project-scoped Repository w/ %j › Boolean not equals matches missing value [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const family = marker();
    const activeTrue = await s.create({ resourceType: 'Patient', name: [{ family }], active: true });
    const activeFalse = await s.create({ resourceType: 'Patient', name: [{ family }], active: false });
    const activeUndefined = await s.create({ resourceType: 'Patient', name: [{ family }] });
    const searchResult = await search(s, q('Patient', ['name', family], ['active:not', 'false']));
    expect(names(searchResult, { activeTrue, activeFalse, activeUndefined }).sort()).toEqual(['activeTrue', 'activeUndefined']);
  }));

  test('project-scoped Repository w/ %j › Not equals with comma separated values [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const { category, codes, srs } = await threeCodes(s);
    const searchResult = await search(s, q('ServiceRequest', ['category', category], ['code:not', `${codes[0]},${codes[1]}`]));
    expect(names(searchResult, srs)).toEqual(['serviceRequest3']);
  }));

  test('project-scoped Repository w/ %j › _id equals with comma separated values [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const srs: Record<string, { id: string }> = {};
    for (let i = 1; i <= 3; i++) srs[`serviceRequest${i}`] = await s.create({ resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/' + crypto.randomUUID() }, code: { text: crypto.randomUUID() } });
    const searchResult = await search(s, q('ServiceRequest', ['_id', `${srs.serviceRequest1.id},${srs.serviceRequest2.id}`]));
    expect(names(searchResult, srs).sort()).toEqual(['serviceRequest1', 'serviceRequest2']);
  }));

  test('project-scoped Repository w/ %j › Error on invalid search parameter [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const e = await error(s, 'ServiceRequest?basedOn=ServiceRequest/123');
    expect(e).toEqual({ status: 400, text: 'Unknown search parameter: basedOn' });
    return e;
  }));

  test('project-scoped Repository w/ %j › Patient search without resource type [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const allergyIntolerance = await s.create({ resourceType: 'AllergyIntolerance', patient: ref(patient), clinicalStatus: { text: 'active' } });
    const searchResult = await search(s, `AllergyIntolerance?patient=${patient.id}`);
    expect(searchResult.entry?.[0]?.resource?.id).toBe(allergyIntolerance.id);
  }));

  test('project-scoped Repository w/ %j › Subject search without resource type [server/src/fhir/search.test.ts]', () => same(sides, async (s) => {
    const patient = await s.create({ resourceType: 'Patient' });
    const observation = await s.create({ resourceType: 'Observation', status: 'final', code: { text: 'test' }, subject: ref(patient) });
    const searchResult = await search(s, `Observation?subject=${patient.id}`);
    expect(searchResult.entry?.[0]?.resource?.id).toBe(observation.id);
  }));
});
