// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// ValueSet $expand and $validate-code, and the membership subqueries the search modifiers use. Ported from Medplum 5.2.14
// packages/server/src/fhir/operations/expand.ts (paging, the text filter, its ranking and the order of codes),
// valuesetvalidatecode.ts, codesystemvalidatecode.ts (validateCodings), utils/terminology.ts (addPropertyFilter) and
// util/text.ts (foldText); the ranking's strict_word_similarity is a port of PostgreSQL's contrib/pg_trgm/trgm_op.c.
// Beyond Medplum (R4): compose.exclude, include.valueSet in $validate-code, instance-level $expand, 400 for a filter op it
// does not implement or a ValueSet that includes itself.
import type { DatabaseSync } from 'node:sqlite';
import type {
  CodeSystem, Coding, Parameters, ParametersParameter, ValueSet, ValueSetComposeInclude, ValueSetComposeIncludeConcept, ValueSetComposeIncludeFilter,
  ValueSetExpansionContains,
} from '@medplum/fhirtypes';
import { type Store, StoreError } from './store.ts';
import { type Arg, type Params, findTerminology, hierarchy, parentProperty, prep } from './terminology.ts';

// Medplum's limits (expand.ts): at most 1000 codes, 10 filter words, a text filter under 3 characters matches the exact code only
// (and no hierarchy), and a text filter without a count pages by 10.
const MAX_EXPANSION_SIZE = 1000;
const MAX_FILTER_TOKENS = 10;
const MIN_SUBSTRING_FILTER_LENGTH = 3;
const TYPEAHEAD_COUNT = 10;
const ABSTRACT = 'http://hl7.org/fhir/concept-properties#notSelectable';

export type ExpandOptions = { filter?: string; count?: number; offset?: number; displayLanguage?: string; excludeNotForUI?: boolean; includeDesignations?: boolean };
type Sql = { sql: string; args: Arg[] };
type Target = { rid: number; cs: CodeSystem & { id: string } };

const bad = (text: string) => new StoreError(400, [{ text }]);
const S = (sql: string, ...args: Arg[]): Sql => ({ sql, args });
const all = (parts: Sql[], sep: string): Sql => ({ sql: parts.map((p) => p.sql).join(sep), args: parts.flatMap((p) => p.args) });

// ---- text: Postgres's unaccent (medplum_unaccent), Medplum's foldText, pg_trgm's strict_word_similarity, the code collation

// shortcut: combining marks plus the letters unaccent.rules spells out; the full rules also cover ligatures and symbols. Upgrade
// if a parity test shows a difference.
const SPELLED: Record<string, string> = { ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ß: 'ss', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'TH', ı: 'i' };
const unaccent = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[øØæÆœŒßłŁđĐðÐþÞı]/g, (c) => SPELLED[c]).normalize('NFC');
const fold = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase(); // Medplum's foldText (in memory)
const words = (filter: string): string[] => filter.split(/\s+/g);

// pg_trgm's generate_trgm_only: each alphanumeric word, lowercased and padded ("  word "), gives its trigrams in order; bounds
// marks a word's first (1) and last (2) trigram.
function trigrams(s: string, bounds?: number[]): string[] {
  const out: string[] = [];
  for (const [w] of s.matchAll(/[\p{L}\p{N}]+/gu)) {
    const chars = [...`  ${w.toLowerCase()} `], start = out.length;
    for (let i = 0; i + 3 <= chars.length; i++) out.push(chars.slice(i, i + 3).join(''));
    if (bounds) { bounds[start] = (bounds[start] ?? 0) | 1; bounds[out.length - 1] = (bounds[out.length - 1] ?? 0) | 2; }
  }
  return out;
}

