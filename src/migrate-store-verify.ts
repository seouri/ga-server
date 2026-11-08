// ga migrate-store's "same answers" check: replays GA's read tools, a fixed set of agent-style searches and every search the
// tools sent, on Medplum and on the migrated store, and compares the answers. Results are categories only (never values).
// Allowed differences (spec): freshly signed attachment URLs, and order among equal sort keys in queries without a tiebreaker.
// Allowed and listed (kind medplum-eq-day): extra store matches for date=eq<day> on timed values (eqDayExtras).
// Lives outside src/store: it imports GA (the MCP tools).
import type { MedplumClient } from '@medplum/core';
import { evalFhirPathTyped, getParsedExpressionForResourceType, getSearchParameters, toTypedValue } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { GaConfig } from './config.ts';
import { buildMcpServer } from './mcp.ts';
import { BINARY_URL } from './share/scope.ts';
import { GA_STORE_TYPES } from './store-serve.ts';
import { loadDefinitions } from './store/definitions.ts';

export type Diff = { path: string; kind: string };
export type Result = 'equal' | 'allowed' | 'unexplained';
export type ReplayRow = { category: 'tool' | 'search' | 'ga-search'; name: string; keys: string[]; result: Result; kinds: string[] };

// Transport fields that differ by backend and are compared in a normalized form (listed in the report).
export const NORMALIZED = ['Bundle id and meta', 'fullUrl base', 'paging links and nextPage tokens (presence only; one page 2 compared by ids)',
  'an absent list and an empty one', 'meta.compartment: Patient references only (Medplum adds its Project; compartments are checked record by record)'];
const ALLOWED = new Set(['signed-url']);
const ORDERISH = /^(order|missing:\d+|extra:\d+)$/;

const idOf = (x: any): string | undefined => {
  if (!x || typeof x !== 'object') return undefined;
  const r = x.resource ?? x;
  return r.id && r.resourceType ? `${r.resourceType}/${r.id}` : undefined;
};
// A Medplum-signed (or Binary/) URL on one side and Binary/<same id> on the store side.
const signedPair = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && /^Binary\/[0-9a-f-]{36}$/.test(b) && BINARY_URL.exec(a)?.[1] === b.slice(7);
const fhirPath = (u: unknown) => (typeof u === 'string' ? u.replace(/^.*?\/fhir\/R4\//, '') : u);

// The Patients of a meta.compartment as one comparable string (Medplum adds its Project there).
export const patientRefs = (compartment: unknown): string =>
  Array.isArray(compartment) ? compartment.map((c) => c?.reference).filter((r) => r?.startsWith('Patient/')).sort().join() : '';

// Differences between Medplum's answer (a) and the store's (b): paths and kinds, no values.
export function diff(a: unknown, b: unknown, path = '', out: Diff[] = []): Diff[] {
  if (out.length > 200) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const ida = a.map(idOf), idb = b.map(idOf);
    if (a.length && b.length && ida.every(Boolean) && idb.every(Boolean)) {
      const sa = new Set(ida), sb = new Set(idb);
      const missing = ida.filter((x) => !sb.has(x)).length, extra = idb.filter((x) => !sa.has(x)).length;
      if (missing) out.push({ path, kind: `missing:${missing}` });
      if (extra) out.push({ path, kind: `extra:${extra}` });
      if (!missing && !extra && ida.join() !== idb.join()) out.push({ path, kind: 'order' });
      const byId = new Map(b.map((x) => [idOf(x), x]));
      for (const x of a) if (byId.has(idOf(x))) diff(x, byId.get(idOf(x)), `${path}[]`, out);
      return out;
    }
    if (a.length !== b.length) { out.push({ path, kind: 'length' }); return out; }
    const sa = a.map((x) => JSON.stringify(x)), sb = b.map((x) => JSON.stringify(x));
    if (sa.join() !== sb.join() && sa.slice().sort().join() === sb.slice().sort().join()) { out.push({ path, kind: 'order' }); return out; }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const bundle = x.resourceType === 'Bundle' && y.resourceType === 'Bundle';
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (bundle && (k === 'id' || k === 'meta')) continue;
      if (k === 'link' && bundle) {
        const next = (v: unknown) => Array.isArray(v) && v.some((l) => l?.relation === 'next');
        if (next(x.link) !== next(y.link)) out.push({ path: `${path}.link`, kind: 'next-page' });
        continue;
      }
      if (k === 'nextPage') { if (!x[k] !== !y[k]) out.push({ path: `${path}.${k}`, kind: 'next-page' }); continue; }
      if (k === 'compartment' && path.endsWith('.meta')) {
        if (patientRefs(x[k]) !== patientRefs(y[k])) out.push({ path: `${path}.${k}`, kind: 'value' });
        continue;
      }
      if (k === 'fullUrl') { if (fhirPath(x[k]) !== fhirPath(y[k])) out.push({ path: `${path}.${k}`, kind: 'value' }); continue; }
      const empty = (v: unknown) => v === undefined || (Array.isArray(v) && !v.length);
      if (empty(x[k]) && empty(y[k])) continue;
      if (y[k] === undefined) out.push({ path: `${path}.${k}`, kind: 'missing-field' });
      else if (x[k] === undefined) out.push({ path: `${path}.${k}`, kind: 'extra-field' });
      else diff(x[k], y[k], `${path}.${k}`, out);
    }
    return out;
  }
  if (a !== b) out.push({ path, kind: signedPair(a, b) ? 'signed-url' : typeof a === typeof b ? 'value' : 'type' });
  return out;
}

