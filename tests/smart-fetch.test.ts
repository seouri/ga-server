import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentReference, Encounter, MedicationRequest, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { fetchAll, mapForGa } from '../src/smart/fetch.ts';
import { sourceKey } from '../src/smart/auth.ts';
import { serveFixtures, startMock } from './smart/mock-server.ts';
import type { MockSmart } from './smart/mock-server.ts';

const P = 'synthetic-patient-1';
let m: MockSmart;
let requests: string[];
let token: string;

beforeAll(async () => {
  m = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
  ({ requests } = serveFixtures(m));
  token = m.grant();
});
afterAll(() => m.close());

const keys = (rs: Resource[]) => rs.map((r) => `${r.resourceType}/${r.id}`).sort();
const find = <T extends Resource>(rs: Resource[], key: string) => rs.find((r) => `${r.resourceType}/${r.id}` === key) as T;
const text = (d: DocumentReference) => Buffer.from(d.content[0].attachment.data ?? '', 'base64').toString('utf8');

describe('fetchAll', () => {
  it('fetches every patient-scoped type, all pages, de-duplicated, with referenced Medications and Binaries', async () => {
    const { resources, byType, skipped } = await fetchAll(m.fhirBase, token, P);
    expect(keys(resources)).toEqual(
      [
        'Condition/cond-dx', 'Condition/cond-pl',
        'DocumentReference/doc-html', 'DocumentReference/doc-pdf', 'DocumentReference/doc-rtf',
        'Encounter/enc1', 'Medication/med1', 'MedicationRequest/mr1',
        'Observation/both1', 'Observation/lab1', 'Observation/lab2', 'Observation/lab3', 'Observation/vs1',
        `Patient/${P}`,
      ].sort(),
    );
    expect(requests).toContain(`/fhir/Observation?patient=${P}&category=laboratory&_page=2`);
    expect(byType).toEqual({ Condition: 2, DocumentReference: 3, Encounter: 1, Medication: 1, MedicationRequest: 1, Observation: 5, Patient: 1 });
    expect(skipped).toEqual({ 'Observation:exam': 'HTTP 400', 'Condition:health-concern': 'HTTP 400' });
    expect(requests.some((r) => r.startsWith('/fhir/Practitioner') || r.startsWith('/fhir/Immunization'))).toBe(false);
    const html = find<DocumentReference>(resources, 'DocumentReference/doc-html');
    expect(text(html)).toContain('Synthetic follow-up note &amp; plan.');
  });

  it('intersects with the enabled types and always includes the Patient', async () => {
    const { resources } = await fetchAll(m.fhirBase, token, P, ['Condition']);
    expect(keys(resources)).toEqual(['Condition/cond-dx', 'Condition/cond-pl', `Patient/${P}`]);
  });

  it('fails on a bad token', async () => {
    await expect(fetchAll(m.fhirBase, 'at-bogus', P)).rejects.toThrow('HTTP 401');
  });

  it('never sends the token to a next link on another origin', async () => {
    const m2 = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
    serveFixtures(m2);
    m2.route('/fhir/Encounter', (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: 'https://elsewhere.example/fhir/Encounter?page=2' }], entry: [] }));
    });
    await expect(fetchAll(m2.fhirBase, m2.grant(), P, ['Encounter'])).rejects.toThrow('next link');
    await m2.close();
  });
});

describe('mapForGa', () => {
  it('maps for the engine', async () => {
    const { resources: fetched } = await fetchAll(m.fhirBase, token, P);
    const src = { key: sourceKey(m.fhirBase), name: 'Synthetic Hospital', fhirBase: m.fhirBase, patient: P };
    const { resources, binaries } = mapForGa(fetched, src);
    const sys = `urn:ga-server:id:smart:${src.key}`;

    // Identifiers: SMART first, Epic OID kept.
    const cond = find<Resource & { identifier: { system: string; value: string }[] }>(resources, 'Condition/cond-pl');
    expect(cond.identifier).toEqual([
      { system: sys, value: 'Condition/cond-pl' },
      { system: 'urn:oid:1.2.840.114350.1.13.0.1.7.2.768076', value: 'SYN-PL-1' },
    ]);
    for (const r of resources) expect((r as { identifier: { system: string }[] }).identifier[0].system).toBe(sys);

    // meta: only lastUpdated.
    expect(find<Patient>(resources, `Patient/${P}`).meta).toEqual({ lastUpdated: '2026-10-01T12:00:00Z' });
    expect(find(resources, 'Medication/med1').meta).toBeUndefined();

    // References outside the batch: display-only, or dropped without a display; in-batch ones unchanged.
    const mr = find<MedicationRequest>(resources, 'MedicationRequest/mr1');
    expect(mr.requester).toEqual({ display: 'Synthetic Clinician, MD' });
    expect(mr.medicationReference).toEqual({ reference: 'Medication/med1', display: 'amlodipine 5 mg tablet' });
    const enc = find<Encounter>(resources, 'Encounter/enc1');
    expect(enc.serviceProvider).toBeUndefined();
    expect(enc.participant?.[0].individual).toEqual({ display: 'Synthetic Clinician, MD' });
    expect(find<Patient>(resources, `Patient/${P}`).managingOrganization).toBeUndefined();
    expect(find<Observation>(resources, 'Observation/lab1').encounter).toEqual({ reference: 'Encounter/enc1' });
    expect(find<Observation>(resources, 'Observation/lab1').performer).toEqual([{ display: 'Synthetic Lab' }]);
    expect(JSON.stringify(resources)).not.toMatch(/"reference":"(Practitioner|Organization)\//);

    // Notes: inline plain text, original type on the title.
    const html = find<DocumentReference>(resources, 'DocumentReference/doc-html').content[0].attachment;
    expect(html.contentType).toBe('text/plain; charset=utf-8');
    expect(html.title).toBe('Progress Note (original: text/html)');
    expect(html.url).toBeUndefined();
    const htmlText = Buffer.from(html.data ?? '', 'base64').toString('utf8');
    expect(htmlText).toContain('Synthetic follow-up note & plan.');
    expect(htmlText).toContain('Patient tolerates the synthetic regimen <well>.');
    expect(htmlText).not.toMatch(/not text|color:red|<p>/);
    const rtf = find<DocumentReference>(resources, 'DocumentReference/doc-rtf').content[0].attachment;
    expect(rtf.title).toBe('RTF Note (original: text/rtf)');
    expect(Buffer.from(rtf.data ?? '', 'base64').toString('utf8')).toContain('Synthetic RTF progress note.');

    // PDF: never inline; a pending Binary upload whose ref is the attachment url.
    const pdf = find<DocumentReference>(resources, 'DocumentReference/doc-pdf').content[0].attachment;
    expect(pdf.data).toBeUndefined();
    expect(binaries).toHaveLength(1);
    expect(binaries[0].ref).toBe(pdf.url);
    expect(binaries[0].contentType).toBe('application/pdf');
    expect(binaries[0].data.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.title).toBe('Scanned Letter');

    // Input untouched.
    expect(find<DocumentReference>(fetched, 'DocumentReference/doc-pdf').content[0].attachment.data).toBeDefined();
  });
});