// pg_trgm's strict_word_similarity(s1, s2) (calc_word_similarity and iterate_word_similarity, strict): the best similarity
// between the trigrams of s1 and a run of whole words of s2, as float4.
export function strictWordSimilarity(s1: string, s2: string): number {
  const set1 = new Set(trigrams(s1)), bounds: number[] = [], t2 = trigrams(s2, bounds), ids = new Map<string, number>();
  const idx = t2.map((t) => ids.get(t) ?? (ids.set(t, ids.size), ids.size - 1));
  const found = [...ids.keys()].map((t) => set1.has(t)), lastpos = found.map(() => -1), ulen1 = set1.size;
  const sml = (count: number, ulen2: number) => Math.fround(count / (ulen1 + ulen2 - count));
  let ulen2 = 0, count = 0, lower = 0, max = 0;
  for (let i = 0; i < t2.length; i++) {
    const t = idx[i];
    if (lastpos[t] < 0) { ulen2++; if (found[t]) count++; }
    lastpos[t] = i;
    if (!(bounds[i] & 2)) continue;
    let cur = sml(count, ulen2), tc = count, tu = ulen2;
    const prevLower = lower;
    for (let tl = lower; tl <= i; tl++) {
      if (bounds[tl] & 1) {
        const s = sml(tc, tu);
        if (s > cur) { cur = s; ulen2 = tu; lower = tl; count = tc; }
      }
      if (lastpos[idx[tl]] === tl) { tu--; if (found[idx[tl]]) tc--; }
    }
    max = Math.max(max, cur);
    for (let tl = prevLower; tl < lower; tl++) if (lastpos[idx[tl]] === tl) lastpos[idx[tl]] = -1;
  }
  return max;
}

// A sort key for codes in the order Medplum's Postgres collation gives (glibc en_US, as ICU en with punctuation ignored): base
// letters and digits, then accents, then case (lower first), then the code itself.
export function collationKey(code: string): string {
  let base = '', accents = '', cases = '';
  for (const ch of code.normalize('NFD')) {
    if (/\p{M}/u.test(ch)) { accents = `${accents.slice(0, -1)}${ch}\u0002`; continue; }
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    const lower = ch.toLowerCase();
    base += lower; accents += '\u0002'; cases += lower === ch ? '0' : '1';
  }
  return `${base}\u0001${accents}\u0001${cases}\u0001${code}`;
}

// The SQL functions the expansion query uses, registered once per database.
const registered = new WeakSet<DatabaseSync>();
function functions(db: DatabaseSync): void {
  if (registered.has(db)) return;
  registered.add(db);
  const o = { deterministic: true };
  // LOWER(code) LIKE lower(filter) || '%'
  db.function('term_starts', o, (code, f) => +String(code).toLowerCase().startsWith(String(f).toLowerCase()));
  // every filter word: medplum_unaccent(display) ILIKE medplum_unaccent('%word%')
  db.function('term_words', o, (display, f) => {
    if (display === null) return 0;
    const d = unaccent(String(display)).toLowerCase();
    return +words(String(f)).every((w) => d.includes(unaccent(w).toLowerCase()));
  });
  // strict_word_similarity(medplum_unaccent(display), medplum_unaccent(filter)); null for no display
  db.function('term_rank', o, (display, f) => (display === null ? null : strictWordSimilarity(unaccent(String(display)), unaccent(String(f)))));
  db.function('term_key', o, (code) => collationKey(String(code)));
}

// ---- terminology resources

function target(store: Store, url: string, cache: Map<string, Target>): Target {
  let t = cache.get(url);
  if (!t) {
    const cs = findTerminology<CodeSystem>(store, 'CodeSystem', url);
    t = { rid: (prep(store.db)("select rid from resources where type = 'CodeSystem' and id = ?").get(cs.id) as { rid: number }).rid, cs };
    cache.set(url, t);
  }
  return t;
}
const propertyId = (store: Store, rid: number, code?: string): number | undefined =>
  code === undefined ? undefined : (prep(store.db)('select id from codesystem_property where system = ? and code = ?').get(rid, code) as { id: number } | undefined)?.id;

