import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MedplumClient } from '@medplum/core';
import type { Bundle, BundleEntry, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { serveStore, storeToken } from '../server.ts';
import { parseServeArgs } from '../serve.ts';
import { request as httpRequest } from 'node:http';
import { Store } from '../store.ts';

const obs = (code: string, value: number, date: string): Observation => ({
  resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code }] },
  subject: { reference: 'Patient/p1' }, effectiveDateTime: date, valueQuantity: { value, unit: 'mg/dL' },
});

describe('store server', () => {
  let dir: string, server: Server, base: string, token: string;
  const client = (t = token, opts: Partial<ConstructorParameters<typeof MedplumClient>[0]> = {}) => new MedplumClient({
    baseUrl: base, maxRetries: 0,
    fetch: (input, init) => { const headers = new Headers(init?.headers); headers.set('authorization', `Bearer ${t}`); return fetch(input, { ...init, headers }); },
    ...opts,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'store-srv-'));
    const tokenFile = join(dir, 'store', 'token');
    server = await serveStore({ file: join(dir, 'store.db'), host: '127.0.0.1', port: 0, tokenFile });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    token = readFileSync(tokenFile, 'utf8').trim();
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /healthz answers 200 without a token and nothing else is open without one', async () => {
    const r = await fetch(`${base}healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
    expect((await fetch(`${base}healthz`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}healthz/x`)).status).toBe(401);
    expect((await fetch(`${base}fhir/R4/Patient`)).status).toBe(401);
  });

  it('creates the token on first serve: 32 random bytes base64url, 0600 in a 0700 dir, kept on restart', async () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(dir, 'store', 'token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'store')).mode & 0o777).toBe(0o700);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = await serveStore({ file: join(dir, 'store.db'), host: '127.0.0.1', port: 0, tokenFile: join(dir, 'store', 'token') });
    expect(readFileSync(join(dir, 'store', 'token'), 'utf8').trim()).toBe(token);
  });

  it('a MedplumClient creates, reads, searches (all pages), updates with If-Match, reads history and deletes', async () => {
    const c = client();
    const p = await c.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'Lee' }] });
    expect(p.id).toBeTruthy();
    expect((await c.readResource('Patient', p.id)).name?.[0].family).toBe('Lee');
    for (let i = 0; i < 25; i++) await c.createResource(obs('2093-3', 150 + i, `2024-01-${String(i + 1).padStart(2, '0')}`));
    const found = await c.searchResources('Observation', { code: 'http://loinc.org|2093-3', _sort: '-date', _count: '10' });
    expect(found).toHaveLength(10);
    expect(found[0].effectiveDateTime).toBe('2024-01-25');
    let pages = 0, all = 0;
    for await (const page of c.searchResourcePages('Observation', { _count: '10', _sort: 'date' })) { pages++; all += page.length; }
    expect([pages, all]).toEqual([3, 25]);
    // Same id read twice through the If-None-Exist path: one record.
    const a = await c.createResourceIfNoneExist<Patient>({ resourceType: 'Patient', identifier: [{ system: 's', value: 'self' }] }, 'identifier=s|self');
    const b = await c.createResourceIfNoneExist<Patient>({ resourceType: 'Patient', identifier: [{ system: 's', value: 'self' }] }, 'identifier=s|self');
    expect(b.id).toBe(a.id);

    const v1 = p.meta!.versionId!;
    const p2 = await c.updateResource<Patient>({ ...p, gender: 'male' }, { headers: { 'If-Match': `W/"${v1}"` } });
    expect(p2.meta?.versionId).not.toBe(v1);
    await expect(c.updateResource<Patient>({ ...p, gender: 'female' }, { headers: { 'If-Match': `W/"${v1}"` } })).rejects.toMatchObject({ outcome: { id: 'precondition-failed' } });
    const hist = await c.readHistory('Patient', p.id);
    expect(hist.entry?.map((e) => e.resource?.meta?.versionId)).toEqual([p2.meta?.versionId, v1]);
    expect((await c.readVersion('Patient', p.id, v1)).gender).toBeUndefined();

    await c.deleteResource('Patient', p.id);
    await expect(c.readResource('Patient', p.id)).rejects.toMatchObject({ outcome: { id: 'gone' }, message: 'Gone' }); // as Medplum: 410 after a delete
    await expect(c.readResource('Patient', 'never')).rejects.toMatchObject({ outcome: { id: 'not-found' }, message: 'Not found' }); // Medplum's text
  });

  it('validateResource ($validate): OK for a valid resource, 400 with element paths for an invalid one, nothing stored', async () => {
    const c = client();
    await expect(c.validateResource(obs('4548-4', 5.6, '2024-02-01'))).resolves.toMatchObject({ resourceType: 'OperationOutcome' });
    await expect(c.validateResource({ ...obs('4548-4', 5.6, '2024-02-01'), status: undefined } as never)).rejects.toMatchObject({ outcome: { issue: [{ expression: ['Observation.status'] }] } });
    expect(await c.searchResources('Observation', {})).toHaveLength(0);
  });

  it('POST _search and a 400 for an unknown search parameter', async () => {
    const c = client();
    await c.createResource(obs('4548-4', 5.6, '2024-02-01'));
    const res = await fetch(`${base}fhir/R4/Observation/_search`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=4548-4' });
    expect(((await res.json()) as Bundle).entry).toHaveLength(1);
    await expect(c.searchResources('Observation', { nope: 'x' })).rejects.toMatchObject({ outcome: { issue: [{ code: 'invalid' }] } });
  });

  it('GET Binary (a search) is 400, as Medplum', async () => {
    const res = await fetch(`${base}fhir/R4/Binary`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issue: { details: { text: string } }[] }).issue[0].details.text).toBe('Cannot search on Binary resource type');
  });

  it('deleteResource(Binary) removes the row and the file; a second delete is 404', async () => {
    const c = client();
    const bin = await c.createBinary({ data: 'x', contentType: 'text/plain' });
    await c.deleteResource('Binary', bin.id as string);
    expect(existsSync(join(dir, 'binary', bin.id as string))).toBe(false);
    await expect(c.readResource('Binary', bin.id as string)).rejects.toThrow(/Not found/);
    await expect(c.deleteResource('Binary', bin.id as string)).rejects.toThrow(/Not found/);
  });

  it('createBinary then download returns the same bytes; readResource(Binary) is its JSON', async () => {
    const c = client();
    const data = randomBytes(300_000);
    const bin = await c.createBinary({ data, contentType: 'application/pdf', filename: 'x.pdf' });
    expect(bin).toMatchObject({ resourceType: 'Binary', contentType: 'application/pdf' });
    const blob = await c.download(`Binary/${bin.id}`);
    expect(Buffer.from(await blob.arrayBuffer()).equals(data)).toBe(true);
    expect(blob.type).toBe('application/pdf');
    expect(await c.readResource('Binary', bin.id)).toMatchObject({ resourceType: 'Binary', id: bin.id, contentType: 'application/pdf' });
    await expect(c.download('Binary/nope')).resolves.toBeDefined(); // a 404 Response body, as Medplum's client gives it
    // A row whose file is gone: that request fails, the server keeps serving.
    rmSync(join(dir, 'binary', bin.id));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fetch(`${base}fhir/R4/Binary/${bin.id}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.arrayBuffer()).catch(() => undefined);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect((await c.readResource('Binary', bin.id)).id).toBe(bin.id);
    expect((await fetch(`${base}fhir/R4/Binary/nope`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  it('executeBatch: a transaction of DELETEs, a batch of POSTs; a failing transaction changes nothing', async () => {
    const c = client();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await c.createResource(obs('2093-3', i, '2024-01-01'))).id);
    const del = await c.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: ids.map((id) => ({ request: { method: 'DELETE', url: `Observation/${id}` } })) });
    expect(del.type).toBe('transaction-response');
    expect(del.entry?.map((e) => e.response?.status)).toEqual(['200', '200', '200']); // Medplum's form
    expect(await c.searchResources('Observation', {})).toHaveLength(0);

    const posted = await c.executeBatch({ resourceType: 'Bundle', type: 'batch', entry: [obs('1', 1, '2024-01-01'), obs('2', 2, '2024-01-01')].map((resource) => ({ resource, request: { method: 'POST', url: 'Observation' } })) });
    expect(posted.type).toBe('batch-response');
    expect(posted.entry?.map((e) => e.response?.status)).toEqual(['201', '201']);
    const kept = posted.entry![0].resource!.id!;

    // One bad entry (missing status) rolls back the whole transaction, including the delete before it.
    const bad = { ...obs('3', 3, '2024-01-01'), status: undefined } as unknown as Observation;
    await expect(c.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: [
      { request: { method: 'DELETE', url: `Observation/${kept}` } },
      { resource: bad, request: { method: 'POST', url: 'Observation' } },
    ] })).rejects.toThrow(/Missing required property/);
    expect((await c.readResource('Observation', kept)).id).toBe(kept);
    // In a batch the bad entry fails alone.
    const mixed = await c.executeBatch({ resourceType: 'Bundle', type: 'batch', entry: [
      { resource: bad, request: { method: 'POST', url: 'Observation' } },
      { request: { method: 'DELETE', url: `Observation/${kept}` } },
    ] });
    expect(mixed.entry?.map((e) => e.response?.status)).toEqual(['400', '200']);
  });

  it('no token or a wrong token: 401 with no body detail; a client with a wrong token fails', async () => {
    for (const headers of [{} as Record<string, string>, { authorization: 'Bearer wrong' }, { authorization: 'Bearer ' }, { authorization: 'Bearer' }, { authorization: `Basic ${token}` }, { authorization: `Bearer ${token}x` }]) {
      const res = await fetch(`${base}fhir/R4/Patient`, { headers });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
    }
    await expect(client('wrong').searchResources('Patient', {})).rejects.toThrow();
  });

  it('no-auth and an empty bearer are 401; an empty or short token file refuses to start', async () => {
    for (const headers of [{}, { authorization: 'Bearer ' }] as Record<string, string>[]) {
      expect((await fetch(`${base}fhir/R4/Patient`, { headers })).status).toBe(401);
      expect((await fetch(`${base}fhir/R4/Patient`, { method: 'POST', headers, body: '{"resourceType":"Patient"}' })).status).toBe(401);
    }
    const d2 = join(dir, 't2'), tf = join(d2, 'token');
    mkdirSync(d2, { mode: 0o700 });
    for (const text of ['\n', 'short']) {
      writeFileSync(tf, text, { mode: 0o644 });
      await expect(serveStore({ file: join(d2, 'store.db'), port: 0, tokenFile: tf })).rejects.toThrow(/delete the file and restart/);
    }
  });

  it('a second serve on a used port fails before touching its token file or database', async () => {
    const d2 = join(dir, 't3'), tf = join(d2, 'token');
    mkdirSync(d2, { mode: 0o700 });
    writeFileSync(tf, '', { mode: 0o600 });
    await expect(serveStore({ file: join(d2, 'store.db'), port: (server.address() as AddressInfo).port, tokenFile: tf })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(readFileSync(tf, 'utf8')).toBe('');
    expect(existsSync(join(d2, 'store.db'))).toBe(false);
    expect(await client().searchResources('Patient', {})).toHaveLength(0); // the first server still serves with its token
  });

  it('bad paths: a malformed escape is 400, a look-alike prefix is 404', async () => {
    const h = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}fhir/R4/Patient/%E0%A4%A`, { headers: h })).status).toBe(400);
    expect((await fetch(`${base}fhir/R4x/Patient`, { headers: h })).status).toBe(404);
  });

  it('a request without Host gets links to 127.0.0.1:<port>', async () => {
    const port = (server.address() as AddressInfo).port;
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET /fhir/R4/Patient HTTP/1.0\r\nAuthorization: Bearer ${token}\r\n\r\n`));
      let out = '';
      sock.on('data', (d) => { out += d; }).on('end', () => resolve(out)).on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 200/);
    expect(raw).toContain(`"url":"http://127.0.0.1:${port}/fhir/R4/Patient?"`);
  });

  it('a streamed (chunked) body over the limit is cut off with 413 and stores nothing', async () => {
    const chunk = new Uint8Array(1 << 20).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(ctl) { ctl.enqueue(new TextEncoder().encode('{"resourceType":"Patient","x":"')); },
      pull(ctl) { if (sent++ < 40) ctl.enqueue(chunk); else { ctl.enqueue(new TextEncoder().encode('"}')); ctl.close(); } },
    });
    const status = await fetch(`${base}fhir/R4/Patient`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/fhir+json' }, body, duplex: 'half' } as RequestInit)
      .then((r) => r.status, () => 'dropped');
    expect([413, 'dropped']).toContain(status);
    expect(sent).toBeLessThan(40); // the server stopped reading; the client never sent the whole body
    expect(await client().searchResources('Patient', {})).toHaveLength(0);
  });

  it('a streamed Binary over 64 MB is stored (archived exports); one declared over the default 2 GiB limit is refused with 413', async () => {
    const chunk = new Uint8Array(1 << 20).fill(98);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(ctl) { if (sent++ < 80) ctl.enqueue(chunk); else ctl.close(); } });
    const res = await fetch(`${base}fhir/R4/Binary`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, body, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(statSync(join(dir, 'binary', id)).size).toBe(80 << 20);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}fhir/R4/Binary`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip', 'content-length': String(2 * 1024 ** 3 + 1) } },
        (r) => { resolve(r.statusCode ?? 0); r.resume(); req.destroy(); });
      req.on('error', reject);
      req.write('x');
    });
    expect(status).toBe(413);
  });

  it('rejects bodies over the limit with 413', async () => {
    const res = await fetch(`${base}fhir/R4/Patient`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/fhir+json' }, body: `{"resourceType":"Patient","x":"${'a'.repeat(17 << 20)}"}` });
    expect(res.status).toBe(413);
  });

  it('Review Focus 1: 3 clients x 200 create/update cycles on overlapping resources: each update succeeds or gets 412, never 500', async () => {
    const shared: string[] = [];
    for (let i = 0; i < 5; i++) shared.push((await client().createResource(obs('2093-3', 0, '2024-01-01'))).id!);
    const ok = new Map<string, string[]>(shared.map((id) => [id, []]));
    let n412 = 0, nOk = 0;
    const other: unknown[] = [];
    await Promise.all([0, 1, 2].map(async (w) => {
      const c = client();
      for (let i = 0; i < 200; i++) {
        await c.createResource(obs('x', i, '2024-01-01'));
        const id = shared[i % 2]; // all three writers on the same two resources: reads and If-Match updates interleave
        const cur = await c.readResource('Observation', id);
        try {
          const up = await c.updateResource({ ...cur, valueQuantity: { value: w * 1000 + i + 1, unit: 'mg/dL' } }, { headers: { 'If-Match': `W/"${cur.meta!.versionId}"` } });
          ok.get(id)!.push(up.meta!.versionId!);
          nOk++;
        } catch (e) {
          if ((e as { outcome?: { id?: string } }).outcome?.id === 'precondition-failed') n412++;
          else other.push(e);
        }
      }
    }));
    expect(other).toEqual([]);
    expect(nOk + n412).toBe(600);
    expect(nOk).toBeGreaterThan(0);
    expect(n412).toBeGreaterThan(0);
    const c = client();
    for (const id of shared) {
      const versions = (await c.get(`${base}fhir/R4/Observation/${id}/_history?_count=1000`, { cache: 'no-cache' }) as Bundle).entry!.map((e) => e.resource!.meta!.versionId!);
      expect(versions).toHaveLength(1 + ok.get(id)!.length);
      expect(new Set(versions).size).toBe(versions.length);
      for (const v of ok.get(id)!) expect(versions).toContain(v);
      expect((await c.readResource('Observation', id)).meta?.versionId).toBe(versions[0]);
    }
    expect(await c.searchResources('Observation', { code: 'x', _count: '1000' })).toHaveLength(600);
  });
});