// tieOk: whether order/missing/extra differences are explained as ties (the caller knows the query).
export function classify(d: Diff[], tieOk: () => boolean): Result {
  if (!d.length) return 'equal';
  const rest = d.filter((x) => !ALLOWED.has(x.kind));
  if (!rest.length) return 'allowed';
  return rest.every((x) => ORDERISH.test(x.kind)) && tieOk() ? 'allowed' : 'unexplained';
}

// The sort-key sequence of `resources` under `_sort` (each key: every value its expression yields): two answers with the same
// sequence differ only among equal keys. Coarser keys would hide differences; these can only be stricter. A date key is the
// instant both servers sort on (a Period's start; measured on the owner's record): one instant written in two offsets, or
// two Periods with one start, are ties.
function sortKeys(type: string, sort: string, resources: Resource[]): string[] {
  loadDefinitions(GA_STORE_TYPES);
  const codes = sort.split(',').map((c) => c.replace(/^-/, ''));
  return resources.map((r) => JSON.stringify(codes.map((code) => {
    if (code === '_id') return r.id;
    if (code === '_lastUpdated') return r.meta?.lastUpdated;
    const p = getSearchParameters(r.resourceType ?? type)?.[code];
    if (!p?.expression) return null;
    const vs = evalFhirPathTyped(getParsedExpressionForResourceType(r.resourceType ?? type, p.expression), [toTypedValue(r)]).map((v) => v.value);
    return p.type !== 'date' ? vs : vs.map((v) => { const t = Date.parse(typeof v === 'string' ? v : (v?.start ?? null)); return Number.isNaN(t) ? v : t; });
  })));
}

// Medplum answers date=eq<day> on a timed value only for the instant of midnight UTC (measured: midday did not match); the store
// matches the whole UTC day, as FHIR does. Allowed only when the query's one date is eq<day>, the store's answer only adds
// records, and every date value of each added record is a time, one of them inside that UTC day and not its midnight.
// A missing record or another order stays unexplained.
export function eqDayExtras(dates: string[], d: Diff[], a: unknown, b: unknown): boolean {
  const day = dates.length === 1 ? /^eq(\d{4}-\d\d-\d\d)$/.exec(dates[0])?.[1] : undefined;
  const rest = d.filter((x) => !ALLOWED.has(x.kind));
  if (!day || !rest.length || !rest.every((x) => /^extra:\d+$/.test(x.kind))) return false;
  const lo = Date.parse(`${day}T00:00:00Z`), hi = lo + 86400e3;
  const inA = new Set(matches(a).map(idOf));
  const extras = matches(b).filter((r) => !inA.has(idOf(r)));
  if (!extras.length) return false;
  loadDefinitions(GA_STORE_TYPES);
  return extras.every((r) => {
    const expr = getSearchParameters(r.resourceType)?.date?.expression;
    if (!expr) return false;
    const vs = evalFhirPathTyped(getParsedExpressionForResourceType(r.resourceType, expr), [toTypedValue(r)]).map((v) => v.value);
    return vs.length > 0 && vs.every((v) => typeof v === 'string' && /T\d\d:\d\d/.test(v)) && vs.some((v) => { const t = Date.parse(v); return t > lo && t < hi; });
  });
}
// An unexplained row that eqDayExtras explains becomes allowed, listed by its kind.
function eqDay(row: ReplayRow, dates: string[], d: Diff[], a: unknown, b: unknown): void {
  if (row.result === 'unexplained' && eqDayExtras(dates, d, a, b)) { row.result = 'allowed'; row.kinds.push('medplum-eq-day'); }
}

