// FHIR search for the SQLite store. Each resource is indexed by evaluating its type's official SearchParameters (FHIRPath,
// as Medplum's server indexes them) into rows; a search is SQL over those rows.
//
// Tables (created by SEARCH_SCHEMA):
// - idx: one row per indexed value. token: sys/val (val lowercased); string: val = lowercased (starts-with/contains),
//   sys = as written (:exact); uri, reference: val; date: lo/hi = UTC ISO range; number: lo/hi; quantity: lo = hi = value,
//   sys = system, val = code or unit. CodeableConcept.text / Coding.display are token rows with sys = TEXT, val lowercased.
// - idx_text: the distinct lowercased TEXT values per (type, code), so :text (substring) scans distinct strings, not every row.
// - sortkeys: one row per resource for _id, _lastUpdated and each date param of its type (MISSING when it has none):
//   lo = ascending key (earliest start), hi = descending key (latest start). Indexed by (type, code, key), so a sort is an
//   index walk or a primary-key join, never an aggregate per row.
//
// Plan: each filter is an `exists` probe on a candidate rid; a positive filter can also produce its rid set. The search either
// drives from the smallest set (counted up to searchTuning.driveMax) or, when every set is large and the first sort key is in sortkeys,
// walks that sort index and stops after the page. The page's JSON is read last, by rid.
import {
  FhirFilterComparison, FhirFilterConnective, FhirFilterNegation, OperationOutcomeError, Operator, convertToSearchableDates,
  convertToSearchableNumbers, convertToSearchableQuantities, convertToSearchableReferences, convertToSearchableStrings,
  convertToSearchableTokens, convertToSearchableUris, evalFhirPathTyped, getParsedExpressionForResourceType, getSearchParameterDetails, getSearchParameters,
  parseFilterParameter, parseSearchRequest, SearchParameterType, splitSearchOnComma, subsetResource, toTypedValue, tryGetDataType,
  type Filter, type FhirFilterExpression, type SearchRequest,
} from '@medplum/core';
import type { Bundle, Resource, SearchParameter } from '@medplum/fhirtypes';
import type { StatementSync } from 'node:sqlite';

export const SEARCH_SCHEMA = `
  create table if not exists idx(rid integer not null, type text not null, code text not null, sys text, val, lo, hi);
  create index if not exists idx_v on idx(type, code, val, sys, rid) where val is not null;
  create index if not exists idx_l on idx(type, code, lo, hi, rid) where lo is not null;
  create index if not exists idx_r on idx(rid, code, val, sys, lo, hi);
  create table if not exists idx_text(type text not null, code text not null, val text not null, primary key(type, code, val)) without rowid;
  create table if not exists sortkeys(rid integer not null, type text not null, code text not null, lo not null, hi not null, primary key(rid, code)) without rowid;
  create index if not exists sortkeys_lo on sortkeys(type, code, lo);
  create index if not exists sortkeys_hi on sortkeys(type, code, hi);`;

const TEXT = '\u0001text';
// A string row of one word of a HumanName or Address (name=smi finds "Alice Smith"); :exact and _sort use the whole value.
const WORD = '\u0001word';
// Sorts after every number and text value: a missing sort value comes last ascending and first descending (Postgres NULLs, as Medplum).
const MISSING = new Uint8Array([0xff]);
const MAX_COUNT = 1000;
// Plan thresholds (tests lower them to run every plan on small data). driveMax: a filter matching fewer rows drives the
// search; otherwise a sorted search walks its sort index. walkPerRow: a page of n rows from a smaller set first walks up to
// walkPerRow * n rows of its sort index (cheap when matches are dense).
export const searchTuning = { driveMax: 5000, walkPerRow: 50 };

type Prep = (sql: string) => StatementSync;
type Arg = string | number | null | Uint8Array;
type Row = [code: string, sys: string | null, val: string | null, lo: string | number | null, hi: string | number | null];

// A 400 the store rethrows as its StoreError (search.ts must not import store.ts).
export class SearchError extends OperationOutcomeError {
  readonly text: string;
  constructor(text: string) {
    super({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text } }] });
    this.text = text;
  }
}
const badRequest = (text: string): Error => new SearchError(text);

const utc = (s?: string): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};
// The UTC range of a date with year, month or day precision (convertToSearchableDates ends every month after 31 days).
function dayRange(v: unknown): { start: string; end: string } | undefined {
  const m = typeof v === 'string' ? /^(\d{4})(?:-(\d\d)(?:-(\d\d))?)?$/.exec(v) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) - 1 : undefined, m[3] ? Number(m[3]) : undefined];
  const start = Date.UTC(y, mo ?? 0, d ?? 1);
  const end = d !== undefined ? Date.UTC(y, mo!, d + 1) : mo !== undefined ? Date.UTC(y, mo + 1, 1) : Date.UTC(y + 1, 0, 1);
  return { start: new Date(start).toISOString(), end: new Date(end - 1).toISOString() };
}
const lower = (s: string | undefined | null): string | null => (s == null ? null : s.toLowerCase());
// Medplum indexes and matches ContactPoint tokens (email, phone, telecom) case-insensitively; other tokens as written.
const caseless = (type: string, p: SearchParameter): boolean =>
  p.type === 'token' && !!getSearchParameterDetails(type, p).elementDefinitions?.some((e) => e.type?.some((t) => t.code === 'ContactPoint'));
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const qs = (n: number): string => Array(n).fill('?').join(', ');

// ---------- indexing ----------