describe('store server: Medplum-compatible routes', () => {
  let dir: string, server: Server, base: string, token: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'store-compat-'));
    server = await serveStore({ file: join(dir, 'store.db'), host: '127.0.0.1', port: 0, tokenFile: join(dir, 'token') });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    token = readFileSync(join(dir, 'token'), 'utf8').trim();
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}fhir/R4/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/fhir+json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : undefined } as { status: number; headers: Headers; json: any };
  };
  const tx = (type: 'batch' | 'transaction', entry: BundleEntry[]) => call('POST', '', { resourceType: 'Bundle', type, entry });
  const P = (id: string) => ({ reference: `Patient/${id}` });
  const ob = (extra: Partial<Observation> = {}): Observation => ({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, ...extra });
  const count = async (q = '') => (await call('GET', `Observation?_summary=count${q}`)).json.total;

  it('a transaction rewrites urn:uuid and urn:oid fullUrls everywhere (whole urns only); compartments follow the new Patient', async () => {
    const A = 'urn:uuid:11111111-1111-4111-8111-111111111111', B = 'urn:uuid:22222222-2222-4222-8222-222222222222', O = 'urn:oid:1.2.3';
    const r = await tx('transaction', [
      { fullUrl: B, resource: { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: A } } as Resource, request: { method: 'POST', url: 'Encounter' } },
      { resource: ob({ subject: { reference: A }, encounter: { reference: B }, code: { coding: [{ system: 'urn:oid:1.2.3.4', code: 'c' }], text: `see ${B}` }, performer: [{ reference: O }] }), request: { method: 'POST', url: 'Observation' } },
      { fullUrl: A, resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
      { fullUrl: O, resource: { resourceType: 'Practitioner' }, request: { method: 'POST', url: 'Practitioner' } },
    ]);
    expect(r.status).toBe(200);
    expect(r.json.type).toBe('transaction-response');
    const [enc, o, pat, pr] = r.json.entry.map((e: BundleEntry) => e.resource);
    expect(r.json.entry.map((e: BundleEntry) => e.response)).toEqual([enc, o, pat, pr].map((x) => ({ status: '201', location: `${x.resourceType}/${x.id}`, outcome: expect.objectContaining({ id: 'created' }) })));
    expect(o.subject.reference).toBe(`Patient/${pat.id}`);
    expect(o.encounter.reference).toBe(`Encounter/${enc.id}`);
    expect(o.code).toEqual({ coding: [{ system: 'urn:oid:1.2.3.4', code: 'c' }], text: `see Encounter/${enc.id}` });
    expect(o.performer[0].reference).toBe(`Practitioner/${pr.id}`);
    expect(o.meta.compartment).toEqual([{ reference: `Patient/${pat.id}` }]);
    expect((await call('GET', `Observation?_compartment=Patient/${pat.id}`)).json.entry).toHaveLength(1);
  });

  it('a transaction\'s conditional PUT with a urn fullUrl: later references get the created, then the updated, Patient', async () => {
    const X = 'urn:uuid:66666666-6666-4666-8666-666666666666';
    const send = () => tx('transaction', [
      { request: { method: 'POST', url: 'Observation' }, resource: ob({ subject: { reference: X } }) },
      { fullUrl: X, request: { method: 'PUT', url: 'Patient?identifier=s|v' }, resource: { resourceType: 'Patient', identifier: [{ system: 's', value: 'v' }] } },
    ]);
    for (const status of ['201', '200']) {
      const r = await send();
      expect(r.json.entry.map((e: BundleEntry) => e.response!.status)).toEqual(['201', status]);
      const [o, pat] = r.json.entry.map((e: BundleEntry) => e.resource);
      expect(o.subject).toEqual(P(pat.id));
      expect(o.meta.compartment).toEqual([P(pat.id)]);
    }
    expect((await call('GET', 'Patient?identifier=s|v')).json.entry).toHaveLength(1);
    expect(await count(`&subject=Patient/${(await call('GET', 'Patient?identifier=s|v')).json.entry[0].resource.id}`)).toBe(2);
    // Each conditional entry resolves on its own: two If-None-Exist POSTs whose resources do not match their search (spelled
    // two ways) both create; an unreferenced urn whose match an earlier entry changed is fine; a referenced one is 400.
    const prac = (fullUrl: string, ifNoneExist: string, value: string): BundleEntry => ({ fullUrl, request: { method: 'POST', url: 'Practitioner', ifNoneExist }, resource: { resourceType: 'Practitioner', identifier: [{ system: 's', value }] } });
    const d = await tx('transaction', [prac('urn:uuid:a1', 'identifier=s|d', 'd1'), prac('urn:uuid:a2', 'identifier=s%7Cd', 'd2'),
      { request: { method: 'POST', url: 'Observation' }, resource: ob({ performer: [{ reference: 'urn:uuid:a1' }, { reference: 'urn:uuid:a2' }] }) }]);
    expect(d.json.entry.map((e: BundleEntry) => e.response!.status)).toEqual(['201', '201', '201']);
    expect(d.json.entry[2].resource.performer).toEqual([0, 1].map((n) => ({ reference: `Practitioner/${d.json.entry[n].resource.id}` })));
    const u = await tx('transaction', [
      { request: { method: 'POST', url: 'Patient' }, resource: { resourceType: 'Patient', identifier: [{ system: 's', value: 'u' }] } },
      { fullUrl: 'urn:uuid:c1', request: { method: 'PUT', url: 'Patient?identifier=s|u' }, resource: { resourceType: 'Patient', active: true, identifier: [{ system: 's', value: 'u' }] } },
    ]);
    expect(u.json.entry.map((e: BundleEntry) => e.response!.status)).toEqual(['201', '200']);
    expect(u.json.entry[1].resource.id).toBe(u.json.entry[0].resource.id);
    const same = await tx('transaction', [prac('urn:uuid:e1', 'identifier=s|e', 'e'), prac('urn:uuid:e2', 'identifier=s|e', 'e'),
      { request: { method: 'POST', url: 'Observation' }, resource: ob({ performer: [{ reference: 'urn:uuid:e2' }] }) }]);
    expect([same.status, same.json.issue[0].details.text]).toEqual([400, expect.stringMatching(/^urn:uuid:e2 resolved to Practitioner\/.* an earlier entry changed its match$/)]);
    const before = await count();
    const moved = await tx('transaction', [
      { fullUrl: 'urn:uuid:b1', request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=s|w' }, resource: { resourceType: 'Patient', active: true, identifier: [{ system: 's', value: 'w' }] } },
      { fullUrl: 'urn:uuid:b2', request: { method: 'PUT', url: 'Patient?identifier=s|w&active=true' }, resource: { resourceType: 'Patient', identifier: [{ system: 's', value: 'w' }] } },
      { request: { method: 'POST', url: 'Observation' }, resource: ob({ subject: { reference: 'urn:uuid:b2' } }) },
    ]);
    expect([moved.status, moved.json.issue[0].details.text]).toEqual([400, expect.stringMatching(/^urn:uuid:b2 resolved to Patient\/.* an earlier entry changed its match$/)]);
    expect(await count()).toBe(before);
    expect((await call('GET', 'Patient?identifier=s|w')).json.entry).toHaveLength(0);
  });

  it('a batch or transaction whose entry is not a list of objects is 400', async () => {
    for (const entry of [[null], {}, [1], 'x', [[]]]) {
      for (const type of ['batch', 'transaction']) expect((await call('POST', '', { resourceType: 'Bundle', type, entry })).status, `${type} ${JSON.stringify(entry)}`).toBe(400);
    }
  });

  it('a reference to a urn no entry defines is 400 (transaction: nothing stored; batch: that entry)', async () => {
    const dangling = ob({ subject: { reference: 'urn:uuid:44444444-4444-4444-8444-444444444444' } });
    const r = await tx('transaction', [{ resource: ob(), request: { method: 'POST', url: 'Observation' } }, { resource: dangling, request: { method: 'POST', url: 'Observation' } }]);
    expect(r.status).toBe(400);
    expect(r.json.issue[0].details.text).toMatch(/matches no entry/);
    expect(await count()).toBe(0);
    const b = await tx('batch', [{ resource: dangling, request: { method: 'POST', url: 'Observation' } }, { resource: ob(), request: { method: 'POST', url: 'Observation' } }]);
    expect(b.json.entry.map((e: BundleEntry) => e.response!.status)).toEqual(['400', '201']);
    // A batch rewrites a urn defined by an earlier entry, as Medplum does.
    const c = await tx('batch', [{ fullUrl: 'urn:uuid:55555555-5555-4555-8555-555555555555', resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
      { resource: ob({ subject: { reference: 'urn:uuid:55555555-5555-4555-8555-555555555555' } }), request: { method: 'POST', url: 'Observation' } }]);
    expect(c.json.entry[1].resource.subject.reference).toBe(`Patient/${c.json.entry[0].resource.id}`);
  });

  it('conditional references resolve to the one match (POST, PUT, batch); none or several is 400', async () => {
    const p = (await call('POST', 'Patient', { resourceType: 'Patient', identifier: [{ system: 's', value: 'one' }] })).json;
    for (let i = 0; i < 2; i++) await call('POST', 'Practitioner', { resourceType: 'Practitioner', identifier: [{ system: 's', value: 'dup' }] });
    const o = await call('POST', 'Observation', ob({ subject: { reference: 'Patient?identifier=s|one' } }));
    expect(o.json.subject).toEqual(P(p.id));
    expect(o.json.meta.compartment).toEqual([P(p.id)]);
    const t = await tx('transaction', [{ resource: ob({ subject: { reference: `Patient?_id=${p.id}` } }), request: { method: 'POST', url: 'Observation' } }]);
    expect(t.json.entry[0].resource.subject).toEqual(P(p.id));
    const none = await call('POST', 'Observation', ob({ subject: { reference: 'Patient?identifier=s|none' } }));
    expect([none.status, none.json.issue[0].details.text]).toEqual([400, "Conditional reference 'Patient?identifier=s|none' did not match any resources"]);
    const many = await call('POST', 'Observation', ob({ performer: [{ reference: 'Practitioner?identifier=s|dup' }] }));
    expect([many.status, many.json.issue[0].details.text]).toEqual([400, "Conditional reference 'Practitioner?identifier=s|dup' matched multiple resources"]);
    expect(await count()).toBe(2);
  });

  it('batch entries: GET read, vread, search and history, PATCH (a Binary), conditional PUT and DELETE, ifNoneExist, ifMatch', async () => {
    const o = (await call('POST', 'Observation', ob({ status: 'preliminary', identifier: [{ system: 's', value: 'a' }] }))).json;
    const v0 = o.meta.versionId;
    const patchBin = { resourceType: 'Binary', contentType: 'application/json-patch+json', data: Buffer.from(JSON.stringify([{ op: 'replace', path: '/status', value: 'final' }])).toString('base64') };
    const r = await tx('batch', [
      { request: { method: 'GET', url: `Observation/${o.id}` } },
      { request: { method: 'GET', url: `Observation/${o.id}/_history/${v0}` } },
      { request: { method: 'GET', url: 'Observation?identifier=s|a' } },
      { request: { method: 'GET', url: 'Observation/nope' } },
      { request: { method: 'PATCH', url: `Observation/${o.id}` }, resource: patchBin as Resource },
      { request: { method: 'PUT', url: 'Observation?identifier=s|a' }, resource: ob({ status: 'amended', identifier: [{ system: 's', value: 'a' }] }) },
      { request: { method: 'PUT', url: 'Observation?identifier=s|b' }, resource: ob({ identifier: [{ system: 's', value: 'b' }] }) },
      { request: { method: 'POST', url: 'Observation', ifNoneExist: 'identifier=s|a' }, resource: ob() },
      { request: { method: 'PUT', url: `Observation/${o.id}`, ifMatch: 'W/"wrong"' }, resource: { ...o, status: 'cancelled' } },
      { request: { method: 'DELETE', url: 'Observation?identifier=s|b' } },
      { request: { method: 'DELETE', url: 'Observation?identifier=s|zz' } },
      { request: { method: 'GET', url: `Observation/${o.id}/_history` } },
    ]);
    const e = r.json.entry as BundleEntry[];
    expect(e.map((x) => x.response!.status)).toEqual(['200', '200', '200', '404', '200', '200', '201', '200', '412', '200', '200', '200']);
    expect(e[0].response!.location).toBe(`Observation/${o.id}`);
    expect((e[1].resource as Observation).status).toBe('preliminary');
    expect((e[2].resource as Bundle).type).toBe('searchset');
    expect(e[3].response!.outcome).toMatchObject({ id: 'not-found' });
    expect((e[4].resource as Observation).status).toBe('final');
    expect([(e[5].resource as Observation).id, (e[5].resource as Observation).status]).toEqual([o.id, 'amended']);
    expect(e[7].resource!.id).toBe(o.id);
    expect(e[8].response!.outcome).toMatchObject({ id: 'precondition-failed' });
    expect((e[11].resource as Bundle).total).toBe(3);
    expect(await count('&identifier=s|b')).toBe(0);
  });

  it('a transaction runs DELETE, POST, PUT/PATCH, then GET (answers in request order) and fails as a whole', async () => {
    const o = (await call('POST', 'Observation', ob())).json;
    const gone = (await call('POST', 'Observation', ob())).json;
    const r = await tx('transaction', [
      { request: { method: 'GET', url: `Observation/${o.id}` } },
      { request: { method: 'PUT', url: `Observation/${o.id}` }, resource: { ...o, status: 'amended' } },
      { request: { method: 'POST', url: 'Observation' }, resource: ob() },
      { request: { method: 'DELETE', url: `Observation/${gone.id}` } },
    ]);
    expect(r.json.entry.map((x: BundleEntry) => x.response!.status)).toEqual(['200', '200', '201', '200']);
    expect(r.json.entry[0].resource.status).toBe('amended');
    const before = await count();
    const bad = await tx('transaction', [{ request: { method: 'POST', url: 'Observation' }, resource: ob() }, { request: { method: 'GET', url: 'Observation/nope' } }]);
    expect(bad.status).toBe(404);
    expect(await count()).toBe(before);
    const many = await tx('transaction', [{ request: { method: 'DELETE', url: 'Observation?code:text=x' } }]);
    expect([many.status, many.json.id]).toEqual([412, 'multiple-matches']);
  });

  it('PATCH with JSON Patch: versioned and validated like an update; If-Match, test failures, id changes, missing and deleted', async () => {
    const o = (await call('POST', 'Observation', ob({ status: 'preliminary' }))).json;
    const jp = { 'content-type': 'application/json-patch+json' };
    const ok = await call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/status', value: 'final' }], jp);
    expect([ok.status, ok.json.status]).toEqual([200, 'final']);
    expect(ok.json.meta.versionId).not.toBe(o.meta.versionId);
    expect(ok.headers.get('etag')).toBe(`W/"${ok.json.meta.versionId}"`);
    expect((await call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/status', value: 'amended' }], { ...jp, 'if-match': `W/"${o.meta.versionId}"` })).status).toBe(412);
    expect((await call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/status', value: 'amended' }], { ...jp, 'if-match': `W/"${ok.json.meta.versionId}"` })).status).toBe(200);
    const invalid = await call('PATCH', `Observation/${o.id}`, [{ op: 'remove', path: '/status' }], jp);
    expect([invalid.status, invalid.json.issue[0].expression]).toEqual([400, ['Observation.status']]);
    expect((await call('PATCH', `Observation/${o.id}`, [{ op: 'test', path: '/status', value: 'nope' }], jp)).json.issue[0].details.text).toMatch(/Test failed/);
    expect((await call('PATCH', `Observation/${o.id}`, [{ op: 'replace', path: '/id', value: 'other' }], jp)).json.issue[0].details.text).toBe('Invalid id');
    expect((await call('PATCH', `Observation/${o.id}`, { resourceType: 'Parameters' }, jp)).status).toBe(400);
    expect((await call('PATCH', 'Observation/nope', [], jp)).status).toBe(404);
    expect((await call('GET', `Observation/${o.id}`)).json.status).toBe('amended');
    await call('DELETE', `Observation/${o.id}`);
    expect((await call('PATCH', `Observation/${o.id}`, [], jp)).status).toBe(410);
  });

  it('conditional update (0 creates, 1 updates, more 412) and conditional delete (more 412, 1 deletes, 0 is OK)', async () => {
    const idf = [{ system: 's', value: 'x' }];
    const c = await call('PUT', 'Observation?identifier=s|x', ob({ identifier: idf }));
    expect(c.status).toBe(201);
    expect(c.headers.get('location')).toBe(`${base}fhir/R4/Observation/${c.json.id}`);
    expect((await call('PUT', 'Observation?identifier=s|y', ob({ id: 'mine' }))).json.issue[0].details.text).toBe('Cannot perform create as update with client-assigned ID');
    const u = await call('PUT', 'Observation?identifier=s|x', ob({ identifier: idf, status: 'amended' }));
    expect([u.status, u.json.id, u.json.status]).toEqual([200, c.json.id, 'amended']);
    expect((await call('PUT', 'Observation?identifier=s|x', ob({ id: 'other', identifier: idf }))).json.issue[0].details.text).toBe('Resource ID did not match resolved ID');
    await call('POST', 'Observation', ob({ identifier: idf }));
    const many = await call('PUT', 'Observation?identifier=s|x', ob({ identifier: idf }));
    expect([many.status, many.json.id]).toEqual([412, 'multiple-matches']);
    expect((await call('DELETE', 'Observation?identifier=s|x')).status).toBe(412);
    expect((await call('DELETE', 'Observation?identifier=s|none')).status).toBe(200);
    expect((await call('DELETE', 'Observation')).status).toBe(405);
    await call('DELETE', `Observation/${c.json.id}`);
    expect((await call('DELETE', 'Observation?identifier=s|x')).status).toBe(200);
    expect(await count('&identifier=s|x')).toBe(0);
  });

  it('history: an instance lists versions and its delete (total, no links); type and system history page by _count with _since', async () => {
    const o = (await call('POST', 'Observation', ob({ status: 'preliminary' }))).json;
    await call('PUT', `Observation/${o.id}`, { ...o, status: 'final' });
    await call('DELETE', `Observation/${o.id}`);
    expect((await call('GET', `Observation/${o.id}`)).status).toBe(410);
    expect((await call('DELETE', `Observation/${o.id}`)).status).toBe(200); // as Medplum
    const h = (await call('GET', `Observation/${o.id}/_history`)).json;
    expect([h.type, h.total, h.link]).toEqual(['history', 3, undefined]);
    expect(h.entry.map((e: BundleEntry) => [e.request!.method, e.response!.status, e.resource?.meta?.versionId])).toEqual([['DELETE', '410', undefined], ['GET', '200', expect.any(String)], ['GET', '200', o.meta.versionId]]);
    expect(h.entry[2].request.url).toBe(`Observation/${o.id}/_history/${o.meta.versionId}`);
    const v = await call('GET', `Observation/${o.id}/_history/${o.meta.versionId}`);
    expect([v.status, v.json.status, v.headers.get('etag')]).toEqual([200, 'preliminary', `W/"${o.meta.versionId}"`]);
    expect((await call('GET', `Observation/${o.id}/_history/nope`)).status).toBe(404);
    expect((await call('GET', 'Observation/nope/_history')).status).toBe(404);
    const t0 = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const p = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    for (let i = 0; i < 3; i++) await call('POST', 'Observation', ob({ subject: P(p.id) }));
    let url: string | undefined = `${base}fhir/R4/_history?_count=2&_since=${encodeURIComponent(t0)}`;
    const seen: string[] = [];
    while (url) {
      const b = (await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json()) as Bundle;
      seen.push(...b.entry!.map((e) => e.resource!.resourceType));
      url = b.link?.find((l) => l.relation === 'next')?.url;
    }
    expect(seen).toEqual(['Observation', 'Observation', 'Observation', 'Patient']);
    const t = (await call('GET', 'Observation/_history?_count=100')).json;
    expect([t.total, t.entry.length, t.entry.every((e: BundleEntry) => e.fullUrl!.includes('/Observation/'))]).toEqual([undefined, 6, true]);
    expect((await call('GET', '_history?_count=0')).json.link.map((l: { relation: string }) => l.relation)).toEqual(['self', 'first']); // no next link to loop on
    expect((await call('GET', 'Observation/_history?_since=2024')).status).toBe(400);
    expect((await call('GET', 'Observation/_history?_at=2024-01-01T00:00:00Z')).status).toBe(400);
  });

  it('Patient/$everything: the Patient and its compartment by lastUpdated, then referenced records as includes; _count/_offset/_since/_type', async () => {
    const p = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    const other = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    const pr = (await call('POST', 'Practitioner', { resourceType: 'Practitioner' })).json;
    const med = (await call('POST', 'Medication', { resourceType: 'Medication' })).json;
    const enc = (await call('POST', 'Encounter', { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: P(p.id) })).json;
    await new Promise((r) => setTimeout(r, 5));
    const t1 = new Date().toISOString();
    const o = (await call('POST', 'Observation', ob({ subject: P(p.id), performer: [{ reference: `Practitioner/${pr.id}` }] }))).json;
    await call('POST', 'MedicationRequest', { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: P(p.id), medicationReference: { reference: `Medication/${med.id}` } });
    await call('POST', 'Observation', ob({ subject: P(other.id) }));
    const all = (await call('GET', `Patient/${p.id}/$everything`)).json;
    expect(all.type).toBe('searchset');
    expect(all.entry.map((e: BundleEntry) => `${e.search!.mode}:${e.resource!.resourceType}`)).toEqual(['match:Patient', 'match:Encounter', 'match:Observation', 'match:MedicationRequest', 'include:Practitioner', 'include:Medication']);
    expect(all.link.map((l: { relation: string }) => l.relation)).toEqual(['self', 'first']);
    expect(all.link[0].url).toBe(`${base}fhir/R4/Patient/${p.id}/$everything?_count=1000`);
    const p1 = (await call('GET', `Patient/${p.id}/$everything?_count=3`)).json;
    expect(p1.entry.map((e: BundleEntry) => e.resource!.resourceType)).toEqual(['Patient', 'Encounter', 'Observation', 'Practitioner']);
    expect(p1.link.find((l: { relation: string }) => l.relation === 'next').url).toBe(`${base}fhir/R4/Patient/${p.id}/$everything?_count=3&_offset=3`);
    const p2 = (await call('GET', `Patient/${p.id}/$everything?_count=3&_offset=3`)).json;
    expect(p2.entry.map((e: BundleEntry) => e.resource!.resourceType)).toEqual(['MedicationRequest', 'Medication']);
    expect(p2.link.map((l: { relation: string }) => l.relation)).toEqual(['self', 'first', 'previous']);
    expect((await call('GET', `Patient/${p.id}/$everything?_since=${encodeURIComponent(t1)}`)).json.entry.map((e: BundleEntry) => e.resource!.id)[0]).toBe(o.id);
    expect((await call('GET', `Patient/${p.id}/$everything?_type=Encounter`)).json.entry.map((e: BundleEntry) => e.resource!.id)).toEqual([p.id, enc.id]);
    expect((await call('GET', `Patient/${p.id}/$everything?_count=0`)).json.link.map((l: { relation: string }) => l.relation)).toEqual(['self', 'first']);
    expect((await call('GET', 'Patient/nope/$everything')).status).toBe(404);
    expect((await call('GET', `Patient/${p.id}/$everything?_include=x`)).status).toBe(400);
    expect((await call('GET', `Observation/${o.id}/$everything`)).status).toBe(404);
  });

  it('conditional requests need a real criterion: paging, sorting, shaping or format params alone and empty values are 400 and change nothing', async () => {
    const p = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    const other = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    const o = (await call('POST', 'Observation', ob({ subject: P(p.id), effectiveDateTime: '2024-01-01' }))).json;
    const none = ['_format=json', '_count=1', '_sort=date', 'code=', '_offset=2', '_include=Observation:subject', '_revinclude=Provenance:target', '_summary=count', '_elements=code', '_total=accurate', '_pretty=true', ''];
    for (const q of none) {
      expect((await call('DELETE', `Observation?${q}`)).status, `DELETE ${q}`).toBeGreaterThanOrEqual(400);
      expect((await call('PUT', `Observation?${q}`, ob({ subject: P(other.id) }))).status, `PUT ${q}`).toBe(400);
      expect((await call('POST', 'Observation', ob({ subject: P(other.id) }), { 'if-none-exist': q || '_count=1' })).status, `If-None-Exist ${q}`).toBe(400);
      expect((await call('POST', 'Observation', ob({ subject: { reference: `Patient?${q || '_count=1'}` } }))).status, `conditional reference ${q}`).toBe(400);
      expect((await tx('transaction', [{ request: { method: 'DELETE', url: `Observation?${q}` } }])).status, `transaction DELETE ${q}`).toBeGreaterThanOrEqual(400);
    }
    expect((await call('DELETE', 'Patient?_format=json')).status).toBe(400);
    expect((await call('GET', `Observation/${o.id}`)).json.subject).toEqual(P(p.id)); // untouched
    expect(await count()).toBe(1);
    expect((await call('GET', `Patient/${p.id}`)).status).toBe(200);
    // _offset can't slip a second match past the "more than one is 412" rule; a real criterion with _count still works.
    await call('POST', 'Observation', ob({ subject: P(p.id) }));
    expect((await call('DELETE', 'Observation?code:text=x&_offset=1')).status).toBe(400);
    expect((await call('DELETE', 'Observation?code:text=x&_count=1')).status).toBe(412);
    expect((await call('DELETE', `Observation?_id=${o.id}&_format=json`)).status).toBe(200);
    expect(await count()).toBe(1);
  });

  it('If-None-Exist counts matches only, never _include entries', async () => {
    const p = (await call('POST', 'Patient', { resourceType: 'Patient', identifier: [{ system: 's', value: 'inc' }] })).json;
    await call('POST', 'Observation', ob({ subject: P(p.id), identifier: [{ system: 's', value: 'one' }] }));
    // Medplum-style search with _include would list the Patient too: refused here, so it can't count as a second match.
    expect((await call('POST', 'Observation', ob(), { 'if-none-exist': 'identifier=s|one&_include=Observation:subject' })).status).toBe(400);
    expect((await call('POST', 'Observation', ob(), { 'if-none-exist': 'identifier=s|one' })).status).toBe(200);
  });

  it('a transaction PATCH sees urn rewriting: the subject becomes the new Patient, in its compartment; a dangling urn in a PATCH is 400', async () => {
    const o = (await call('POST', 'Observation', ob())).json;
    const X = 'urn:uuid:66666666-6666-4666-8666-666666666666';
    const bin = (ops: unknown) => ({ resourceType: 'Binary', contentType: 'application/json-patch+json', data: Buffer.from(JSON.stringify(ops)).toString('base64') }) as Resource;
    const r = await tx('transaction', [
      { request: { method: 'PATCH', url: `Observation/${o.id}` }, resource: bin([{ op: 'add', path: '/subject', value: { reference: X } }]) },
      { fullUrl: X, resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
    ]);
    const pid = r.json.entry[1].resource.id;
    expect(r.json.entry[0].resource.subject).toEqual(P(pid));
    expect(r.json.entry[0].resource.meta.compartment).toEqual([P(pid)]);
    const dangling = await tx('transaction', [{ request: { method: 'PATCH', url: `Observation/${o.id}` }, resource: bin([{ op: 'replace', path: '/subject/reference', value: 'urn:uuid:77777777-7777-4777-8777-777777777777' }]) }]);
    expect(dangling.status).toBe(400);
    const plain = await call('PATCH', `Observation/${o.id}`, [{ op: 'add', path: '/performer', value: [{ reference: 'urn:uuid:77777777-7777-4777-8777-777777777777' }] }], { 'content-type': 'application/json-patch+json' });
    expect(plain.status).toBe(400);
    expect((await call('GET', `Observation/${o.id}`)).json.subject).toEqual(P(pid));
  });

  it('$everything never includes another patient\'s records (a performer Patient, or anything in a compartment)', async () => {
    const a = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    const b = (await call('POST', 'Patient', { resourceType: 'Patient' })).json;
    const bEnc = (await call('POST', 'Encounter', { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: P(b.id) })).json;
    const org = (await call('POST', 'Organization', { resourceType: 'Organization', name: 'Synthetic clinic' })).json;
    await call('POST', 'Observation', ob({ subject: P(a.id), performer: [P(b.id), { reference: `Organization/${org.id}` }], encounter: { reference: `Encounter/${bEnc.id}` } }));
    const e = (await call('GET', `Patient/${a.id}/$everything`)).json;
    expect(e.entry.map((x: BundleEntry) => `${x.search!.mode}:${x.resource!.resourceType}/${x.resource!.id}`)).toEqual([`match:Patient/${a.id}`, expect.stringMatching(/^match:Observation\//), `include:Organization/${org.id}`]);
  });

  it('instance history total follows _since; history of an unknown type is 400; a malformed _filter is 400', async () => {
    const o = (await call('POST', 'Observation', ob({ status: 'preliminary' }))).json;
    await new Promise((r) => setTimeout(r, 5));
    const t = new Date().toISOString();
    await call('PUT', `Observation/${o.id}`, { ...o, status: 'final' });
    const h = (await call('GET', `Observation/${o.id}/_history?_since=${encodeURIComponent(t)}`)).json;
    expect([h.total, h.entry.length]).toEqual([1, 1]);
    expect((await call('GET', 'Nonsense/_history')).status).toBe(400);
    expect((await call('GET', 'ValueSet/_history')).status).toBe(200); // every R4 type by default
    expect((await call('GET', 'Observation?_filter=x')).status).toBe(400);
  });

  it('PUT Binary/<id> replaces the bytes and keeps the id; an unknown id is 404', async () => {
    const r = await fetch(`${base}fhir/R4/Binary`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: 'one' });
    const { id } = await r.json() as { id: string };
    expect(r.headers.get('location')).toBe(`${base}fhir/R4/Binary/${id}`);
    const put = await fetch(`${base}fhir/R4/Binary/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' }, body: 'two!' });
    expect([put.status, await put.json()]).toEqual([200, { resourceType: 'Binary', id, contentType: 'application/pdf' }]);
    const got = await fetch(`${base}fhir/R4/Binary/${id}`, { headers: { authorization: `Bearer ${token}`, accept: '*/*' } });
    expect([got.headers.get('content-type'), await got.text()]).toEqual(['application/pdf', 'two!']);
    expect((await fetch(`${base}fhir/R4/Binary/00000000-0000-4000-8000-000000000000`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: 'x' })).status).toBe(404);
    expect((await tx('batch', [{ request: { method: 'GET', url: `Binary/${id}` } }])).json.entry[0].response.status).toBe('400');
  });

  it('ETag and Last-Modified on read, create, update; Location (absolute) only on 201', async () => {
    const c = await call('POST', 'Observation', ob());
    expect([c.status, c.headers.get('etag'), c.headers.get('location')]).toEqual([201, `W/"${c.json.meta.versionId}"`, `${base}fhir/R4/Observation/${c.json.id}`]);
    expect(c.headers.get('last-modified')).toBe(new Date(c.json.meta.lastUpdated).toUTCString());
    const r = await call('GET', `Observation/${c.json.id}`);
    expect([r.headers.get('etag'), r.headers.get('last-modified')]).toEqual([c.headers.get('etag'), c.headers.get('last-modified')]);
    const u = await call('PUT', `Observation/${c.json.id}`, { ...c.json, status: 'amended' });
    expect([u.headers.get('etag'), u.headers.get('location')]).toEqual([`W/"${u.json.meta.versionId}"`, null]);
    const again = await call('POST', 'Observation', ob(), { 'if-none-exist': `_id=${c.json.id}` });
    expect([again.status, again.headers.get('location')]).toEqual([200, null]);
  });

  it('GET metadata describes this store: types, interactions, search parameters (no composite), operations', async () => {
    const m = (await call('GET', 'metadata')).json;
    expect(m).toMatchObject({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', kind: 'instance', patchFormat: ['application/json-patch+json'] });
    const rest = m.rest[0];
    expect(rest.interaction.map((i: { code: string }) => i.code)).toEqual(['transaction', 'batch', 'history-system']);
    const obsCap = rest.resource.find((r: { type: string }) => r.type === 'Observation');
    expect(obsCap.searchParam.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['code', 'date', 'subject', '_lastUpdated']));
    expect(obsCap.searchParam.some((p: { type: string }) => p.type === 'composite')).toBe(false);
    expect(rest.resource.find((r: { type: string }) => r.type === 'Patient').operation[0].name).toBe('everything');
    for (const t of ['ValueSet', 'Questionnaire', 'Subscription']) expect(rest.resource.some((r: { type: string }) => r.type === t), t).toBe(true);
    expect(rest.resource.length).toBeGreaterThan(140);
  });
});

describe('serve.ts command line and maxBinaryBytes', () => {
  it('parses the options; --file and --token-file are required; numbers are checked', () => {
    expect(parseServeArgs(['--file', '/d/x.db', '--token-file', '/d/t'])).toEqual({ file: '/d/x.db', tokenFile: '/d/t', host: '127.0.0.1', port: 8120, maxBinaryBytes: undefined });
    expect(parseServeArgs(['--file', 'a', '--token-file', 'b', '--host', '0.0.0.0', '--port', '9000', '--max-binary-bytes', '1024'])).toMatchObject({ host: '0.0.0.0', port: 9000, maxBinaryBytes: 1024 });
    expect(() => parseServeArgs(['--file', 'a'])).toThrow(/usage/);
    expect(() => parseServeArgs(['--file', 'a', '--token-file', 'b', '--port', 'x'])).toThrow(/whole number/);
    expect(() => parseServeArgs(['--file', 'a', '--token-file', 'b', '--bogus'])).toThrow();
  });

  it('maxBinaryBytes caps a streamed Binary (413) and leaves JSON bodies at their own limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-lim-'));
    const s = await serveStore({ file: join(dir, 'x.db'), port: 0, tokenFile: join(dir, 'token'), maxBinaryBytes: 1024 });
    try {
      const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/fhir/R4/`;
      const headers = { authorization: `Bearer ${readFileSync(join(dir, 'token'), 'utf8').trim()}`, 'content-type': 'application/octet-stream' };
      expect((await fetch(`${base}Binary`, { method: 'POST', headers, body: new Uint8Array(1024) })).status).toBe(201);
      expect((await fetch(`${base}Binary`, { method: 'POST', headers, body: new Uint8Array(1025) })).status).toBe(413);
      const patient = JSON.stringify({ resourceType: 'Patient', name: [{ text: 'x'.repeat(4096) }] });
      expect((await fetch(`${base}Patient`, { method: 'POST', headers: { ...headers, 'content-type': 'application/fhir+json' }, body: patient })).status).toBe(201);
    } finally { s.closeAllConnections(); await new Promise((r) => s.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });
});