const matches = (b: any): Resource[] => (b?.entry ?? []).filter((e: any) => e.search?.mode !== 'include').map((e: any) => e.resource).filter(Boolean);
const included = (b: any): string[] => (b?.entry ?? []).filter((e: any) => e.search?.mode === 'include').map((e: any) => idOf(e)).sort();
const hasNext = (b: any): boolean => !!b?.nextPage || !!b?.link?.some((l: any) => l?.relation === 'next');
// A search answer pair differs only among ties. Included records: the same set. The same matches in another order: their
// sort keys (if sorted) are the same sequence. Different matches only on a full page (count reached, or a next page), and
// only among records whose key equals the page's last key (the cut); unsorted, every record ties.
export function tie(type: string, sort: string | undefined, count: number, a: any, b: any): boolean {
  if (included(a).join() !== included(b).join()) return false;
  const ma = matches(a), mb = matches(b);
  if (ma.length !== mb.length) return false;
  const sameSet = ma.map(idOf).sort().join() === mb.map(idOf).sort().join();
  if (!sameSet && !((ma.length >= count || hasNext(a)) && (mb.length >= count || hasNext(b)))) return false;
  if (!sort) return true;
  const ka = sortKeys(type, sort, ma), kb = sortKeys(type, sort, mb);
  if (ka.join('\n') !== kb.join('\n')) return false;
  if (sameSet) return true;
  const last = ka.at(-1);
  const inside = (rs: Resource[], ks: string[]) => rs.filter((_, i) => ks[i] !== last).map(idOf).sort().join();
  return inside(ma, ka) === inside(mb, kb);
}

// What the searches a tool sent say about its differences: allowed as ties only if it sent searches, at least one tied
// (allowed with an order kind), none differed unexplained, and nothing it read was left out of the replay (later pages,
// reads, history, POST searches).
export type PhaseInfo = { searches: number; orderAllowed: boolean; unexplained: boolean; skipped: boolean };
export const toolTieOk = (p?: PhaseInfo): boolean => !!p && p.searches > 0 && p.orderAllowed && !p.unexplained && !p.skipped;