function rows(r: Resource): Row[] {
  const out: Row[] = [];
  const tv = [toTypedValue(r)];
  for (const p of Object.values(getSearchParameters(r.resourceType) ?? {})) {
    // _id and _lastUpdated live in sortkeys.
    if (!p.expression || p.type === 'composite' || p.type === 'special' || p.code === '_id' || p.code === '_lastUpdated') continue;
    let v;
    try { v = evalFhirPathTyped(getParsedExpressionForResourceType(r.resourceType, p.expression), tv); } catch { continue; }
    if (!v.length) continue;
    const code = p.code;
    switch (p.type) {
      case 'token': {
        // Codes as written (Medplum matches tokens case-sensitively, ContactPoints aside); texts lowercased for :text.
        const lc = caseless(r.resourceType, p);
        // Values trimmed, as Medplum indexes them (' 123' is found by 123).
        for (const t of convertToSearchableTokens(v, { textSearchSystem: TEXT })) out.push([code, t.system ?? null, t.system === TEXT || lc ? lower(t.value?.trim()) : t.value?.trim() ?? null, null, null]);
        break;
      }
      case 'string':
        for (const x of v) {
          for (const s of convertToSearchableStrings([x])) {
            out.push([code, s, s.toLowerCase(), null, null]);
            // Any word of a name or address, as Medplum's word-prefix search of them; a name also by the parts of a word
            // (Zed-Smith, O'Brien), as Medplum's (Postgres) word split; an address only by whole words, as Medplum.
            if (x.type !== 'HumanName' && x.type !== 'Address') continue;
            const words = s.toLowerCase().split(/\s+/);
            const parts = x.type === 'HumanName' ? words.flatMap((w) => w.split(/[^\p{L}\p{N}]+/u)) : [];
            for (const w of [...words.slice(1), ...parts]) if (w) out.push([code, WORD, w, null, null]);
          }
        }
        break;
      case 'uri': for (const s of convertToSearchableUris(v)) out.push([code, null, s, null, null]); break;
      case 'reference': for (const s of convertToSearchableReferences(v)) out.push([code, null, s, null, null]); break;
      // Medplum's server treats a Period with no end as ending at its start (its in-memory matcher treats it as open-ended).
      case 'date':
        for (const x of v) {
          const day = dayRange(x.value);
          for (const d of day ? [day] : convertToSearchableDates([x])) out.push([code, null, null, utc(d.start) ?? '0000', utc(d.end) ?? utc(d.start) ?? '9999']);
        }
        break;
      case 'number': for (const [a, b] of convertToSearchableNumbers(v)) if (a != null || b != null) out.push([code, null, null, a ?? b!, b ?? a!]); break;
      case 'quantity':
        for (const q of convertToSearchableQuantities(v)) if (q.value != null) out.push([code, q.system ?? null, q.code ?? q.unit ?? null, q.value, q.value]);
        break;
    }
  }
  const seen = new Set<string>();
  return out.filter((x) => { const k = JSON.stringify(x); return !seen.has(k) && !!seen.add(k); });
}

// Replaces the search rows of `rid` (r undefined: deleted). Runs inside the write's transaction.
export function writeIndex(prep: Prep, rid: number, r: Resource | undefined): void {
  prep('delete from idx where rid = ?').run(rid);
  prep('delete from sortkeys where rid = ?').run(rid);
  if (!r) return;
  const type = r.resourceType;
  const ins = prep('insert into idx values (?, ?, ?, ?, ?, ?, ?)');
  const text = prep('insert or ignore into idx_text values (?, ?, ?)');
  const dates = new Map<string, [string, string]>();
  for (const [code, sys, val, lo, hi] of rows(r)) {
    ins.run(rid, type, code, sys, val, lo, hi);
    // shortcut: idx_text keeps texts of deleted or changed resources (they then match no idx row); prune if it grows large.
    if (sys === TEXT && val) text.run(type, code, val);
    if (typeof lo === 'string' && val === null) {
      const at = lo === '0000' ? hi as string : lo; // a Period with an end only sorts by its end, as Medplum
      const k = dates.get(code);
      dates.set(code, k ? [k[0] < at ? k[0] : at, k[1] > at ? k[1] : at] : [at, at]);
    }
  }
  const sk = prep('insert into sortkeys values (?, ?, ?, ?, ?)');
  sk.run(rid, type, '_id', r.id!, r.id!);
  const lu = utc(r.meta?.lastUpdated) ?? MISSING; // as range searches compare it (put keeps a migrated value as given)
  sk.run(rid, type, '_lastUpdated', lu, lu);
  for (const p of Object.values(getSearchParameters(type) ?? {})) {
    if (p.type !== 'date' || p.code === '_lastUpdated') continue;
    const k = dates.get(p.code);
    sk.run(rid, type, p.code, k?.[0] ?? MISSING, k?.[1] ?? MISSING);
  }
}

// ---------- filters ----------

const param = (type: string, code: string): SearchParameter | undefined => getSearchParameters(type)?.[code];

// A filter as SQL over a candidate row `a` (any row with a `rid` column): `sql` probes one rid; `set`, when the filter is a
// positive match on one parameter, selects every matching rid (a candidate driver).
type Cond = { sql: string; args: Arg[]; set?: { sql: string; args: Arg[] }; ref?: boolean; multi?: boolean };

// Every rid of `type`, as a row source with a `rid` column.
const allOf = (a: string): string => `sortkeys ${a} where ${a}.type = ? and ${a}.code = '_id'`;
let aliasN = 0;
const alias = (): string => `t${aliasN++}`;

