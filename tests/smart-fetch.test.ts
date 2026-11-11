import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagnosticReport, DocumentReference, Encounter, MedicationRequest, Observation, Patient, Resource } from '@medplum/fhirtypes';
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
        'DocumentReference/doc-ccd', 'DocumentReference/doc-html', 'DocumentReference/doc-pdf', 'DocumentReference/doc-rtf',
        'Encounter/enc1', 'Medication/med1', 'MedicationRequest/mr1',
        'Observation/both1', 'Observation/lab1', 'Observation/lab2', 'Observation/lab3', 'Observation/vs1',
        `Patient/${P}`,
      ].sort(),
    );
    expect(requests).toContain(`/fhir/Observation?patient=${P}&category=laboratory&_page=2`);
    expect(byType).toEqual({ Condition: 2, DocumentReference: 4, Encounter: 1, Medication: 1, MedicationRequest: 1, Observation: 5, Patient: 1 });
    expect(skipped).toEqual({ 'Observation:exam': 'HTTP 400', 'Condition:health-concern': 'HTTP 400' });
    expect(requests.some((r) => r.startsWith('/fhir/Practitioner') || r.startsWith('/fhir/Immunization') || r.startsWith('/fhir/Specimen'))).toBe(false);
    expect(requests).toContain(`/fhir/CarePlan?patient=${P}&category=38717003`); // Epic: CarePlan search needs a category
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

  it('downloads a DiagnosticReport presentedForm Binary like a note body', async () => {
    const m2 = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
    serveFixtures(m2);
    m2.route('/fhir/metadata', (_q, res) =>
      void res.end(JSON.stringify({ resourceType: 'CapabilityStatement', rest: [{ resource: [{ type: 'DiagnosticReport', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient' }] }] }] })),
    );
    const dr = { resourceType: 'DiagnosticReport', id: 'dr1', status: 'final', code: { text: 'X-ray' }, subject: { reference: `Patient/${P}` }, presentedForm: [{ contentType: 'text/html', url: `${m2.fhirBase}/Binary/n1` }] };
    m2.route('/fhir/DiagnosticReport', (_q, res) => void res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: dr }] })));
    const got = await fetchAll(m2.fhirBase, m2.grant(), P, ['DiagnosticReport']);
    await m2.close();
    const a = find<DiagnosticReport>(got.resources, 'DiagnosticReport/dr1').presentedForm?.[0];
    expect(Buffer.from(a?.data ?? '', 'base64').toString('utf8')).toContain('Synthetic follow-up note');
    const out = mapForGa(got.resources, { key: sourceKey(m2.fhirBase), name: 'x', fhirBase: m2.fhirBase }).resources;
    expect(find<DiagnosticReport>(out, 'DiagnosticReport/dr1').presentedForm?.[0].contentType).toBe('text/plain; charset=utf-8');
  });

  // A body that fails for now (5xx, bad JSON) defers its record: left out of this sync (the stored copy stays), retried next time.
  // A 404 is permanent: the record comes url-only, as before. The rest of the sync goes on either way.
  const reportsMock = async (ids: [string, string][], bad: (res: ServerResponse) => void) => {
    const m2 = await startMock({ clientId: 'synthetic-client', jwks: { keys: [] } });
    const { requests: reqs } = serveFixtures(m2);
    m2.route('/fhir/metadata', (_q, res) =>
      void res.end(JSON.stringify({ resourceType: 'CapabilityStatement', rest: [{ resource: [{ type: 'DiagnosticReport', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient' }] }] }] })),
    );
    const dr = (id: string, bin: string) => ({ resourceType: 'DiagnosticReport', id, status: 'final', code: { text: 'X-ray' }, subject: { reference: `Patient/${P}` }, presentedForm: [{ contentType: 'text/html', url: `Binary/${bin}` }] });
    m2.route('/fhir/DiagnosticReport', (_q, res) => void res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: ids.map(([id, bin]) => ({ resource: dr(id, bin) })) })));
    const broken: string[] = [];
    m2.route('/fhir/Binary/broken', (_q, res, url) => { broken.push(url.pathname); bad(res); });
    for (const i of [1, 2, 3, 4]) m2.route(`/fhir/Binary/broken${i}`, (_q, res, url) => { broken.push(url.pathname); bad(res); });
    try {
      return { got: await fetchAll(m2.fhirBase, m2.grant(), P, ['DiagnosticReport']), broken, reqs };
    } finally {
      await m2.close();
    }
  };
  it('a transient Binary failure defers its record; a 404 keeps it url-only', async () => {
    const e500 = (res: ServerResponse) => void res.writeHead(500).end();
    const badJson = (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/fhir+json' }); res.end('{not json'); };
    for (const bad of [e500, badJson]) {
      const { got } = await reportsMock([['dr1', 'broken'], ['dr2', 'n1']], bad);
      expect(got.skipped.Binary).toMatch(/^1 deferred/);
      expect(keys(got.resources)).not.toContain('DiagnosticReport/dr1');
      expect(find<DiagnosticReport>(got.resources, 'DiagnosticReport/dr2').presentedForm?.[0].data).toBeTruthy();
    }
    const { got } = await reportsMock([['dr1', 'broken'], ['dr2', 'n1']], (res) => void res.writeHead(404).end());
    expect(got.skipped.Binary).toBe('1 failed, last HTTP 404');
    expect(find<DiagnosticReport>(got.resources, 'DiagnosticReport/dr1').presentedForm?.[0].data).toBeUndefined();
  });

  it('after 3 transient failures in a row, the rest of the bodies wait for the next sync', async () => {
    const ids: [string, string][] = [['dr1', 'broken1'], ['dr2', 'broken2'], ['dr3', 'broken3'], ['dr4', 'broken4'], ['dr5', 'n1']];
    const { got, broken, reqs } = await reportsMock(ids, (res) => void res.writeHead(503).end());
    expect(broken).toHaveLength(3);
    expect(reqs.filter((r) => r.startsWith('/fhir/Binary/n1'))).toEqual([]);
    expect(keys(got.resources).filter((k) => k.startsWith('DiagnosticReport'))).toEqual([]);
    expect(got.skipped.Binary).toMatch(/^5 deferred/);
  });
});

describe('mapForGa report text', () => {
  it('makes a url-only report attachment absolute (a body that failed to download)', () => {
    const base = 'https://fhir.example.org/api/FHIR/R4/';
    const dr = { resourceType: 'DiagnosticReport', id: 'r0', status: 'final', code: { text: 'X-ray' }, presentedForm: [{ contentType: 'application/pdf', url: 'Binary/e1' }] } as DiagnosticReport;
    const out = mapForGa([dr], { key: sourceKey(base), name: 'x', fhirBase: base }).resources[0] as DiagnosticReport;
    expect(out.presentedForm?.[0].url).toBe('https://fhir.example.org/api/FHIR/R4/Binary/e1');
  });

  it('converts report html to text', () => {
    const base = 'https://fhir.example.org/api/FHIR/R4/';
    const dr = { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', code: { text: 'X-ray' }, presentedForm: [{ contentType: 'text/html', data: Buffer.from('<p>Impression: normal</p>').toString('base64') }] } as DiagnosticReport;
    const out = mapForGa([dr], { key: sourceKey(base), name: 'x', fhirBase: base }).resources[0] as DiagnosticReport;
    expect(out.presentedForm?.[0].contentType).toBe('text/plain; charset=utf-8');
    expect(Buffer.from(out.presentedForm?.[0].data ?? '', 'base64').toString('utf8')).toBe('Impression: normal');
  });

  it('moves an inline report PDF to a pending binary', () => {
    const base = 'https://fhir.example.org/api/FHIR/R4/';
    const pdf = Buffer.from('%PDF-1.4 synthetic report');
    const dr = { resourceType: 'DiagnosticReport', id: 'r2', status: 'final', code: { text: 'CT' }, presentedForm: [{ contentType: 'application/pdf', title: 'CT report', data: pdf.toString('base64') }] } as DiagnosticReport;
    const { resources, binaries } = mapForGa([dr], { key: sourceKey(base), name: 'x', fhirBase: base });
    const a = (resources[0] as DiagnosticReport).presentedForm?.[0];
    expect(a?.data).toBeUndefined();
    expect(a?.title).toBe('CT report');
    expect(binaries).toHaveLength(1);
    expect(binaries[0].ref).toBe(a?.url);
    expect(binaries[0].contentType).toBe('application/pdf');
    expect(binaries[0].data.equals(pdf)).toBe(true);
    expect(a?.hash).toBe(createHash('sha1').update(pdf).digest('base64'));
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
    expect(binaries.map((b) => b.contentType).sort()).toEqual(['application/pdf', 'application/xml']);
    const b = binaries.find((x) => x.ref === pdf.url)!;
    expect(b.contentType).toBe('application/pdf');
    expect(b.data.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.title).toBe('Scanned Letter');
    expect(pdf.hash).toBe(createHash('sha1').update(b.data).digest('base64'));
    expect(pdf.size).toBe(b.data.length);

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
