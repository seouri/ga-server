// Built-in terminology (store plan 2): Medplum shows its R4 project's CodeSystems and ValueSets to every project, read-only;
// the store seeds the same bundles. Not Medplum ports: titles carry [store-plan-2]. Built-in ids differ between the two
// servers, so records are found by url.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SQLITE } from '../helpers.ts';
import { paritySides, q, same, search, type Side } from './harness.ts';

const URL_ = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';

describe.skipIf(SQLITE)('built-in terminology (parity)', () => {
  let sides: [Side, Side], close: () => Promise<void>;
  beforeAll(async () => ({ sides, close } = await paritySides()), 240_000);
  afterAll(async () => close?.(), 120_000);

  test('built-in totals match [store-plan-2]', () => same(sides, async (s) => {
    const totals = [];
    for (const type of ['CodeSystem', 'ValueSet']) totals.push((await search(s, q(type, ['_summary', 'count']))).total);
    expect(totals).toEqual([1108, 1346]);
    return totals;
  }));

  test('a write to a built-in is 403 [store-plan-2]', () => same(sides, async (s) => {
    const cs = (await search(s, q('CodeSystem', ['url', URL_]))).entry?.[0]?.resource as { id: string; status: string };
    expect(cs?.id).toBeTruthy();
    const out = [];
    for (const [method, body] of [['PUT', { ...cs, status: 'retired' }], ['PATCH', [{ op: 'replace', path: '/status', value: 'retired' }]], ['DELETE', undefined]] as const) {
      const g = await s.call(method, `CodeSystem/${cs.id}`, body, method === 'PATCH' ? { 'content-type': 'application/json-patch+json' } : {});
      out.push({ method, status: g.status, code: g.json?.issue?.[0]?.code, text: g.json?.issue?.[0]?.details?.text });
    }
    expect(out.map((o) => o.status)).toEqual([403, 403, 403]);
    expect(((await search(s, q('CodeSystem', ['url', URL_]))).entry?.[0]?.resource as { status?: string } | undefined)?.status).toBe(cs.status); // unchanged
    return out;
  }));
});