// A ValueSet an include names, unless it is one being expanded already (a cycle).
function nested(store: Store, url: string, seen: string[]): { vs: ValueSet; seen: string[] } {
  const vs = findTerminology<ValueSet>(store, 'ValueSet', url);
  if (seen.includes(vs.url!)) throw bad(`Recursive ValueSet definition: ${seen[0]}`);
  return { vs, seen: [...seen, vs.url!] };
}

// The rows (all coding columns, as `c`) of an include's filters: is-a and descendent-of walk down from the code (the first walk
// is the source, keeping Medplum's breadth-first order), =, in and exists test a property. Undefined when no row can match (an
// unknown property, or, as Medplum, a hierarchy filter with a text filter under 3 characters). Other ops are 400.
function filterRows(store: Store, { rid, cs }: Target, filters: ValueSetComposeIncludeFilter[], shortText = false): { from: Sql; where: Sql[] } | undefined {
  let from: Sql | undefined;
  const where: Sql[] = [S('c.system = ?', rid)];
  for (const f of filters) {
    switch (f.op) {
      case 'is-a':
      case 'descendent-of': {
        const prop = propertyId(store, rid, parentProperty(cs).code);
        if (prop === undefined || shortText) return undefined;
        const walk = hierarchy('down', rid, prop, f.value);
        if (!from) from = { sql: `(${walk.sql} select * from walk)`, args: walk.args };
        else where.push({ sql: `c.code in (${walk.sql} select code from walk)`, args: walk.args });
        if (f.op === 'descendent-of') where.push(S('c.code != ?', f.value));
        break;
      }
      case '=':
      case 'in':
      case 'exists': {
        const prop = propertyId(store, rid, f.property);
        if (prop === undefined) return undefined;
        const values = f.op === 'in' ? f.value.split(',') : [f.value];
        const test = f.op === 'exists' ? S('exists (select 1 from coding_property cp where cp.coding = c.id and cp.property = ?)', prop)
          : S(`exists (select 1 from coding_property cp where cp.coding = c.id and cp.property = ? and cp.value in (${values.map(() => '?').join()}))`, prop, ...values);
        where.push(f.op === 'exists' && f.value === 'false' ? { sql: `not ${test.sql}`, args: test.args } : test);
        break;
      }
      default:
        throw bad(`ValueSet filter op ${f.op} is not supported`);
    }
  }
  return { from: from ?? S('coding'), where };
}

// ---- membership: (system, code) pairs as SQL, for exclude and the search modifiers

const NONE = S('select null system, null code where 0');
const values = (pairs: [string, string][]): Sql =>
  pairs.length ? { sql: `select column1 system, column2 code from (values ${pairs.map(() => '(?, ?)').join()})`, args: pairs.flat() } : NONE;
const union = (parts: Sql[]): Sql => all(parts.map((p) => ({ sql: `select system, code from (${p.sql})`, args: p.args })), ' union all ');

function preExpanded(vs: ValueSet): boolean {
  const e = vs.expansion;
  return !!e?.contains?.length && !e.parameter && (!e.total || e.total === e.contains.length);
}

function includeMembers(store: Store, inc: ValueSetComposeInclude, seen: string[], cache: Map<string, Target>): Sql {
  if (inc.valueSet) return union(inc.valueSet.map((url) => { const n = nested(store, url, seen); return members(store, n.vs, n.seen, cache); }));
  if (!inc.system) throw bad('Missing system URL for ValueSet include');
  if (inc.concept) return values(inc.concept.map((c) => [inc.system!, c.code]));
  const rows = filterRows(store, target(store, inc.system, cache), inc.filter ?? []);
  if (!rows) return NONE;
  const w = all(rows.where, ' and ');
  return { sql: `select ? system, c.code code from ${rows.from.sql} c where ${w.sql} and c.synonymOf is null`, args: [inc.system, ...rows.from.args, ...w.args] };
}

