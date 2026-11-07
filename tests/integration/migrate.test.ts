// ga migrate end to end on synthetic fixtures: a throwaway "old" project (its client a project admin, standing in for the
// Super Admin client) -> a throwaway new project, then --delete-old. Never the user's record or config.
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Observation, ProjectMembership, Resource } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { importAppleHealth } from '../../src/apple/import.ts';
import { importPath } from '../../src/ccda.ts';
import { getClient, loadConfig } from '../../src/config.ts';
import { importEhi } from '../../src/ehi/import.ts';
import { logRemote } from '../../src/gateway/remote-log.ts';
import { importExtracted } from '../../src/mcp.ts';
import { deleteOld, migrate } from '../../src/migrate.ts';
import { setup } from '../../src/setup.ts';
import { logAccess } from '../../src/share/audit.ts';
import { listShares, type Share } from '../../src/share/store.ts';
import { writeAtomic } from '../../src/smart/store.ts';
import { expungeProject, throwawayConfig } from './helpers.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');

test('ga migrate re-imports into a new project, verifies and switches; --delete-old removes the old copy', { timeout: 600_000 }, async () => {
  const { dir, baseUrl, session } = await throwawayConfig();
  const tag = randomUUID().slice(0, 8);
  const projects: string[] = [];
  try {
    const made = await setup(baseUrl, undefined, { projectName: `ga-test-old-${tag}` });
    projects.push(made.projectId as string);
    const m = (await session.searchOne('ProjectMembership', { profile: `ClientApplication/${made.clientId}` })) as ProjectMembership;
    await session.updateResource<ProjectMembership>({ ...m, admin: true, accessPolicy: undefined });
    const { projectId: _p, ...legacy } = made; // an install from before GA had its own project
    writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy), { mode: 0o600 });
    await expect(setup(baseUrl)).rejects.toThrow('run ga migrate'); // a plain setup must not repoint an old install

    const src = join(dir, 'sources');
    mkdirSync(join(src, 'ccda'), { recursive: true });
    copyFileSync(join(FIX, 'ccda-synthetic.xml'), join(src, 'ccda', 'summary.xml'));
    cpSync(join(FIX, 'ehi'), join(src, 'ehi'), { recursive: true });
    cpSync(join(FIX, 'apple'), join(src, 'apple'), { recursive: true });
    // A distinct file: the EHI fixture holds the same PDF as media, and a file is imported once.
    writeFileSync(join(src, 'labs.pdf'), Buffer.concat([readFileSync(join(FIX, 'labs-synthetic.pdf')), Buffer.from('\n%migrate-test\n')]));
    const old = await getClient(legacy);
    await importPath(old, legacy, join(src, 'ccda', 'summary.xml'));
    await importEhi(old, legacy, join(src, 'ehi'));
    await importAppleHealth(old, legacy, join(src, 'apple'));
    await importExtracted(old, legacy, [
      { resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'Synthetic marker' }, effectiveDateTime: '2024-01-02', valueQuantity: { value: 42, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' } },
      { resourceType: 'DiagnosticReport', status: 'final', code: { text: 'Synthetic panel' }, result: [{ reference: 'Observation/o1' }] },
      { resourceType: 'Condition', code: { text: 'Synthetic condition' } },
    ] as Resource[], join(src, 'labs.pdf'), '2024-01-03');
    const share = { id: 'share1', label: 'Dr Test', patientId: legacy.patientId, tokenHash: 'h' } as Share;
    await logAccess(old, share, { kind: 'view' });
    await logRemote(old, 'fhir_search', 'test app');
    writeAtomic(join(dir, 'share', 'shares.json'), JSON.stringify([share, { ...share, id: 'share2', patientId: 'someone-else' }]), 0o600);

    await new Promise((r) => setTimeout(r, 61_000)); // Medplum allows 5 admin auth calls a minute; migrate's setup needs 2
    const { rows } = await migrate({ projectName: `ga-test-new-${tag}` });
    const now = loadConfig();
    projects.push(now.projectId as string);
    expect(now.projectId).not.toBe(made.projectId);
    expect(statSync(join(dir, 'config.super-admin.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'config.next.json'))).toBe(false);
    expect(listShares(join(dir, 'share')).map((s) => s.patientId)).toEqual([now.patientId, 'someone-else']);
    const obs = rows.find((r) => r.type === 'Observation');
    expect(obs?.new).toBeGreaterThan(0);
    for (const r of rows) expect(r.new, r.type).toBe(r.old);
    expect(rows.find((r) => r.type === 'AuditEvent (GA logs)')).toEqual({ type: 'AuditEvent (GA logs)', old: 2, new: 2 });
    const nc = await getClient(now);
    const [rep] = await nc.searchResources('DiagnosticReport', { _tag: 'urn:ga-server:tag|extracted-by-llm' }, { cache: 'no-cache' });
    const ref = rep?.result?.[0]?.reference as string; // the engine re-linked the report to the new Observation
    expect(ref).toMatch(/^Observation\//);
    expect(((await nc.readReference({ reference: ref })) as Observation).valueQuantity?.value).toBe(42);
    await expect(migrate()).rejects.toThrow('already migrated');

    const counts = await deleteOld();
    expect(counts.Patient).toBe(1);
    expect(counts.Binary).toBeGreaterThan(0);
    expect(counts.ClientApplication).toBe(1);
    await expect(getClient(legacy)).rejects.toThrow();
    for (const t of ['Observation', 'DocumentReference', 'AuditEvent'] as const) {
      expect((await session.search(t, { _project: made.projectId as string, _summary: 'count' }, { cache: 'no-cache' })).total, t).toBe(0);
    }
    // GA's shared records go too; the admin's own Practitioner profile in that project stays.
    expect((await session.search('Practitioner', { _project: made.projectId as string, _tag: 'urn:ga-server:tag|src-ccda', _summary: 'count' }, { cache: 'no-cache' })).total).toBe(0);
    expect((await nc.search('Observation', { _compartment: `Patient/${now.patientId}`, _summary: 'count' }, { cache: 'no-cache' })).total).toBe(obs?.new);
  } finally {
    delete process.env.GA_CONFIG;
    for (const p of projects) await expungeProject(session, p);
  }
});
