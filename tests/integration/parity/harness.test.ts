import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { guardProject, marker, paritySides, type Side } from './harness.ts';

describe.skipIf(SQLITE)('parity harness', () => {
  let sides: [Side, Side], close: () => Promise<void>, fresh: Awaited<ReturnType<typeof paritySides>>;
  beforeAll(async () => {
    // fresh stands in for a crashed run: its leftover is swept by the paritySides() after it (same admin), and fresh checks deletions.
    fresh = await paritySides();
    await fresh.sides[0].create({ resourceType: 'Basic', code: { text: 'parity-leftover' } });
    ({ sides, close } = await paritySides());
  }, 240_000);
  afterAll(async () => { await close?.(); await fresh?.close(); }, 120_000);

  test('the Medplum side is an admin login scoped to a ga-test project', async () => {
    const me = (await sides[0].call('GET', '../../auth/me')).json;
    expect(me.project.name).toBe('ga-test-parity');
    expect(me.membership.admin).toBe(true);
  });
  test('refuses a project that is not ga-test*', async () => {
    await expect(guardProject({ project: { name: 'Guardian Angel' } })).rejects.toThrow('not a ga-test project');
  });
  test('records created ids and deletes them on close', async () => {
    const m = marker();
    const own = await paritySides();
    const o = await own.sides[0].create({ resourceType: 'Basic', code: { text: m } });
    expect((await fresh.sides[0].call('GET', `Basic/${o.id}`)).status).toBe(200);
    await own.close();
    expect((await fresh.sides[0].call('GET', `Basic/${o.id}`)).status).toBeGreaterThanOrEqual(404); // 404 or 410
  }, 120_000);
  test('sweeps leftovers before the run', async () => {
    const left = await sides[0].call('GET', 'Basic?code:text=parity-leftover');
    expect(left.json.entry ?? []).toEqual([]);
  });
  test('store side accepts a type outside GA_STORE_TYPES', async () => {
    expect((await sides[1].call('POST', 'ResearchStudy', { resourceType: 'ResearchStudy', status: 'active' })).status).toBe(201);
  });
});