function members(store: Store, vs: ValueSet, seen: string[], cache: Map<string, Target>): Sql {
  if (preExpanded(vs)) return values(flatten(vs.expansion!.contains!).map((c) => [c.system!, c.code!]));
  if (!vs.compose?.include?.length) throw bad('Missing ValueSet definition');
  const inc = union(vs.compose.include.map((i) => includeMembers(store, i, seen, cache)));
  const ex = excluded(store, vs, seen, cache);
  return ex ? { sql: `select * from (${inc.sql}) except select * from (${ex.sql})`, args: [...inc.args, ...ex.args] } : inc;
}

const excluded = (store: Store, vs: ValueSet, seen: string[], cache: Map<string, Target>): Sql | undefined =>
  vs.compose?.exclude?.length ? union(vs.compose.exclude.map((i) => includeMembers(store, i, seen, cache))) : undefined;
const isExcluded = (store: Store, ex: Sql | undefined, system: string, code: string): boolean =>
  !!ex && !!prep(store.db)(`select 1 from (${ex.sql}) where system = ? and code = ? limit 1`).get(...ex.args, system, code);

// An SQL subquery of the (system, code) pairs in ValueSet `url`, for the token modifiers :in and :not-in. 400 when the store
// does not hold the ValueSet, or a CodeSystem it draws a whole or filtered include from.
export function inValueSet(store: Store, url: string): Sql {
  const vs = findTerminology<ValueSet>(store, 'ValueSet', url);
  return members(store, vs, [vs.url!], new Map());
}

// An SQL subquery (column `code`) of the codes at or under (below) or at or over (above) `code` in CodeSystem `system`, for
// :below and :above. 400 when the store does not hold the CodeSystem or it has no is-a hierarchy.
export function subsumedCodes(store: Store, system: string, code: string, dir: 'below' | 'above'): Sql {
  const { rid, cs } = target(store, system, new Map());
  const walk = hierarchy(dir === 'below' ? 'down' : 'up', rid, propertyId(store, rid, parentProperty(cs).code) ?? -1, code);
  return { sql: `${walk.sql} select code from walk where synonymOf is null`, args: walk.args };
}

// ---- $expand

// Medplum's flattenConcepts: nested contains first, the display in displayLanguage (a concept without one is dropped from a
// stored expansion), the text filter in memory.
function flatten(concepts: (ValueSetComposeIncludeConcept | ValueSetExpansionContains)[], o: { filter?: string; system?: string; displayLanguage?: string; dropUntranslated?: boolean } = {}): Coding[] {
  const out: Coding[] = [];
  for (const c of concepts) {
    const system = (c as Coding).system ?? o.system;
    if (!system) throw bad('Missing system for Coding');
    const contained = (c as ValueSetExpansionContains).contains;
    if (contained) out.push(...flatten(contained, o));
    const display = o.displayLanguage ? c.designation?.find((d) => d.language === o.displayLanguage)?.value : c.display;
    if (!display && o.displayLanguage && o.dropUntranslated) continue;
    if (!o.filter || matchesTextFilter(c.code, display, o.filter)) out.push({ system, code: c.code, display });
  }
  return out;
}

// Medplum's matchesTextFilter: the in-memory form of the SQL text filter.
function matchesTextFilter(code: string | undefined, display: string | undefined, filter: string): boolean {
  const long = filter.length >= MIN_SUBSTRING_FILTER_LENGTH;
  if (code && (long ? code.toLowerCase().startsWith(filter.toLowerCase()) : code === filter)) return true;
  if (!display || !long) return false;
  const d = fold(display);
  return words(fold(filter)).every((w) => d.includes(w));
}

// Medplum's validateCodings: each coding of the CodeSystem's url found as a code (in displayLanguage, when given), with the
// coding's own display, else the code's.
function validateCodings(store: Store, { rid, cs }: Target, codings: Coding[], displayLanguage?: string): (Coding | undefined)[] {
  const eligible = codings.filter((c) => (!c.system || c.system === cs.url) && c.code), wanted = [...new Set(eligible.map((c) => c.code!))];
  const rows = wanted.length ? prep(store.db)(`select code, display from coding where system = ? and code in (${wanted.map(() => '?').join()})
    and ${displayLanguage ? 'language = ?' : 'synonymOf is null'} order by id`).all(rid, ...wanted, ...(displayLanguage ? [displayLanguage] : [])) as { code: string; display: string | null }[] : [];
  return codings.map((c) => {
    const row = eligible.includes(c) ? rows.find((r) => r.code === c.code) : undefined;
    return row ? { system: cs.url, code: c.code, display: c.display ?? row.display ?? undefined } : undefined;
  });
}