function cond(type: string, f: Filter, a: string): Cond {
  if (f.code === '_filter') {
    let e: FhirFilterExpression;
    try { e = parseFilterParameter(f.value); } catch (err) { throw badRequest(`Invalid _filter: ${err instanceof Error ? err.message : String(err)}`); }
    return filterExpr(type, e, a);
  }
  if (f.code.startsWith('_has:') || f.code.includes('.')) return chainCond(type, f, a);
  const [code, mod] = f.code.split(':');
  if (mod) throw badRequest(`Unsupported search modifier: ${f.code}`);
  const p = param(type, code);
  if (!p) throw badRequest(`Unknown search parameter: ${code}`);
  if (p.type === 'composite' || p.type === 'special') throw badRequest(`Unsupported search parameter type ${p.type}: ${code}`);
  const op = f.operator;
  if (op === Operator.MISSING || op === Operator.PRESENT) {
    const present = (op === Operator.MISSING) === (f.value === 'false');
    if (code === '_id' || code === '_lastUpdated') return { sql: present ? '1' : '0', args: [] };
    return { sql: `${present ? '' : 'not '}exists (select 1 from idx i where i.rid = ${a}.rid and i.code = ?)`, args: [code] };
  }
  const allowed: Record<string, readonly string[]> = {
    token: [Operator.EQUALS, Operator.NOT, Operator.NOT_EQUALS, Operator.TEXT],
    string: [Operator.EQUALS, Operator.EXACT, Operator.CONTAINS, Operator.NOT, Operator.NOT_EQUALS],
    uri: [Operator.EQUALS, Operator.NOT, Operator.NOT_EQUALS],
    reference: [Operator.EQUALS, Operator.NOT, Operator.NOT_EQUALS],
    date: ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'],
    number: ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'ap'],
    quantity: ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'ap'],
  };
  if (!allowed[p.type]?.includes(op)) throw badRequest(`Unsupported search modifier or prefix :${op} on ${code} (${p.type})`);
  const vals = splitSearchOnComma(f.value);
  // :not on tokens, strings, uris and references means "no matching value" (FHIR); ne on ranges is a prefix.
  const neg = op === Operator.NOT || (op === Operator.NOT_EQUALS && p.type !== 'date' && p.type !== 'number' && p.type !== 'quantity');

  if (code === '_id') {
    const set = { sql: `select x.rid from resources x where x.type = ? and x.id in (${qs(vals.length)})`, args: [type, ...vals] };
    return { sql: `${neg ? 'not ' : ''}${a}.rid in (${set.sql})`, args: set.args, set: neg ? undefined : set };
  }
  const ors: string[] = [], va: Arg[] = [];
  const range = (v: string, lo: string, hi: string) => { const [c, ca] = dateCond(op, v, lo, hi); ors.push(c); va.push(...ca); };
  if (code === '_lastUpdated') {
    for (const v of vals) range(v, 's.lo', 's.hi');
    const where = `s.code = '_lastUpdated' and (${ors.join(' or ')})`;
    return {
      sql: `exists (select 1 from sortkeys s where s.rid = ${a}.rid and ${where})`, args: va,
      set: { sql: `select s.rid from sortkeys s where s.type = ? and ${where}`, args: [type, ...va] },
    };
  }
  for (const v of vals) {
    switch (p.type) {
      case 'token': {
        if (op === Operator.TEXT) {
          // Substring of the distinct texts of this (type, code), then their rows by index.
          ors.push(`i.sys = ? and i.val in (select x.val from idx_text x where x.type = ? and x.code = ? and x.val like ? escape '\\')`);
          va.push(TEXT, type, code, `%${likeEscape(v.toLowerCase())}%`);
          break;
        }
        const bar = v.indexOf('|');
        const ci = (x: string) => (caseless(type, p) ? x.toLowerCase() : x);
        if (bar < 0) { ors.push('i.val = ? and (i.sys is null or i.sys <> ?)'); va.push(ci(v), TEXT); break; }
        const s = v.slice(0, bar), val = ci(v.slice(bar + 1));
        if (!s) { ors.push('i.val = ? and i.sys is null'); va.push(val); }
        else if (!val) { ors.push('i.sys = ?'); va.push(s); }
        else { ors.push('i.val = ? and i.sys = ?'); va.push(val, s); }
        break;
      }
      case 'string': {
        const l = v.toLowerCase();
        if (op === Operator.EXACT) { ors.push('i.val = ? and i.sys = ?'); va.push(l, v); }
        else if (op === Operator.CONTAINS) { ors.push(`i.val like ? escape '\\'`); va.push(`%${likeEscape(l)}%`); }
        else { ors.push('i.val >= ? and i.val < ?'); va.push(l, `${l}￿`); } // starts-with as an index range
        break;
      }
      case 'uri': ors.push('i.val = ?'); va.push(v); break;
      case 'reference':
        if (v.includes('/')) { ors.push('i.val = ?'); va.push(v); }
        else if ((p.target?.length ?? 0) === 1) { ors.push('i.val = ?'); va.push(`${p.target![0]}/${v}`); }
        else { ors.push(`i.val like ? escape '\\'`); va.push(`%/${likeEscape(v)}`); }
        break;
      case 'date': range(v, 'i.lo', 'i.hi'); break;
      case 'number': case 'quantity': {
        const [num, sys, unit] = v.split('|');
        const n = Number(num);
        if (num === '' || Number.isNaN(n)) throw badRequest(`Invalid number: ${v}`);
        const cmp: Record<string, string> = { eq: 'i.lo = ?', ne: 'i.lo <> ?', gt: 'i.lo > ?', lt: 'i.lo < ?', ge: 'i.lo >= ?', le: 'i.lo <= ?', ap: 'i.lo between ? * 0.9 and ? * 1.1' };
        let c = cmp[op];
        va.push(n);
        if (op === 'ap') va.push(n);
        if (sys) { c += ' and i.sys = ?'; va.push(sys); }
        if (unit) { c += ' and i.val = ?'; va.push(unit); }
        ors.push(c);
        break;
      }
    }
  }
  const where = `i.code = ? and (${ors.map((o) => `(${o})`).join(' or ')})`;
  const probe = `exists (select 1 from idx i where i.rid = ${a}.rid and ${where})`;
  if (neg) return { sql: `not ${probe}`, args: [code, ...va] };
  return { sql: probe, args: [code, ...va], set: { sql: `select i.rid from idx i where i.type = ? and ${where}`, args: [type, code, ...va] },
    ref: p.type === 'reference', multi: vals.length > 1 || op === Operator.TEXT };
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// Medplum's date search values: an R4 date or dateTime with year, month and day, seconds optional, ' ' for 'T', offsets to ±14:00.
const DATE_VALUE = /^(\d(\d(\d[1-9]|[1-9]0)|[1-9]00)|[1-9]000)-(0[1-9]|1[0-2])-(0[1-9]|[1-2]\d|3[0-1])([T ]([01]\d|2[0-3])(:[0-5]\d(:([0-5]\d|60))?(\.\d{1,9})?)?)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)?)?$/;