// Every request either side gets: writes never reach a backend (answered with an echo), Medplum searches are recorded per tool.
export type GuardState = { phase: string; blocked: number; sent: { phase: string; method: string; path: string; query: string }[] };
export const guardState = (): GuardState => ({ phase: '', blocked: 0, sent: [] });
// record: only the Medplum side records its searches.
export function guard(inner: typeof fetch, state: GuardState, record = false): typeof fetch {
  return async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (req.method !== 'GET' && !u.pathname.includes('oauth2/token') && !u.pathname.endsWith('/_search')) {
      state.blocked++;
      const body = req.method === 'DELETE' ? '' : await req.text();
      return new Response(body || '{}', { status: 200, headers: { 'content-type': 'application/fhir+json' } });
    }
    if (record && state.phase.startsWith('tool:') && !u.pathname.includes('oauth2/')) state.sent.push({ phase: state.phase, method: req.method, path: u.pathname.replace(/^.*?\/fhir\/R4\//, ''), query: u.search });
    return inner(req);
  };
}

const WRITE_TOOLS = new Set(['ga_import', 'postpone', 'record_followup', 'map_concept']);

// medplum and store: clients whose fetch is guard(...) on `state` (medplum with record = true).
export async function replay(medplum: MedplumClient, store: MedplumClient, cfg: GaConfig, state: GuardState, log: (s: string) => void = () => undefined): Promise<ReplayRow[]> {
  const pid = cfg.patientId;
  const noNet: typeof fetch = async () => new Response('{}', { status: 503 }); // FDA labels, code checks: nothing leaves the machine
  const connect = async (client: MedplumClient) => {
    const [x, y] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'migrate-store', version: '0' });
    await Promise.all([buildMcpServer({ client, cfg, patientId: pid, fetch: noNet }).connect(x), c.connect(y)]);
    return c;
  };
  const M = await connect(medplum), S = await connect(store);
  const call = async (c: Client, name: string, args: object) => {
    const r = (await c.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: { text: string }[] };
    let v: unknown = r.content?.[0]?.text;
    try { v = JSON.parse(v as string); } catch { /* text */ }
    return { isError: !!r.isError, v };
  };
  const rows: ReplayRow[] = [];
  const push = (row: ReplayRow, d: Diff[]) => {
    rows.push(row);
    if (row.result === 'unexplained') log(`replay: ${row.category} ${row.name} [${row.keys.join(',')}] differs: ${d.filter((x) => !ALLOWED.has(x.kind)).slice(0, 8).map((x) => `${x.path || '.'} ${x.kind}`).join('; ')}`);
  };
  const compare = (m: { isError: boolean; v: unknown }, s: { isError: boolean; v: unknown }): Diff[] =>
    m.isError || s.isError ? (m.isError && s.isError && m.v === s.v ? [] : [{ path: '', kind: m.isError && s.isError ? 'different-error' : m.isError ? 'medplum-error' : 'store-error' }]) : diff(m.v, s.v);

  // 1. GA's read tools (every registered one but the writers); the searches each sends to Medplum are recorded for step 3.
  const setPhase = (p: string) => { state.phase = p; };
  const asOf = new Date().toISOString().slice(0, 10);
  const ARGS: Record<string, object[]> = {
    lab_results: [{}, { name: 'a1c' }, { name: ['ldl', 'hdl', 'triglycerides'] }, { summary: true }, { name: 'glucose', since: '2020-01-01', until: '2024-12-31' }, { name: 'creatinine', summary: true }],
    vitals: [{}, { name: 'weight' }, { name: 'blood pressure' }, { daily: true }, { daily: true, name: 'steps', since: '2025-01-01' }],
    current_medications: [{}, { include: 'all' }], current_problems: [{}, { include: 'all' }],
    notes_search: [{}, { text: 'follow' }, { text: 'blood', since: '2024-01-01' }],
    whats_new: [{}, { since: '2026-01-01' }],
    health_maintenance: [{ asOf }, { asOf, months: 12 }], vaccine_gaps: [{ asOf }],
    concepts_to_review: [{}, { status: 'suggested' }, { status: 'agent' }],
  };
  const toolRows: { row: ReplayRow; d: Diff[]; phase: string }[] = [];
  const tools = (await S.listTools()).tools.map((t) => t.name).filter((n) => !WRITE_TOOLS.has(n) && n !== 'fhir_search' && n !== 'fhir_read');
  for (const name of tools) {
    for (const args of ARGS[name] ?? [{}]) {
      const phase = `tool:${name}:${toolRows.length}`;
      setPhase(phase);
      const m = await call(M, name, args);
      setPhase('');
      const s = await call(S, name, args);
      toolRows.push({ row: { category: 'tool', name, keys: Object.keys(args), result: 'equal', kinds: [] }, d: compare(m, s), phase });
    }
  }
  const ids = matches(await medplum.search('Observation', { _count: '3', _sort: '-date' }, { cache: 'no-cache' })).map((r) => r.id!);
  const docs = matches(await medplum.search('DocumentReference', { _count: '2', _sort: '_lastUpdated' }, { cache: 'no-cache' })).map((r) => r.id!);
  const reads: object[] = [{ resourceType: 'Patient', id: pid }, ...(ids[0] ? [{ resourceType: 'Observation', id: ids[0] }] : []),
    { resourceType: 'Observation', ids: [...ids, 'does-not-exist'] }, ...(docs.length ? [{ resourceType: 'DocumentReference', ids: docs }] : [])];
  for (const args of reads) {
    const m = await call(M, 'fhir_read', args), s = await call(S, 'fhir_read', args);
    toolRows.push({ row: { category: 'tool', name: 'fhir_read', keys: Object.keys(args), result: 'equal', kinds: [] }, d: compare(m, s), phase: '' });
  }

  // 2. Agent-style fhir_search through the tool.
  const P = `Patient/${pid}`;
  const agent: [string, Record<string, string | string[]>][] = [
    ['Observation', { code: 'http://loinc.org|4548-4', _sort: '-date' }],
    ['Observation', { code: '4548-4,17856-6', _sort: '-date', _count: '5' }],
    ['Observation', { category: 'laboratory', _sort: '-date', _count: '50' }],
    ['Observation', { category: 'vital-signs', date: ['ge2024-01-01', 'lt2025-01-01'], _sort: '-date', _count: '100' }],
    ['Observation', { code: 'http://loinc.org|29463-7', _sort: 'date', _elements: 'valueQuantity,effectiveDateTime' }],
    ['Observation', { 'code:text': 'cholesterol', _sort: '-date', _count: '20' }],
    ['Observation', { subject: P, date: 'ge2023-06-01', _count: '1000', _sort: '-date' }],
    ['Observation', { category: 'laboratory', _summary: 'count' }],
    ['Observation', { category: 'laboratory', _total: 'accurate', _count: '1', _sort: '-date' }],
    ['Observation', { 'category:missing': 'true', _count: '50', _sort: '-_lastUpdated' }],
    ['Observation', { 'category:not': 'vital-signs', date: 'ge2025-01-01', _sort: '-date', _count: '50' }],
    ['Observation', { code: 'http://loinc.org|2345-7', 'value-quantity': 'gt100', _sort: '-date' }],
    ['Observation', { _tag: 'urn:ga-server:tag|extracted-by-llm', _sort: '-date' }],
    // store parity points: token case, date eq on a time or period, partial dates
    ['Observation', { status: 'FINAL', _sort: '-date,_id' }],
    ['Observation', { category: 'LABORATORY', _sort: '-date,_id' }],
    ['Observation', { date: 'eq2024-03-01', _sort: '-date,_id' }],
    ['Observation', { date: 'eq2024', _sort: '-date,_id', _count: '200' }],
    ['Observation', { date: 'ge2023-06', _sort: '-date,_id', _count: '200' }],
    ['Observation', { date: ['ge2024-03', 'lt2024-04'], _sort: '-date,_id' }],
    ['Observation', { _lastUpdated: 'ge2024-02', _sort: '-date,_id' }],
    ['Condition', { 'clinical-status': 'active', _sort: '-recorded-date' }],
    ['Condition', { category: 'problem-list-item' }],
    ['Condition', { category: 'encounter-diagnosis', _sort: '-_lastUpdated', _count: '10' }],
    ['MedicationRequest', { status: 'active', _include: 'MedicationRequest:medication' }],
    ['MedicationStatement', { status: 'active,completed' }],
    ['Immunization', { date: 'ge2020-01-01', _sort: '-date' }],
    ['Immunization', { patient: P, _sort: 'date' }],
    ['DocumentReference', { date: 'ge2024-01-01', _sort: '-date', _count: '20' }],
    ['DocumentReference', { 'type:text': 'note', _sort: '-date' }],
    ['DocumentReference', { identifier: 'urn:ga-server:id:file|' }],
    ['Encounter', { date: ['ge2023-01-01', 'le2025-12-31'], _sort: '-date' }],
    ['Procedure', { date: 'ge2015-01-01', _sort: '-date' }],
    ['Procedure', { 'code:text': 'colonoscopy' }],
    ['DiagnosticReport', { category: 'LAB', _sort: '-date', _count: '20' }],
    ['DiagnosticReport', { 'code:text': 'x-ray' }],
    ['AllergyIntolerance', { patient: P }],
    ['FamilyMemberHistory', {}],
    ['Communication', { sent: 'ge2024-01-01', _sort: '-sent' }],
    ['Endpoint', { identifier: 'urn:ga-server:id:smart-source|' }],
    ['Provenance', { _count: '50', _sort: '-_lastUpdated' }],
    ['AuditEvent', { _count: '50', _sort: '-_lastUpdated' }],
    ['Basic', { _count: '50', _sort: '-_lastUpdated' }],
    ['ConceptMap', { _count: '50', _sort: '-_lastUpdated' }],
    ['QuestionnaireResponse', { _sort: '-authored', _count: '5' }],
    ['Observation', { 'subject:Patient.gender': 'male', _count: '5', _sort: '-date' }],
    ['Observation', { 'patient.birthdate': 'lt2100-01-01', _count: '5', _sort: '-date' }],
    ['Encounter', { _revinclude: 'Condition:encounter', _count: '5', _sort: '-date' }],
    ['Patient', { _id: pid, _revinclude: 'AllergyIntolerance:patient' }],
    ['Patient', { '_has:Observation:subject:code': '4548-4' }],
    ['DiagnosticReport', { _include: 'DiagnosticReport:result', _count: '3', _sort: '-date' }],
    ['Observation', { _filter: 'category eq laboratory or _tag eq urn:ga-server:tag|extracted-by-llm', _count: '50', _sort: '-date' }],
    ['Organization', { 'name:contains': 'a' }],
    // negative probes: a single-patient store returns everything if a chain or _has were ignored
    ['Observation', { 'subject:Patient.gender': 'other', _count: '5', _sort: '-date' }],
    ['Observation', { 'patient.birthdate': 'lt1800-01-01', _count: '5', _sort: '-date' }],
    ['Patient', { '_has:Observation:subject:code': 'no-such-code-xyz' }],
    ['Observation', { 'value-quantity': 'lt0', _count: '20' }],
    ['Observation', { _count: '100', _sort: '-date,_id' }], // then page 2 via nextPage
  ];
  for (const [type, params] of agent) {
    const args = { resourceType: type, params };
    const m = await call(M, 'fhir_search', args), s = await call(S, 'fhir_search', args);
    const d = compare(m, s);
    const sort = params._sort as string | undefined;
    const row: ReplayRow = { category: 'search', name: type, keys: Object.keys(params), result: classify(d, () => tie(type, sort, Number(params._count) || 20, m.v, s.v)), kinds: [...new Set(d.map((x) => x.kind))] };
    if (params.date) eqDay(row, [params.date].flat(), d, m.v, s.v);
    push(row, d);
    const nm = (m.v as any)?.nextPage, ns = (s.v as any)?.nextPage;
    if (nm && ns && params._count === '100') {
      const m2 = await call(M, 'fhir_search', { resourceType: type, page: nm }), s2 = await call(S, 'fhir_search', { resourceType: type, page: ns });
      const d2 = compare(m2, s2);
      push({ category: 'search', name: type, keys: ['page'], result: classify(d2, () => tie(type, sort, Number(params._count) || 20, m2.v, s2.v)), kinds: [...new Set(d2.map((x) => x.kind))] }, d2);
    }
  }

  // 3. Every distinct first-page search the tools sent, raw on both; a tool's order differences are explained when its searches tie.
  const phases = new Map<string, PhaseInfo>();
  const seen = new Map<string, ReplayRow>();
  for (const { phase, method, path, query } of state.sent) {
    const p = phases.get(phase) ?? { searches: 0, orderAllowed: false, unexplained: false, skipped: false };
    phases.set(phase, p);
    const q = new URLSearchParams(query);
    // Reads, history, POST searches and later pages are not replayed here: a tool that used them gets no tie explanation.
    if (method !== 'GET' || !/^[A-Z][A-Za-z]+$/.test(path) || q.has('_cursor') || Number(q.get('_offset') ?? 0) > 0) { p.skipped = true; continue; }
    const type = path, key = `${type}${query}`;
    let row = seen.get(key);
    if (!row) {
      let a: Bundle | undefined, b: Bundle | undefined, ea = false, eb = false;
      try { a = await medplum.search(type as 'Observation', q, { cache: 'no-cache' }); } catch { ea = true; }
      try { b = await store.search(type as 'Observation', q, { cache: 'no-cache' }); } catch { eb = true; }
      const d: Diff[] = ea || eb ? (ea && eb ? [] : [{ path: '', kind: ea ? 'medplum-error' : 'store-error' }]) : diff(a, b);
      row = { category: 'ga-search', name: type, keys: [...new Set(q.keys())], kinds: [...new Set(d.map((x) => x.kind))],
        result: classify(d, () => tie(type, q.get('_sort') ?? undefined, Number(q.get('_count')) || 20, a, b)) };
      if (q.has('date')) eqDay(row, q.getAll('date'), d, a, b);
      seen.set(key, row);
      push(row, d);
    }
    p.searches++;
    if (row.result === 'unexplained') p.unexplained = true;
    if (row.result === 'allowed' && row.kinds.some((k) => ORDERISH.test(k))) p.orderAllowed = true;
  }
  for (const { row, d, phase } of toolRows) {
    row.result = classify(d, () => toolTieOk(phases.get(phase)));
    row.kinds = [...new Set(d.map((x) => x.kind))];
    push(row, d);
  }
  await M.close();
  await S.close();
  return rows;
}
