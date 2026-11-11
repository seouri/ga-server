// ga setup with GA_STORE=sqlite: the self Patient in the store, a config without Medplum credentials, no Medplum calls.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setup } from '../src/setup.ts';
import { tempStore, type TempStore } from './temp-store.ts';

let store: TempStore, dir: string, base: string;
beforeEach(async () => {
  store = await tempStore();
  ({ dir, base } = store);
  vi.stubEnv('GA_STORE', 'sqlite');
  vi.stubEnv('GA_STORE_URL', base);
  vi.stubEnv('GA_CONFIG', join(dir, 'config.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await store.close();
});

test('setup on the store creates exactly one self Patient (twice) and writes a config without Medplum credentials', async () => {
  const medplum = 'http://127.0.0.1:9/'; // never contacted: a Medplum call would fail the test
  const first = await setup(medplum);
  const again = await setup(medplum);
  expect(again.patientId).toBe(first.patientId);
  const patients = await store.client.searchResources('Patient', {});
  expect(patients.map((p) => p.id)).toEqual([first.patientId]);
  expect(patients[0].identifier).toEqual([{ system: 'urn:ga-server:id:patient', value: 'self' }]);
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  expect(cfg).toEqual({ patientId: first.patientId, store: 'sqlite' });
  expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
});

test('a setup re-run on the store keeps the other config keys (Medplum rollback, storeUrl); only patientId changes (a leftover converterUrl stays as written)', async () => {
  const before = { baseUrl: 'http://localhost:8103/', clientId: 'c', clientSecret: 's', patientId: 'old', projectId: 'pr', converterUrl: 'http://old:8104/', storeUrl: 'http://store:8120/', adminPassword: 'pw' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(before));
  const cfg = await setup('http://127.0.0.1:9/');
  expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ ...before, patientId: cfg.patientId, store: 'sqlite' });
  expect(cfg.patientId).not.toBe('old');
});

test('setup on the store refuses to overwrite a config it cannot parse', async () => {
  writeFileSync(join(dir, 'config.json'), '{"clientSecret": "s",');
  await expect(setup('http://127.0.0.1:9/')).rejects.toThrow(/cannot read/);
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{"clientSecret": "s",');
});

test('noRotate refuses to rotate the default password', async () => {
  const { createServer } = await import('node:http');
  const tried: string[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      tried.push((JSON.parse(body || '{}') as { password?: string }).password ?? '');
      res.writeHead(400, { 'content-type': 'application/fhir+json' });
      res.end(JSON.stringify({ resourceType: 'OperationOutcome', id: 'bad-request', issue: [{ severity: 'error', code: 'invalid', details: { text: 'Invalid password' } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
    vi.stubEnv('GA_STORE', 'medplum');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ baseUrl: url, adminPassword: 'stored-wrong' }));
    await expect(setup(url, { projectName: 'ga-test', noRotate: true })).rejects.toThrow(/not trying the default/);
    expect(tried).toEqual(['stored-wrong']);
  } finally {
    srv.close();
  }
});

test('noRotate never changes a stored default password', async () => {
  const { createServer } = await import('node:http');
  const seen: string[] = [];
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'none' })}.${b64({ login_id: 'l1', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      seen.push(`${req.method} ${path}`);
      const send = (o: object, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/fhir+json' });
        res.end(JSON.stringify(o));
      };
      if (path === '/auth/login') {
        const pw = (JSON.parse(body) as { password: string }).password;
        if (pw !== 'medplum_admin') return send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'Invalid password' } }] }, 400);
        return send({ login: 'l1', code: 'c1' });
      }
      if (path === '/oauth2/token') return send({ access_token: jwt, refresh_token: jwt, expires_in: 3600, project: { reference: 'Project/p1' }, profile: { reference: 'Practitioner/u1' } });
      if (path === '/auth/me') return send({ project: { resourceType: 'Project', id: 'p1' }, membership: { resourceType: 'ProjectMembership', id: 'm0' }, profile: { resourceType: 'Practitioner', id: 'u1' } });
      if (path === '/auth/changepassword') return send({ resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational' }] });
      const type = path.split('/')[3];
      const resources: Record<string, object> = {
        AccessPolicy: { resourceType: 'AccessPolicy', id: 'ap1', name: 'ga-server-cli' },
        ClientApplication: { resourceType: 'ClientApplication', id: 'ca1', secret: 's1', name: 'ga-server-cli' },
        ProjectMembership: { resourceType: 'ProjectMembership', id: 'm1', admin: false, accessPolicy: { reference: 'AccessPolicy/ap1' } },
        Patient: { resourceType: 'Patient', id: 'pt1' },
      };
      const r = resources[type];
      if (req.method === 'GET' && r) return send({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: r }] });
      if ((req.method === 'POST' || req.method === 'PUT') && r) return send(r, req.method === 'POST' ? 201 : 200);
      send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }, 404);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
    vi.stubEnv('GA_STORE', 'medplum');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ baseUrl: url, adminPassword: 'medplum_admin', projectId: 'p1' }));
    const out = join(dir, 'config.json');
    const cfg = await setup(url, { projectName: 'ga-test', noRotate: true });
    expect(seen).not.toContain('POST /auth/changepassword');
    expect(cfg.adminPassword).toBe('medplum_admin');
    expect(JSON.parse(readFileSync(out, 'utf8')).adminPassword).toBe('medplum_admin');
  } finally {
    srv.close();
  }
});