// Medplum's validateEnumeratedConcepts: under displayLanguage a display the ValueSet gives (a designation) is kept, the others
// come from the CodeSystem's translation.
function validateEnumerated(store: Store, t: Target, codings: Coding[], displayLanguage?: string): (Coding | undefined)[] {
  if (!displayLanguage || !codings.some((c) => c.display)) return validateCodings(store, t, codings, displayLanguage);
  const overridden = codings.filter((c) => c.display), translated = codings.filter((c) => !c.display);
  const a = validateCodings(store, t, overridden), b = translated.length ? validateCodings(store, t, translated, displayLanguage) : [];
  return codings.map((c) => (c.display ? a[overridden.indexOf(c)] : b[translated.indexOf(c)]));
}

// Medplum's addExpansionItems: one entry per code across the whole expansion; a synonym row becomes a designation, a canonical
// row arriving after its synonym takes over the display.
type Row = { code: string; display: string | null; synonymOf: number | null; language: string | null };
function addExpansionItems(rows: Row[], expansion: ValueSetExpansionContains[], cs: CodeSystem): void {
  for (const { code, display, synonymOf, language } of rows) {
    const ex = expansion.find((o) => o.code === code);
    if (!ex) expansion.push({ system: cs.url, code, display: display ?? undefined });
    else if (synonymOf === null) {
      if (ex.display) (ex.designation ??= []).push({ language: cs.language, value: ex.display });
      ex.display = display ?? undefined;
    } else if (display) (ex.designation ??= []).push({ language: language ?? undefined, value: display });
  }
}

// One include of a CodeSystem as one query with Medplum's filters, order and paging (limit count + 1, offset) in SQL.
function includeQuery(store: Store, t: Target, inc: ValueSetComposeInclude, o: ExpandOptions, ex: Sql | undefined): Sql | undefined {
  const f = o.filter, dl = o.displayLanguage, long = !!f && f.length >= MIN_SUBSTRING_FILTER_LENGTH;
  const rows = filterRows(store, t, inc.filter ?? [], !!f && !long);
  if (!rows) return undefined;
  const where = [...rows.where];
  let display = S('c.display'), language = S('c.language');
  const code = (col: string) => (long ? S(`term_starts(${col}, ?)`, f!) : S(`${col} = ?`, f!));
  if (dl) {
    // Medplum's joinTranslation: canonical rows, each with its translation (the best match of the text filter, then the first).
    where.push(S('c.synonymOf is null'));
    display = S(`(select x.display from coding x where x.system = ? and x.code = c.code and x.language = ? order by ${long ? 'term_words(x.display, ?) desc, ' : ''}x.id limit 1)`,
      t.rid, dl, ...(long ? [f!] : []));
    language = S('?', dl);
  } else if (!o.includeDesignations) where.push(S('c.language is null'));
  if (f) {
    if (!dl) {
      const c = code('c.code');
      where.push(long ? { sql: `((${c.sql} and c.synonymOf is null) or term_words(c.display, ?))`, args: [...c.args, f] } : { sql: `(${c.sql} and c.synonymOf is null)`, args: c.args });
    } else {
      const c = code('code');
      where.push({ sql: `c.code in (select code from coding where system = ? and synonymOf is null and ${c.sql}${long ? ' union all select code from coding where system = ? and language = ? and term_words(display, ?)' : ''})`,
        args: [t.rid, ...c.args, ...(long ? [t.rid, dl, f] : [])] });
    }
  }
  const abstract = o.excludeNotForUI ? propertyId(store, t.rid, t.cs.property?.find((p) => p.uri === ABSTRACT)?.code) : undefined;
  if (abstract !== undefined) where.push(S('not exists (select 1 from coding_property cp where cp.coding = c.id and cp.property = ?)', abstract));
  if (ex) where.push({ sql: `not exists (select 1 from (${ex.sql}) e where e.system = ? and e.code = c.code)`, args: [...ex.args, t.cs.url!] });
  // With a text filter: the exact code, then the display's similarity, then the code (Medplum); else the CodeSystem's order
  // (insertion, or the hierarchy walk's breadth-first order).
  const order = f ? S('order by x.code = ? desc, term_rank(x.display, ?) desc nulls first, term_key(x.code), x.id', f, f)
    : S(rows.from.sql === 'coding' ? 'order by x.id' : '');
  const w = all(where, ' and ');
  return {
    sql: `select * from (select c.id, c.code, ${display.sql} display, ${language.sql} language, c.synonymOf from ${rows.from.sql} c where ${w.sql}) x
      ${dl ? 'where x.display is not null' : ''} ${order.sql} limit ? offset ?`,
    args: [...display.args, ...language.args, ...rows.from.args, ...w.args, ...order.args, (o.count ?? MAX_EXPANSION_SIZE) + 1, o.offset ?? 0],
  };
}

