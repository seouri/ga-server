// A store opened with a type set (its own file: the definitions are loaded once per process) accepts only those types.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSearchParameters } from '@medplum/core';
import { describe, expect, it } from 'vitest';
import { loadDefinitions, storedTypes } from '../definitions.ts';
import { parseServeArgs } from '../serve.ts';
import { serveStore } from '../server.ts';
import { Store } from '../store.ts';

describe('types option', () => {
  it('a store opened with types refuses the others; the set is fixed for the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-types-'));
    const types = parseServeArgs(['--file', 'a', '--token-file', 'b', '--types', 'Patient, Observation,Binary']).types;
    expect(types).toEqual(['Patient', 'Observation', 'Binary']);
    expect(() => new Store(join(dir, 'x.db'), { types: ['Patient', 'NotAType'] })).toThrow(/not FHIR R4 resource types: NotAType/);
    expect(() => new Store(join(dir, 'x.db'), { types: [] })).toThrow(/no resource types/);
    expect(() => loadDefinitions([])).toThrow(/no resource types/);
    for (const t of [',', ' , ', '']) expect(() => parseServeArgs(['--file', 'a', '--token-file', 'b', '--types', t]), t).toThrow(/no resource types/);
    const s = await serveStore({ file: join(dir, 'x.db'), port: 0, tokenFile: join(dir, 'token'), types });
    try {
      expect(storedTypes()).toEqual(['Binary', 'Observation', 'Patient']);
      expect(getSearchParameters('Questionnaire')).toBeUndefined();
      const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/fhir/R4/`;
      const headers = { authorization: `Bearer ${readFileSync(join(dir, 'token'), 'utf8').trim()}`, 'content-type': 'application/fhir+json' };
      expect((await fetch(`${base}Patient`, { method: 'POST', headers, body: '{"resourceType":"Patient"}' })).status).toBe(201);
      expect((await fetch(`${base}Questionnaire`, { method: 'POST', headers, body: '{"resourceType":"Questionnaire","status":"draft"}' })).status).toBe(400);
      expect((await fetch(`${base}Questionnaire?url=x`, { headers })).status).toBe(400);
      expect((await fetch(`${base}Questionnaire/_history`, { headers })).status).toBe(400);
      const cap = await (await fetch(`${base}metadata`, { headers })).json();
      expect(cap.rest[0].resource.map((r: { type: string }) => r.type)).toEqual(['Binary', 'Observation', 'Patient']);
      expect(() => loadDefinitions()).toThrow(/smaller type set/);
      expect(() => new Store(join(dir, 'y.db'))).toThrow(/one type set per process/);
    } finally { s.closeAllConnections(); await new Promise((r) => s.close(r)); rmSync(dir, { recursive: true, force: true }); }
  });
});