// Date prefixes over a [lo, hi] range (a Period with no end is a point at its start): eq means the search day contains the
// value (FHIR; Medplum), ap that they overlap. A search value is a full date or a dateTime: Medplum refuses 2024 and 2024-05.
function dateCond(op: string, v: string, lo: string, hi: string): [string, string[]] {
  if (!DATE_VALUE.test(v)) throw badRequest(`Invalid date value: ${v}`);
  const t = v.replace(' ', 'T').replace(/T(\d\d:\d\d)(?!:)/, 'T$1:00'); // seconds, which convertToSearchableDates needs
  const fp = /^\d{4}-\d\d-\d\d$/.test(t) ? dayRange(t) : t.includes('T') ? convertToSearchableDates([{ type: 'dateTime', value: t }])[0] : undefined;
  const s = utc(fp?.start), e = utc(fp?.end ?? fp?.start);
  if (!s || !e || Number.isNaN(Date.parse(s))) throw badRequest(`Invalid date value: ${v}`); // Medplum's text
  const sql: Record<string, [string, string[]]> = {
    eq: [`${lo} >= ? and ${hi} <= ?`, [s, e]], ap: [`${lo} <= ? and ${hi} >= ?`, [e, s]], ne: [`not (${lo} >= ? and ${hi} <= ?)`, [s, e]],
    lt: [`${lo} < ?`, [s]], gt: [`${hi} > ?`, [e]], le: [`${lo} <= ?`, [e]], ge: [`${hi} >= ?`, [s]], sa: [`${lo} > ?`, [e]], eb: [`${hi} < ?`, [s]],
  };
  const [c, ca] = sql[op] ?? sql.eq;
  return [`(${c})`, ca];
}

// Rids of `type` matching a filter, as a subquery.
function matching(type: string, f: Filter): { sql: string; args: Arg[] } {
  const t = alias();
  const c = cond(type, f, t);
  return c.set ?? { sql: `select ${t}.rid from ${allOf(t)} and ${c.sql}`, args: [type, ...c.args] };
}

// Medplum's longest chain (buildChainedSearch in packages/server/src/fhir/search.ts, 5.2.14); a _has counts as a link.
const MAX_CHAIN_LINKS = 3;
type Link = { from: string; to: string; code: string; reverse: boolean; canonical: boolean };

// A chain's parts as Medplum's splitChainedSearch: each `_has:Type:ref`, else what lies between dots; the last is the parameter.
function splitChain(chain: string): string[] {
  const parts: string[] = [];
  while (chain) {
    if (chain.startsWith('_has:')) {
      const t = chain.indexOf(':', 5), c = chain.indexOf(':', t + 1);
      if (t < 0 || t >= c) throw badRequest(`Invalid search chain: ${chain}`);
      parts.push(chain.slice(0, c));
      chain = chain.slice(c + 1);
    } else {
      const dot = chain.indexOf('.') < 0 ? chain.length : chain.indexOf('.');
      parts.push(chain.slice(0, dot));
      chain = chain.slice(dot + 1);
    }
  }
  return parts;
}

// A chain (ref[:Type].…) or reverse chain (_has:Type:ref:…), mixed and nested up to Medplum's limit, parsed and checked as
// Medplum's parseChainedParameter (its texts). Built from the last parameter outward, so each link reads the index by the
// rids of the link after it: a chain is driven by its most selective end, never a scan of what references the one Patient.
function chainCond(type: string, f: Filter, a: string): Cond {
  const parts = splitChain(f.code);
  const links: Link[] = [];
  let t = type;
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith('_has:')) {
      const [, from, code] = part.split(':');
      const p = param(from, code);
      if (!p) throw badRequest(`Invalid search parameter in chain: ${from}?${code}`);
      if (!p.target?.includes(t as never)) throw badRequest(`Invalid reverse chain link: search parameter ${from}?${code} does not refer to ${t}`);
      if (p.type !== 'reference') throw badRequest(`Invalid search parameter in chain: ${from}?${code}`);
      links.push({ from: t, to: from, code, reverse: true, canonical: canonical(from, p) });
      t = from;
    } else {
      const [code, mod] = part.split(':');
      const p = param(t, code);
      if (!p) throw badRequest(`Invalid search parameter in chain: ${t}?${code}`);
      const to = p.target?.length === 1 ? p.target[0] : p.target?.find((x) => x === mod);
      if (!to) throw badRequest(`Unable to identify next resource type for search parameter: ${t}?${code}`);
      if (p.type !== 'reference') throw badRequest(`Invalid search parameter in chain: ${t}?${code}`);
      links.push({ from: t, to, code, reverse: false, canonical: canonical(t, p) });
      t = to;
    }
  }
  const last = parts[parts.length - 1];
  if (last.startsWith('_has:')) throw badRequest('Unterminated chained search');
  const code = last.split(':')[0];
  if (code !== '_filter' && !param(t, code)) throw badRequest(`Invalid search parameter at end of chain: ${t}?${code}`);
  if (links.length > MAX_CHAIN_LINKS) throw badRequest('Search chains longer than three links are not currently supported');
  // The parser leaves a chained value unparsed (no prefix, modifier in the code): parse it as the last type's own parameter.
  const filter = f.operator === Operator.EQUALS ? ownFilter(t, last, f.value) : { code: last, operator: f.operator, value: f.value };
  const [one] = links;
  // ref._id=x is the reference T/x itself, as Medplum (the target need not exist).
  if (links.length === 1 && !one.reverse && filter.code === '_id' && ([Operator.EQUALS, Operator.EXACT, Operator.NOT, Operator.NOT_EQUALS] as string[]).includes(filter.operator)) {
    const value = splitSearchOnComma(filter.value).map((v) => `${one.to}/${v}`).join(',');
    return cond(type, { code: one.code, operator: filter.operator === Operator.EXACT ? Operator.EQUALS : filter.operator, value }, a);
  }
  let set = matching(t, filter);
  for (const l of links.reverse()) set = linkSet(l, set);
  return { sql: `${a}.rid in (${set.sql})`, args: set.args, set, ref: true };
}