// Medplum's computeExpansion: a stored full expansion as is; else each include in turn (a nested ValueSet, enumerated concepts,
// or a CodeSystem query), until the count is reached. Excludes apply to the includes (R4).
function compute(store: Store, vs: ValueSet, o: ExpandOptions, seen: string[], cache: Map<string, Target>): ValueSetExpansionContains[] {
  if (preExpanded(vs)) return flatten(vs.expansion!.contains!, { filter: o.filter, displayLanguage: o.displayLanguage, dropUntranslated: true });
  if (!vs.compose?.include?.length) throw new StoreError(400, [{ text: 'Missing ValueSet definition', expression: ['ValueSet.compose.include'] }]);
  const max = o.count ?? MAX_EXPANSION_SIZE, expansion: ValueSetExpansionContains[] = [], ex = excluded(store, vs, seen, cache);
  for (const inc of vs.compose.include) {
    if (inc.valueSet) {
      for (const url of inc.valueSet) {
        const n = nested(store, url, seen);
        expansion.push(...compute(store, n.vs, { ...o, count: max - expansion.length }, n.seen, cache)
          .filter((c) => !isExcluded(store, ex, c.system!, c.code!)));
        if (expansion.length >= max) break;
      }
      continue;
    }
    if (!inc.system) throw new StoreError(400, [{ text: 'Missing system URL for ValueSet include', expression: ['ValueSet.compose.include.system'] }]);
    if (expansion.length >= max) break;
    const t = target(store, inc.system, cache);
    if (inc.concept) {
      // Under displayLanguage the display comes from the CodeSystem, so the text filter runs after it.
      const deferred = o.displayLanguage ? o.filter : undefined;
      const codings = flatten(inc.concept, { system: inc.system, displayLanguage: o.displayLanguage, filter: deferred ? undefined : o.filter });
      for (const c of validateEnumerated(store, t, codings, o.displayLanguage)) {
        if (c && (!deferred || matchesTextFilter(c.code, c.display, deferred)) && !isExcluded(store, ex, c.system!, c.code!)) {
          expansion.push({ system: c.system, code: c.code, display: c.display });
        }
      }
    } else {
      const q = includeQuery(store, t, inc, o, ex);
      if (q) { functions(store.db); addExpansionItems(prep(store.db)(q.sql).all(...q.args) as Row[], expansion, t.cs); }
    }
  }
  return expansion;
}

