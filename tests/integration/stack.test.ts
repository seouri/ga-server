import type { AuditEvent, DocumentReference, Resource, ResourceType } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { setup } from '../../src/setup.ts';
import { cleanupTestPatient, createTestPatient, emptyTestProject, restoreConfig, retryLimited, SQLITE, testProject } from './helpers.ts';

// Runs ga setup against the long-lived ga-test project (temp GA_CONFIG), never the user's own; emptied before and after.
test('setup is idempotent, and the GA client reads clinical records but no Medplum admin records', { timeout: 240_000 }, async () => {
  const realPatient = SQLITE ? '' : loadConfig().patientId;
  const { baseUrl, cfg: a } = await testProject();
  const empty = async () => emptyTestProject(await getClient(a));
  try {
    await empty(); // an earlier run that stopped half-way
    const b = await retryLimited(() => setup(baseUrl, a.converterUrl, { projectName: 'ga-test' }));
    expect([b.projectId, b.patientId, b.clientId]).toEqual([a.projectId, a.patientId, a.clientId]);
    expect(loadConfig().projectId).toBe(a.projectId);
    const client = await getClient(loadConfig());
    expect((await client.readResource('Patient', a.patientId)).id).toBe(a.patientId);
    // Medplum only (the store has no login, project or admin records): the client is an ordinary project member.
    if (!SQLITE) {
      const me = (await client.get('auth/me')) as { project: { id: string }; membership: { admin?: boolean } };
      expect(me.project.id).toBe(a.projectId);
      expect(me.membership.admin ?? false).toBe(false);

      for (const t of ['ClientApplication', 'User', 'Login', 'Project', 'ProjectMembership', 'AccessPolicy', 'Bot', 'JsonWebKey', 'Subscription', 'UserConfiguration']) {
        await expect(client.search(t as ResourceType, {}, { cache: 'no-cache' }), t).rejects.toThrow(/Forbidden/);
    }
    await expect(client.readResource('ClientApplication', a.clientId as string)).rejects.toThrow();
    await expect(client.readResource('Project', a.projectId as string)).rejects.toThrow();
    // The user's record lives in another project: invisible from here.
    await expect(client.readResource('Patient', realPatient)).rejects.toThrow(/Not found/);
    }

    const subject = { reference: `Patient/${a.patientId}` };
    await client.validateResource({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject });
    const bin = await client.createBinary({ data: 'synthetic', contentType: 'text/plain', filename: 'a.txt' });
    const doc = await client.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', subject, content: [{ attachment: { url: `Binary/${bin.id}` } }] });
    const url = (await client.readResource('DocumentReference', doc.id as string)).content[0].attachment.url as string;
    expect(await (await client.download(url)).text()).toBe('synthetic');
    await client.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: [{ request: { method: 'POST', url: 'Observation' }, resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject } }] });
    for (const resourceType of ['Medication', 'Practitioner', 'Organization', 'Location', 'Device'] as const) await client.createResource({ resourceType } as Resource);
    await client.createResource<AuditEvent>({ resourceType: 'AuditEvent', type: { code: 'rest' }, recorded: new Date().toISOString(), agent: [{ requestor: true }], source: { observer: { display: 'test' } } });
    await client.createResource({ resourceType: 'Endpoint', status: 'active', connectionType: { code: 'hl7-fhir-rest' }, payloadType: [{ text: 'x' }], address: 'https://example.org/fhir' } as Resource);
    expect((await client.search('Observation', { _compartment: `Patient/${a.patientId}`, _summary: 'count' }, { cache: 'no-cache' })).total).toBe(1);
  } finally {
    await empty();
    restoreConfig();
  }
});

test('test patient helpers round-trip', async () => {
  const client = await getClient(loadConfig());
  const id = await createTestPatient(client);
  await client.createResource({
    resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${id}` },
  });
  await cleanupTestPatient(client, id);
  await expect(client.readResource('Patient', id)).rejects.toThrow();
  expect(await client.searchResources('Observation', { subject: `Patient/${id}` })).toHaveLength(0);
});