// Rids of l.from linked by l to the rids `inner` (of l.to). Each probe reads the index by inner's rids (idx_r), or by value (idx_v).
function linkSet(l: Link, inner: { sql: string; args: Arg[] }): { sql: string; args: Arg[] } {
  // A canonical link joins on the url of the referenced type, as Medplum (its text); url|version is the resource with that
  // url and version, as _include resolves it (Medplum matches the raw value, so url|version finds nothing there).
  const [source, target] = l.reverse ? [l.to, l.from] : [l.from, l.to];
  if (l.canonical && !param(target, 'url')) throw badRequest(`${target} cannot be chained via canonical reference (${source}:${l.code})`);
  if (l.canonical && l.reverse) {
    const vals = `select h.val from idx h where h.rid in (${inner.sql}) and h.code = ?`;
    return {
      sql: `select u.rid from idx u where u.type = ? and u.code = 'url' and u.val in (${vals}) union select u.rid from (select substr(w.val, 1, instr(w.val, '|') - 1) url, substr(w.val, instr(w.val, '|') + 1) ver from (${vals}) w where instr(w.val, '|') > 0) w
        join idx u on u.type = ? and u.code = 'url' and u.val = w.url join idx v on v.rid = u.rid and v.code = 'version' and v.val = w.ver`,
      args: [l.from, ...inner.args, l.code, ...inner.args, l.code, l.from],
    };
  }
  if (l.canonical) {
    return {
      sql: `select ci.rid from idx ci where ci.type = ? and ci.code = ? and ci.val in (select u.val from idx u where u.rid in (${inner.sql}) and u.code = 'url'
        union all select u.val || '|' || v.val from idx u join idx v on v.rid = u.rid and v.code = 'version' where u.rid in (${inner.sql}) and u.code = 'url')`,
      args: [l.from, l.code, ...inner.args, ...inner.args],
    };
  }
  if (l.reverse) {
    return {
      sql: `select x.rid from resources x where x.type = ? and x.id in (select substr(h.val, ?) from idx h where h.rid in (${inner.sql}) and h.code = ? and h.val >= ? and h.val < ?)`,
      args: [l.from, l.from.length + 2, ...inner.args, l.code, `${l.from}/`, `${l.from}/\uffff`],
    };
  }
  return { sql: `select ci.rid from idx ci where ci.type = ? and ci.code = ? and ci.val in (select ? || x.id from resources x where x.rid in (${inner.sql}))`, args: [l.from, l.code, `${l.to}/`, ...inner.args] };
}

// `code=value` parsed as a search parameter of `type` (modifier and prefix).
function ownFilter(type: string, code: string, value: string): Filter {
  try {
    return parseSearchRequest(`${type}?${new URLSearchParams([[code, value]])}`).filters?.[0] ?? { code, operator: Operator.EQUALS, value };
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e));
  }
}

function filterExpr(type: string, e: FhirFilterExpression, a: string): Cond {
  if (e instanceof FhirFilterConnective) {
    const l = filterExpr(type, e.left, a), r = filterExpr(type, e.right, a);
    return { sql: `(${l.sql} ${e.keyword === 'or' ? 'or' : 'and'} ${r.sql})`, args: [...l.args, ...r.args] };
  }
  if (e instanceof FhirFilterNegation) { const c = filterExpr(type, e.child, a); return { sql: `not (${c.sql})`, args: c.args }; }
  const c = e as FhirFilterComparison;
  const p = param(type, c.path);
  // _filter's eq parses as EXACT: equality for tokens, references, uris and ranges; exact match for strings. sw is a string's default.
  let op: Operator = c.operator;
  if (op === Operator.EXACT && p?.type !== 'string') op = Operator.EQUALS;
  else if (op === Operator.STARTS_WITH && p?.type === 'string') op = Operator.EQUALS;
  const { sql, args } = cond(type, { code: c.path, operator: op, value: c.value }, a);
  return { sql, args };
}

// ---------- results ----------

// _elements: the listed top-level fields plus id, meta and the type's required fields; tagged SUBSETTED (as Medplum).
function elements(r: Resource, fields: string[]): Resource {
  const required = Object.entries(tryGetDataType(r.resourceType)?.elements ?? {}).filter(([, e]) => e.min > 0).map(([k]) => k.replace('[x]', ''));
  const keep = new Set(['resourceType', 'id', 'meta', ...required, ...fields.map((f) => f.split('.')[0])]);
  const kept = (k: string) => keep.has(k) || [...keep].some((f) => k.startsWith(f) && /^[A-Z]/.test(k.slice(f.length)));
  // _birthDate: the extensions of a kept primitive.
  const out = Object.fromEntries(Object.entries(r).filter(([k]) => kept(k.startsWith('_') ? k.slice(1) : k))) as Resource;
  out.meta = { ...r.meta, tag: [...(r.meta?.tag ?? []), { system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' }] };
  return out;
}

// _summary, as Medplum: true keeps the type's summary elements, data drops text, text keeps text and the mandatory elements;
// id and meta always, tagged SUBSETTED (subsetResource).
export function summarize(r: Resource, mode: 'true' | 'data' | 'text'): Resource {
  const t = tryGetDataType(r.resourceType);
  const keep = mode === 'data' ? Object.keys(r).filter((k) => k !== 'text') : mode === 'text' ? ['text', ...t?.mandatoryProperties ?? []] : [...t?.summaryProperties ?? []];
  return subsetResource(r, keep)!;
}

// A sort key over the candidate row `d`: `code` set when it is a sortkeys column (indexed), else an expression.
type SortKey = { expr: string; desc: boolean; code?: string };

function sortKey(type: string, code: string, desc: boolean, i: number): SortKey {
  const p = code === '_id' || code === '_lastUpdated' ? undefined : param(type, code);
  if (p?.type === 'date' || !p && (code === '_id' || code === '_lastUpdated')) return { expr: `s${i}.${desc ? 'hi' : 'lo'}`, desc, code };
  if (!p) throw badRequest(`Unknown search parameter: ${code}`); // Medplum's text
  if (p.type === 'composite' || p.type === 'special') throw badRequest(`Unsupported sort parameter type ${p.type}: ${code}`);
  // shortcut: non-date sort keys are aggregated from index rows per candidate (fast sorts: dates, _id, _lastUpdated; see README Next phase);
  // add them to sortkeys if a use sorts large results by them.
  const col = p.type === 'number' || p.type === 'quantity' ? 'lo' : 'val';
  return { expr: `coalesce((select ${desc ? 'max' : 'min'}(i.${col}) from idx i where i.rid = d.rid and i.code = ${lit(code)} and (i.sys is null or i.sys not in (${lit(TEXT)}, ${lit(WORD)}))), x'ff')`, desc };
}

const encodeCursor = (keys: Arg[]): string => Buffer.from(JSON.stringify(keys.map((k) => (k instanceof Uint8Array ? null : k)))).toString('base64url');
function decodeCursor(c: string, n: number): Arg[] {
  let v: unknown;
  try { v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); } catch { v = undefined; }
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => x === null || typeof x === 'string' || typeof x === 'number')) throw badRequest('Invalid _cursor');
  return v.map((x) => (x === null ? MISSING : x));
}

