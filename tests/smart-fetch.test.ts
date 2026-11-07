import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentReference, Encounter, MedicationRequest, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { fetchAll, mapForGa } from '../src/smart/fetch.ts';
import { sourceKey } from '../src/smart/auth.ts';
import { walkReferences } from '../src/patient.ts';
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
    const { resources } = await fetchAll(m.fhirBase.replace('http://127.0.0.1', 'HTTP://127.0.0.1'), token, P, ['Condition']);
    expect(keys(resources)).toEqual(['Condition/cond-dx', 'Condition/cond-pl', `Patient/${P}`]);
  });

  it('fails on a bad token', async () => {
    await expect(fetchAll(m.fhirBase, 'at-bogus', P)).rejects.toThrow('HTTP 401');
  });

  it('reports a non-JSON body without echoing it', async () => {
    const m2 = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
    serveFixtures(m2);
    m2.route('/fhir/Encounter', (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/fhir+json' });
      res.end('<html>synthetic secret note text</html>');
    });
    const err = await fetchAll(m2.fhirBase, m2.grant(), P, ['Encounter']).catch((e: Error) => e);
    await m2.close();
    expect((err as Error).message).toBe('Encounter: invalid JSON');
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

  it('a failed later page or a 429 fails the fetch instead of dropping the type', async () => {
    for (const [status, page] of [[404, 2], [429, 2], [429, 1]] as const) {
      const m2 = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
      serveFixtures(m2);
      m2.route('/fhir/Encounter', (_q, res, url) => {
        if (page === 1 || url.searchParams.get('p') === '2') return void res.writeHead(status).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: `${m2.fhirBase}/Encounter?p=2` }], entry: [] }));
      });
      const err = await fetchAll(m2.fhirBase, m2.grant(), P, ['Encounter']).catch((e: Error) => e);
      await m2.close();
      expect((err as Error).message, `${status} on page ${page}`).toBe(`Encounter: HTTP ${status}`);
    }
  });

  it('follows a HAPI-style next link on the base itself (<base>?_getpages=...)', async () => {
    const m2 = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
    serveFixtures(m2);
    const bundle = (link: object[], id: string) =>
      JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link, entry: [{ resource: { resourceType: 'Encounter', id, status: 'finished' } }] });
    m2.route('/fhir/Encounter', (_q, res) => void res.end(bundle([{ relation: 'next', url: `${m2.fhirBase}?_getpages=p2&_getpagesoffset=1` }], 'enc-p1')));
    m2.route('/fhir', (q, res) => void (m2.authorized(q) ? res.end(bundle([], 'enc-p2')) : res.writeHead(401).end()));
    const got = await fetchAll(m2.fhirBase, m2.grant(), P, ['Encounter']);
    await m2.close();
    expect(got.byType.Encounter).toBe(2);
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

    // Cycles: Condition.encounter (child -> parent) stays; Encounter.diagnosis back to it becomes display-only.
    expect(find<Resource & { encounter: unknown }>(resources, 'Condition/cond-dx').encounter).toEqual({ reference: 'Encounter/enc1' });
    expect(enc.diagnosis).toEqual([{ condition: { display: 'Synthetic visit diagnosis' }, rank: 1 }]);
    expect(enc.reasonReference).toEqual([{ reference: 'Condition/cond-pl', display: 'Synthetic problem' }]); // no cycle: kept
    // No cycle left (the engine's topoSort walk).
    const byKey = new Map(resources.map((r) => [`${r.resourceType}/${r.id}`, r]));
    const state = new Map<Resource, string>();
    const visit = (r: Resource) => {
      if (state.get(r) === 'done') return;
      expect(state.get(r)).not.toBe('visiting');
      state.set(r, 'visiting');
      walkReferences(r, (ref) => {
        const dep = byKey.get(ref);
        if (dep && dep !== r) visit(dep);
        return undefined;
      });
      state.set(r, 'done');
    };
    resources.forEach(visit);

    // Notes: inline plain text, original type on the title.
    const html = find<DocumentReference>(resources, 'DocumentReference/doc-html').content[0].attachment;
    expect(html.contentType).toBe('text/plain; charset=utf-8');
    expect(html.title).toBe('Progress Note (original: text/html)');
    expect(html.url).toBeUndefined();
    expect(html.size).toBe(Buffer.from(html.data ?? '', 'base64').length);
    expect(html.hash).toBe(createHash('sha1').update(Buffer.from(html.data ?? '', 'base64')).digest('base64'));
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
    expect(pdf.hash).toBe(createHash('sha1').update(binaries[0].data).digest('base64'));
    expect(pdf.size).toBe(binaries[0].data.length);

    // Input untouched.
    expect(find<DocumentReference>(fetched, 'DocumentReference/doc-pdf').content[0].attachment.data).toBeDefined();
  });

  it('treats a malformed absolute reference as unresolvable instead of throwing', () => {
    const src = { key: 'k', name: 'Synthetic Hospital', fhirBase: m.fhirBase };
    const obs = {
      resourceType: 'Observation', id: 'bad1', status: 'final', code: { text: 'Synthetic' },
      performer: [{ reference: 'http://', display: 'Synthetic Lab' }, { reference: 'https://[bad/Practitioner/1' }],
    } as Observation;
    const { resources } = mapForGa([obs], src);
    expect((resources[0] as Observation).performer).toEqual([{ display: 'Synthetic Lab' }]);
  });
});