// Medplum's expandValueSet: the ValueSet with `expansion` (total as Medplum counts it: the codes fetched, or 1001 past 1000).
export function expandValueSet(store: Store, vs: ValueSet, o: ExpandOptions): ValueSet {
  const codes = compute(store, vs, o, vs.url ? [vs.url] : [], new Map());
  const contains = codes.length >= MAX_EXPANSION_SIZE ? codes.slice(0, MAX_EXPANSION_SIZE) : codes.slice(0, o.count);
  const expansion = { total: codes.length >= MAX_EXPANSION_SIZE ? MAX_EXPANSION_SIZE + 1 : codes.length, timestamp: new Date().toISOString() };
  return { ...vs, expansion: contains.length ? { ...expansion, contains } : expansion };
}

// ---- operation inputs

// Inputs R4 defines that these operations do not implement (Medplum ignores them): 400 naming the first one given.
const refuse = (p: Params, op: string, names: string[]): void => {
  const n = names.find((x) => p.all(x).length);
  if (n) throw bad(`${op}: parameter ${n} is not supported`);
};
// A typed input as Medplum's parseInputParameters reads it (a GET value is text).
function typed(p: Params, name: string, type: 'integer' | 'boolean'): number | boolean | undefined {
  const v = p.get(name);
  if (v === undefined) return undefined;
  if (type === 'integer' && !Number.isNaN(Number.parseInt(v, 10))) return Number.parseInt(v, 10);
  if (type === 'boolean' && (v === 'true' || v === 'false')) return v === 'true';
  throw bad(`Invalid value '${v}' provided for ${type} parameter '${name}'`);
}
// A complex input (a resource or a datatype), which a GET query cannot carry.
function complex<K extends keyof ParametersParameter>(p: Params, name: string, key: K, type: string): ParametersParameter[K] | undefined {
  const v = p.all(name);
  if (v.length > 1) throw bad(`Expected 0..1 value(s) for input parameter ${name}, but ${v.length} provided`);
  if (v[0] && v[0][key] === undefined) throw bad(`Complex parameter ${name} (${type}) cannot be passed via query string`);
  return v[0]?.[key];
}
function readValueSet(store: Store, id: string): ValueSet {
  const row = store.readRow('ValueSet', id, true);
  if (!row) throw new StoreError(404, [{ text: 'Not found' }]);
  return JSON.parse(row.json);
}

// ValueSet $expand (type level, and instance level beyond Medplum): the ValueSet by id, `url` or an inline `valueSet`.
export function expand(store: Store, p: Params): ValueSet {
  refuse(p, '$expand', ['valueSetVersion', 'context', 'contextDirection', 'date', 'designation', 'includeDefinition', 'activeOnly', 'excludeNested',
    'excludePostCoordinated', 'exclude-system', 'system-version', 'check-system-version', 'force-system-version']);
  const filter = p.get('filter');
  if (filter?.includes('\0')) throw bad('Filter value cannot contain null bytes');
  if (filter && filter.trim().split(/\s+/g).length > MAX_FILTER_TOKENS) throw bad(`Filter value cannot contain more than ${MAX_FILTER_TOKENS} tokens`);
  const o: ExpandOptions = {
    filter: filter?.trim() || undefined, count: typed(p, 'count', 'integer') as number | undefined, offset: typed(p, 'offset', 'integer') as number | undefined,
    excludeNotForUI: typed(p, 'excludeNotForUI', 'boolean') as boolean | undefined, includeDesignations: typed(p, 'includeDesignations', 'boolean') as boolean | undefined,
    displayLanguage: p.get('displayLanguage'),
  };
  let vs = complex(p, 'valueSet', 'resource', 'ValueSet') as ValueSet | undefined;
  if (!vs && p.id) vs = readValueSet(store, p.id);
  if (!vs) {
    const url = p.get('url');
    if (!url) throw bad('Missing url');
    vs = findTerminology<ValueSet>(store, 'ValueSet', url);
  }
  if (o.filter && !o.count) o.count = TYPEAHEAD_COUNT;
  return expandValueSet(store, vs, o);
}

// ---- ValueSet $validate-code