// a comes strictly before b in a key's order (MISSING sorts after every value).
function before(a: Arg, b: Arg, desc: boolean): boolean {
  const am = a instanceof Uint8Array, bm = b instanceof Uint8Array;
  if (am || bm) return desc ? am && !bm : !am && bm;
  return desc ? a! > b! : a! < b!;
}

// Request parameters that do not change a result (the server accepts them on every route too).
export const IGNORED = new Set(['_format', '_pretty']);

// Checks parseSearchRequest leaves out: _type only fits a system-level search; _count/_offset must be numbers; a reference
// type modifier (subject:Group=a) is the reference Group/a (parseSearchRequest drops the modifier, which would match Patient/a).
function normalize(type: string, query: [string, string][]): [string, string][] {
  return query.map(([k, v]) => {
    if (k === '_type') throw badRequest('_type is not supported on a type-level search');
    if ((k === '_count' || k === '_offset') && !/^\d+$/.test(v)) throw badRequest(`Invalid ${k}: ${v}`);
    const m = /^([a-z][\w-]*):([A-Z][A-Za-z]+)$/.exec(k);
    const p = m && getSearchParameters(type)?.[m[1]];
    if (!m || p?.type !== 'reference') return [k, v];
    const target = m[2];
    if (!p.target?.includes(target as never)) throw badRequest(`${target} is not a target of ${type}.${m[1]}`);
    return [m[1], splitSearchOnComma(v).map((x) => {
      if (!x.includes('/')) return `${target}/${x}`;
      if (!x.startsWith(`${target}/`)) throw badRequest(`${k}=${x}: not a ${target} reference`);
      return x;
    }).join(',')];
  });
}

// A searchset whose entries hold each resource's stored JSON text, spliced in by searchJson().
type RawEntry = { fullUrl: string; mode: 'match' | 'include'; json: string };
type RawBundle = { total?: number; entry?: RawEntry[]; link?: Bundle['link'] };

// `type` an array: a system-level search across those types (_type), its filters applied per type as Medplum does.
export function searchJson(prep: Prep, type: string | string[], query: [string, string][], base: string): string {
  const raw = searchRaw(prep, type, query, base);
  const entry = raw.entry?.map((e) => `{"fullUrl":${JSON.stringify(e.fullUrl)},"search":{"mode":"${e.mode}"},"resource":${e.json}}`).join(',');
  return `{"resourceType":"Bundle","type":"searchset"${raw.total !== undefined ? `,"total":${raw.total}` : ''}${entry ? `,"entry":[${entry}]` : ''}${raw.link ? `,"link":${JSON.stringify(raw.link)}` : ''}}`;
}

// The driver of a search's filters, as SQL: distinct rids of each candidate set, counted up to the smallest so far (at most
// driveMax); the smallest drives. References count last: in a one-patient store, subject/patient/_compartment match nearly
// everything. Probes run smallest first, negations last.
// sorted: the size picks between the driver and a sort-index walk; an unsorted search with one filter needs no count (its set drives).
function plan(prep: Prep, conds: Cond[], sorted: boolean): { driver?: Cond; size: number; probesFor: (driven: boolean) => Cond[] } {
  const sizes = new Map<Cond, number>();
  const { driveMax } = searchTuning;
  if (conds.length === 1 && !sorted) return { driver: conds[0].set ? conds[0] : undefined, size: driveMax, probesFor: (driven) => (driven && conds[0].set ? [] : conds) };
  let cap = driveMax;
  // A one-value match lists each rid about once (index order; a name or address once per matching word, which only over-counts
  // its size for the driver choice); OR lists and texts (text and display) need distinct.
  const rank = (c: Cond) => (c.multi ? 0 : c.ref ? 2 : 1);
  for (const c of [...conds].sort((x, y) => rank(x) - rank(y))) {
    const n = c.set
      ? (prep(`select count(*) n from (select ${c.multi ? 'distinct ' : ''}rid from (${c.set.sql}) limit ?)`).get(...c.set.args, cap) as { n: number }).n
      : c.sql.startsWith('not ') ? Infinity : driveMax;
    sizes.set(c, c.set && n >= cap ? cap + 0.5 : n); // reached the cap: no smaller than the current smallest
    if (c.set && n < cap) cap = n;
  }
  conds.sort((x, y) => sizes.get(x)! - sizes.get(y)!);
  const driver = conds.find((c) => c.set);
  return { driver, size: driver ? sizes.get(driver)! : Infinity, probesFor: (driven) => conds.filter((c) => !driven || c !== driver) };
}

