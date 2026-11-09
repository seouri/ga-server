// Side-by-side harness: the same request against Medplum (an admin login scoped to the long-lived ga-test-parity project, never
// the owner's project) and against a temp store with every R4 type. Ported Medplum tests run through both().
import { randomUUID } from 'node:crypto';
import { MedplumClient } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { expect } from 'vitest';
import { bearer } from '../../../src/config.ts';
import { setup } from '../../../src/setup.ts';
import { tempStore } from '../../temp-store.ts';
import { retryLimited, throwawayConfig } from '../helpers.ts';

export type Got = { status: number; headers: Headers; json: any; text: string };
export type Side = {
  name: 'medplum' | 'store'; base: string;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Got>; // path is relative to fhir/R4/
  create<T extends Resource>(r: T): Promise<T & { id: string }>; // POST, expects 201, remembers the id for cleanup
};

// Types the ported tests create, swept before a run (a crashed run leaves records). Later tasks extend it.
export const PARITY_TYPES = ['Observation', 'Condition', 'Patient', 'Basic', 'ResearchStudy', 'Practitioner', 'Organization', 'Appointment', 'Slot',
  'ImagingStudy', 'DiagnosticReport', 'Flag', 'PractitionerRole', 'Coverage', 'CoverageEligibilityRequest', 'Encounter', 'Communication', 'ServiceRequest',
  'Questionnaire', 'QuestionnaireResponse', 'Location', 'HealthcareService', 'AuditEvent', 'AllergyIntolerance', 'CareTeam', 'Provenance', 'Task', 'Goal',
  'MeasureReport', 'RiskAssessment', 'DeviceRequest', 'Composition', 'Bundle', 'SpecimenDefinition'];
const PROJECT = 'ga-test-parity';

export async function guardProject(me: { project: { name?: string } }): Promise<void> {
  if (!/^ga-test/.test(me.project.name ?? '')) throw new Error(`not a ga-test project: ${me.project.name}`);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// Same shape: uuids and base URLs blanked, Medplum's tracing extension and meta dropped.
export const shape = (x: unknown, base: string): unknown => JSON.parse(JSON.stringify(x, (k, v) => (k === 'meta' || (k === 'extension' && JSON.stringify(v).includes('tracing')) ? undefined : v))
  .replaceAll(base, 'BASE/').replace(UUID, 'ID'));

export const marker = (): string => `parity-${randomUUID()}`;
export const both = async <T>(sides: [Side, Side], fn: (s: Side) => Promise<T>): Promise<[T, T]> => [await fn(sides[0]), await fn(sides[1])];
// both() (a failure names its side), then the two results must have the same shape.
export async function same<T>(sides: [Side, Side], fn: (s: Side) => Promise<T>): Promise<[T, T]> {
  const r = await both(sides, async (s) => {
    try { return await fn(s); } catch (e) { if (e instanceof Error) e.message = `[${s.name}] ${e.message}`; throw e; }
  });
  if (r[0] !== undefined || r[1] !== undefined) expect(shape(r[1], sides[1].base)).toEqual(shape(r[0], sides[0].base));
  return r;
}

export const ref = (r: { resourceType: string; id: string }): { reference: string } => ({ reference: `${r.resourceType}/${r.id}` });
// A query path from params, each value encoded.
export const q = (type: string, ...params: [string, string][]): string => `${type}?${new URLSearchParams(params)}`;
// GET a search; anything but 200 throws with the body.
export async function search(s: Side, path: string): Promise<Bundle> {
  const g = await s.call('GET', path);
  if (g.status !== 200) throw new Error(`${s.name} GET ${path}: ${g.status} ${g.text}`);
  return g.json;
}
// A searchset's entries by the names of the records the test created (`include:` before an included one, `?` for others),
// comparable across sides.
export const names = (b: Bundle, named: Record<string, { id?: string }>): string[] => (b.entry ?? []).map((e) => {
  const n = Object.keys(named).find((k) => named[k].id === e.resource?.id) ?? '?';
  return e.search?.mode === 'include' ? `include:${n}` : n;
});
// The issue text of an error answer, with its status.
export async function error(s: Side, path: string): Promise<{ status: number; text?: string }> {
  const g = await s.call('GET', path);
  return { status: g.status, text: g.json?.issue?.[0]?.details?.text };
}

function side(name: Side['name'], base: string, token: () => string, created?: string[]): Side {
  const s: Side = {
    name, base,
    async call(method, path, body, headers = {}) {
      const r = await bearer(token())(`${base}fhir/R4/${path}`, {
        method, headers: { 'content-type': 'application/fhir+json', accept: 'application/fhir+json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      const loc = r.status === 201 ? r.headers.get('location')?.match(/([A-Za-z]+\/[^/]+)(?:\/_history.*)?$/)?.[1] : undefined;
      if (loc) created?.push(loc);
      return { status: r.status, headers: r.headers, json, text };
    },
    async create(r) {
      const g = await s.call('POST', r.resourceType, r);
      if (g.status !== 201) throw new Error(`create ${r.resourceType}: ${g.status} ${g.text}`);
      return g.json;
    },
  };
  return s;
}

export async function paritySides(): Promise<{ sides: [Side, Side]; close(): Promise<void> }> {
  const t = await throwawayConfig();
  const cfg = await retryLimited(() => setup(t.baseUrl, { projectName: PROJECT }));
  const admin = new MedplumClient({ baseUrl: t.baseUrl });
  const { code } = await retryLimited(() => admin.startLogin({ email: 'admin@example.com', password: cfg.adminPassword as string, projectId: cfg.projectId }));
  await admin.processCode(code as string);
  const me = (await admin.get('auth/me', { cache: 'no-cache' })) as { project: { name?: string }; membership?: { profile?: { reference?: string } } };
  await guardProject(me);
  // Delete what an earlier (crashed) run left: the project is this harness's alone and Medplum sets no meta.author for this login,
  // so every record of the types goes, except GA setup's self Patient (setup keeps finding it) and the admin's own profile Practitioner.
  for (const type of PARITY_TYPES) {
    for (;;) {
      const rs = (await admin.searchResources(type as 'Basic', { _count: '1000' }, { cache: 'no-cache' }))
        .filter((r) => !(type === 'Patient' && (r as { identifier?: { value?: string }[] }).identifier?.some((i) => i.value === 'self'))
          && `${type}/${r.id}` !== me.membership?.profile?.reference);
      if (!rs.length) break;
      for (const r of rs) await admin.deleteResource(type as 'Basic', r.id as string);
    }
  }
  const created: string[] = [];
  const medplum = side('medplum', t.baseUrl, () => admin.getAccessToken() as string, created);
  const store = await tempStore(undefined, 'all');
  return {
    sides: [medplum, side('store', store.base, () => store.token)],
    async close() {
      try {
        for (const ref of [...created].reverse()) {
          const g = await medplum.call('DELETE', ref);
          if (g.status >= 400 && g.status !== 404 && g.status !== 410) throw new Error(`cleanup ${ref}: ${g.status}`);
        }
      } finally {
        await store.close();
      }
    },
  };
}