// Medplum's findIncludedCode: the first coding (of the include's system, or without one) the include holds: listed, matching
// its filters, or any code of a whole-system include. A nested ValueSet is searched too (R4; Medplum answers 400).
function includedCode(store: Store, inc: ValueSetComposeInclude, codings: Coding[], seen: string[], cache: Map<string, Target>): Coding | undefined {
  if (inc.valueSet) {
    for (const url of inc.valueSet) {
      const n = nested(store, url, seen), found = foundIn(store, n.vs, codings, n.seen, cache);
      if (found) return found;
    }
    return undefined;
  }
  if (!inc.system) throw new StoreError(400, [{ text: 'Missing system URL for ValueSet include', expression: ['ValueSet.compose.include.system'] }]);
  const candidates = codings.filter((c) => c.code && (!c.system || c.system === inc.system));
  if (!candidates.length) return undefined;
  let found: Coding | undefined;
  if (inc.concept) found = candidates.find((c) => inc.concept!.some((i) => i.code === c.code));
  else if (inc.filter) {
    const rows = filterRows(store, target(store, inc.system, cache), inc.filter);
    if (rows) {
      const w = all(rows.where, ' and '), wanted = candidates.map((c) => c.code!);
      const matched = (prep(store.db)(`select c.code from ${rows.from.sql} c where ${w.sql} and c.code in (${wanted.map(() => '?').join()})`)
        .all(...rows.from.args, ...w.args, ...wanted) as { code: string }[]).map((r) => r.code);
      found = candidates.find((c) => matched.includes(c.code!));
    }
  } else found = candidates[0];
  return found && { ...found, system: inc.system };
}

function foundIn(store: Store, vs: ValueSet, codings: Coding[], seen: string[], cache: Map<string, Target>): Coding | undefined {
  let found: Coding | undefined;
  if (vs.expansion && !vs.expansion.parameter) found = vs.expansion.contains?.find((e) => codings.some((c) => e.system === c.system && e.code === c.code));
  else if (vs.compose) {
    for (const inc of vs.compose.include) if ((found = includedCode(store, inc, codings, seen, cache))) break;
    if (found && isExcluded(store, excluded(store, vs, seen, cache), found.system!, found.code!)) found = undefined;
  }
  return found;
}

// ValueSet $validate-code: result (and the display found; a given `display` must equal it). The ValueSet by id or `url`; the
// coding by system and code, `coding` or `codeableConcept`. A code is checked against its CodeSystem unless the store holds
// none (or only an example), when its system is enough, as Medplum.
export function validateCodeVs(store: Store, p: Params): Parameters {
  refuse(p, '$validate-code', ['context', 'valueSet', 'valueSetVersion', 'systemVersion', 'date', 'abstract', 'displayLanguage']);
  const url = p.get('url');
  let vs: ValueSet;
  if (p.id) vs = readValueSet(store, p.id);
  else if (url) vs = findTerminology<ValueSet>(store, 'ValueSet', url);
  else throw bad('No ValueSet specified');
  const system = p.get('system'), code = p.get('code'), display = p.get('display'), coding = complex(p, 'coding', 'valueCoding', 'Coding');
  const concept = complex(p, 'codeableConcept', 'valueCodeableConcept', 'CodeableConcept');
  let codings: Coding[];
  if (system && code) codings = [{ system, code, display }];
  else if (coding) codings = [coding];
  else if (concept?.coding) codings = concept.coding;
  else throw bad('No coding specified');
  const cache = new Map<string, Target>();
  let found = foundIn(store, vs, codings, vs.url ? [vs.url] : [], cache);
  const systemUrl = found?.system ?? vs.compose?.include?.[0]?.system;
  if (found && systemUrl) {
    let t: Target | undefined;
    try { t = target(store, systemUrl, cache); } catch (e) { if (!(e instanceof StoreError)) throw e; }
    found = t && t.cs.content !== 'example' ? validateCodings(store, t, [found])[0] : found.system === systemUrl ? found : undefined;
  } else found = undefined;
  const result = !!found && (!display || found.display === display);
  return { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: result }, ...(found?.display ? [{ name: 'display', valueString: found.display }] : [])] };
}