function searchRaw(prep: Prep, typeOrTypes: string | string[], query: [string, string][], base: string): RawBundle {
  aliasN = 0; // same query, same SQL text (statement cache)
  const system = Array.isArray(typeOrTypes);
  const types = system ? [...new Set(typeOrTypes)] : [typeOrTypes];
  const type = types[0];
  for (const t of types) if (!getSearchParameters(t)) throw badRequest(`Unknown search parameter: resource type ${t} is not stored`);
  const summary = query.find(([k]) => k === '_summary')?.[1];
  if (summary && !['count', 'false', 'true', 'data', 'text'].includes(summary)) throw badRequest(`Unsupported _summary=${summary}`); // false: everything, as Medplum
  if (query.some(([, v]) => v.includes('\0'))) throw badRequest('Search filter value cannot contain null bytes'); // Medplum's text
  const parse = (t: string): SearchRequest => {
    try {
      return parseSearchRequest(`${t}?${new URLSearchParams(normalize(t, system ? query.filter(([k]) => k !== '_type') : query).filter(([k]) => !IGNORED.has(k)))}`);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
  };
  const reqs = types.map(parse);
  const req = reqs[0];
  const conds = types.map((t, i) => (reqs[i].filters ?? []).map((f) => cond(t, f, 'd')));
  const count = Math.min(req.count ?? 20, MAX_COUNT); // _summary=count: parseSearchRequest reads params in order, as Medplum
  const keys = (req.sortRules ?? []).map((s, i) => {
    // Across types only _id and _lastUpdated sort, as Medplum (it looks any other code up on no type).
    if (system && s.code !== '_id' && s.code !== '_lastUpdated') throw badRequest(`Unknown search parameter: ${s.code}`); // Medplum's text
    return sortKey(type, s.code, !!s.descending, i);
  });
  keys.push({ expr: 'd.rid', desc: false });
  const plans = conds.map((c) => plan(prep, c, !!keys[0].code));
  // One type's matching rows `d`: its driver set (or every rid of the type) with its other filters as probes.
  const part = (i: number, cols: string): { sql: string; args: Arg[] } => {
    const { driver, probesFor } = plans[i];
    const probes = probesFor(!!driver);
    return {
      sql: `select ${cols} from ${driver ? `(${driver.set!.sql.replace(/^select /, 'select distinct ')}) d where 1` : `sortkeys d where d.type = ? and d.code = '_id'`}${probes.map((c) => ` and ${c.sql}`).join('')}`,
      args: [...(driver ? driver.set!.args : [types[i]]), ...probes.flatMap((c) => c.args)],
    };
  };
  // A system search is one SQL over the union of its types' rids (unique across types), so its cursor is one key tuple.
  const union = system ? types.map((_, i) => part(i, 'd.rid')).reduce((a, b) => ({ sql: `${a.sql} union all ${b.sql}`, args: [...a.args, ...b.args] })) : undefined;
  const { driver, size, probesFor } = plans[0];
  const { driveMax, walkPerRow } = searchTuning;
  const bundle: RawBundle = {};
  if (req.total === 'accurate' || req.total === 'estimate') {
    const q = union ? { sql: `select count(*) n from (${union.sql})`, args: union.args } : part(0, 'count(*) n');
    bundle.total = (prep(q.sql).get(...q.args) as { n: number }).n;
  }
  // Links as Medplum's: self always; first, next and previous on a non-empty page. Medplum's links carry _elements as _fields.
  // Names as written (code:not=x), values encoded, as Medplum's links.
  const url = (q: [string, string][]) => `${base}fhir/R4${system ? '' : `/${type}`}?${q.map(([k, v]) => `${encodeURIComponent(k).replaceAll('%3A', ':')}=${encodeURIComponent(v)}`).join('&')}`;
  const linkQuery = (set: Record<string, string>) => {
    const q = query.filter(([k]) => k !== '_offset' && k !== '_cursor' && !Object.hasOwn(set, k)).map(([k, v]): [string, string] => [k === '_elements' ? '_fields' : k, v]);
    return url([...q, ...Object.entries(set)]);
  };
  bundle.link = [{ relation: 'self', url: url(query) }];
  if (count === 0) return bundle;

  const offset = req.cursor ? 0 : req.offset ?? 0;
  const cursor = req.cursor ? decodeCursor(req.cursor, keys.length) : undefined;
  // mode walk: `d` is the first sort key's sortkeys row, walked in order (the whole index, or its first `budget` rows);
  // mode driver: `d` is the driver set (or every resource of the type; a system search: the union), sorted after the probes.
  const run = (walk: boolean, budget?: number): Record<string, Arg>[] => {
    const ks = keys.map((k, i) => (walk && i === 0 ? { ...k, expr: k.expr.replace('s0.', 'd.') } : k));
    const col = keys[0].desc ? 'hi' : 'lo';
    const [src, on, srcArgs]: [string, string, Arg[]] = walk
      ? budget
        ? [`(select * from sortkeys where type = ? and code = ? order by ${col}${keys[0].desc ? ' desc' : ''} limit ${budget}) d`, '1', [type, keys[0].code!]]
        : ['sortkeys d', 'd.type = ? and d.code = ?', [type, keys[0].code!]]
      : union ? [`(${union.sql}) d`, '1', union.args]
      : driver ? [`(${driver.set!.sql.replace(/^select /, 'select distinct ')}) d`, '1', driver.set!.args] : ['sortkeys d', "d.type = ? and d.code = '_id'", [type]];
    const joins = ks.map((k, i) => (k.code && !(walk && i === 0) ? ` join sortkeys s${i} on s${i}.rid = d.rid and s${i}.code = ${lit(k.code)}` : '')).join('');
    const probes = union ? [] : probesFor(!walk);
    const args: Arg[] = [...srcArgs, ...probes.flatMap((c) => c.args)];
    let after = '';
    if (cursor) {
      // Rows after the cursor in (key1, ..., rid) order, each key in its own direction; the redundant bound on the first key
      // lets the walk seek to the cursor instead of stepping over earlier rows.
      args.push(cursor[0]);
      after = ` and ${ks[0].expr} ${ks[0].desc ? '<=' : '>='} ? and (${ks.map((k, i) => {
        const eq = ks.slice(0, i).map((e, j) => { args.push(cursor[j]); return `${e.expr} = ?`; });
        args.push(cursor[i]);
        return `(${[...eq, `${k.expr} ${k.desc ? '<' : '>'} ?`].join(' and ')})`;
      }).join(' or ')})`;
    }
    const sql = `select ${ks.map((k, i) => `${k.expr} k${i}`).join(', ')} from ${src}${joins} where ${on}${probes.map((c) => ` and ${c.sql}`).join('')}${after}
      order by ${ks.map((k) => `${k.expr}${k.desc ? ' desc' : ''}`).join(', ')} limit ? offset ?`;
    return prep(sql).all(...args, count + 1, offset) as Record<string, Arg>[];
  };
  let found: Record<string, Arg>[] | undefined;
  // shortcut: a system search sorts its whole union on every page (the walks read one type's sort index); fine for a personal
  // record, upgrade to a k-way merge of per-type index walks when a store searches large types without a selective filter.
  if (union) found = run(false);
  else if (keys[0].code && size >= driveMax) found = run(true);
  else if (keys[0].code && walkPerRow * (count + 1 + offset) < size) {
    // A small page from a large set: walk the first rows of the sort index and keep the result only if it is provably the
    // page (full, and its last key comes before the last walked key, so no tied row was cut off); else use the driver.
    const budget = walkPerRow * (count + 1 + offset);
    const got = run(true, budget);
    const edge = prep(`select ${keys[0].desc ? 'hi' : 'lo'} k from sortkeys where type = ? and code = ? order by k${keys[0].desc ? ' desc' : ''} limit 1 offset ${budget - 1}`)
      .get(type, keys[0].code) as { k: Arg } | undefined;
    if (!edge || (got.length > count && before(got[got.length - 1].k0, edge.k, keys[0].desc))) found = got;
  }
  found ??= run(false);
  const more = found.length > count;
  const page = found.slice(0, count);
  const last = `k${keys.length - 1}`;
  const rids = page.map((x) => x[last] as number);
  const byRid = new Map<number, Found>();
  for (const x of rids.length ? prep(`select rid, type, id, json from resources where rid in (${qs(rids.length)})`).all(...rids) as Found[] : []) byRid.set(x.rid, x);
  const matches = rids.map((rid) => byRid.get(rid)!);

  const entry: RawEntry[] = matches.map((m) => ({
    fullUrl: `${base}fhir/R4/${m.type}/${m.id}`, mode: 'match', json: m.json,
  }));
  includes(prep, req, matches, entry, base);
  // _elements, else _summary, on every entry, includes too (Medplum's removeResourceFields).
  if (req.fields || req.summary) {
    for (const e of entry) {
      const r = JSON.parse(e.json) as Resource;
      e.json = JSON.stringify(req.fields ? elements(r, req.fields) : summarize(r, req.summary!));
    }
  }
  bundle.entry = entry;
  if (!page.length) return bundle;
  bundle.link.push({ relation: 'first', url: linkQuery({}) });
  if (more) {
    const lastRow = page[page.length - 1];
    bundle.link.push({ relation: 'next', url: linkQuery({ _count: String(count), _cursor: encodeCursor(keys.map((_, i) => lastRow[`k${i}`])) }) });
  }
  if (offset) bundle.link.push({ relation: 'previous', url: linkQuery(offset > count ? { _offset: String(offset - count) } : {}) });
  return bundle;
}

type Found = { rid: number; type: string; id: string; json: string };
// Medplum's limits on _(rev)include (DEFAULT_MAX_INCLUDE_DEPTH and DEFAULT_MAX_SEARCH_COUNT in
// packages/fhir-router/src/search-include.ts and packages/core/src/search/search.ts, 5.2.14).
const MAX_INCLUDE_DEPTH = 5, MAX_INCLUDE_ENTRIES = 1000;
const canonical = (type: string, p: SearchParameter): boolean => getSearchParameterDetails(type, p).type === SearchParameterType.CANONICAL;

// _include and _revinclude, as Medplum's getExtraEntries: the first round applies every one to the matches, each later round
// only the :iterate ones to everything the round before found (seen or not); a round still finding something after
// MAX_INCLUDE_DEPTH rounds is refused. Canonical parameters resolve by url (url|version: that version, as R4 canonicals).
function includes(prep: Prep, req: SearchRequest, matches: Found[], entry: RawEntry[], base: string): void {
  if (!req.include && !req.revInclude) return;
  for (const inc of req.include ?? []) {
    if (param(inc.resourceType, inc.searchParam)?.type !== 'reference') throw badRequest(`Invalid include parameter: ${inc.resourceType}:${inc.searchParam}`); // Medplum's text
  }
  for (const inc of req.revInclude ?? []) {
    if (param(inc.resourceType, inc.searchParam)?.type !== 'reference') throw badRequest(`Invalid include parameter: ${inc.resourceType}:${inc.searchParam}`); // Medplum's text
  }
  const seen = new Set(matches.map((m) => `${m.type}/${m.id}`));
  const read = (sql: string, ...args: Arg[]) => prep(sql).all(...args) as Found[];
  const byUrl = (t: string, url: string): Found[] => {
    const bar = url.lastIndexOf('|');
    const [u, v] = bar < 0 ? [url, undefined] : [url.slice(0, bar), url.slice(bar + 1)];
    return read(`select r.rid, r.type, r.id, r.json from resources r where r.rid in (select rid from idx where type = ? and code = 'url' and val = ?)${v === undefined ? ''
      : ` and r.rid in (select rid from idx where type = ? and code = 'version' and val = ?)`} order by r.rid`, t, u, ...(v === undefined ? [] : [t, v]));
  };
  let frontier = matches, iterateOnly = false;
  for (let depth = 0; frontier.length; depth++) {
    if (depth >= MAX_INCLUDE_DEPTH || entry.length > MAX_INCLUDE_ENTRIES) throw badRequest(`Search with _(rev)include reached query scope limit: depth=${depth}, results=${entry.length}`); // Medplum's text
    const found: Found[] = [];
    const rids = frontier.map((f) => f.rid);
    for (const inc of req.include ?? []) {
      if (iterateOnly && inc.modifier !== Operator.ITERATE) continue;
      const p = param(inc.resourceType, inc.searchParam)!;
      const vals = prep(`select distinct val from idx where rid in (${qs(rids.length)}) and type = ? and code = ? order by rowid`).all(...rids, inc.resourceType, inc.searchParam) as { val: string }[];
      if (canonical(inc.resourceType, p)) {
        for (const t of (p.target ?? []).filter((t) => !inc.targetType || t === inc.targetType)) for (const { val } of vals) found.push(...byUrl(t, val));
        continue;
      }
      for (const { val } of vals) {
        const [t, id, extra] = val.split('/');
        if (!t || !id || extra !== undefined || (inc.targetType && inc.targetType !== t)) continue;
        found.push(...read('select rid, type, id, json from resources where type = ? and id = ?', t, id));
      }
    }
    for (const inc of req.revInclude ?? []) {
      if (iterateOnly && inc.modifier !== Operator.ITERATE) continue;
      const of = frontier.filter((f) => !inc.targetType || f.type === inc.targetType);
      const refs = canonical(inc.resourceType, param(inc.resourceType, inc.searchParam)!)
        ? of.flatMap((f) => { const r = JSON.parse(f.json) as { url?: string; version?: string }; return r.url ? [r.url, ...(r.version ? [`${r.url}|${r.version}`] : [])] : []; })
        : of.map((f) => `${f.type}/${f.id}`);
      if (!refs.length) continue;
      found.push(...read(`select r.rid, r.type, r.id, r.json from resources r where r.rid in (select i.rid from idx i where i.type = ? and i.code = ? and i.val in (${qs(refs.length)})) order by r.rid limit ${MAX_INCLUDE_ENTRIES + 1}`, // more is refused below
        inc.resourceType, inc.searchParam, ...refs));
    }
    const next = new Map<string, Found>();
    for (const x of found) {
      const ref = `${x.type}/${x.id}`;
      next.set(ref, x);
      if (!seen.has(ref)) entry.push({ fullUrl: `${base}fhir/R4/${ref}`, mode: 'include', json: x.json });
      seen.add(ref);
    }
    frontier = [...next.values()];
    iterateOnly = true;
  }
}
