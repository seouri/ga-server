import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const DIR = new URL('./integration/parity/', import.meta.url);
const STATUSES = ['ported', 'skipped', 'plan-2', 'plan-3'];
const FEATURES = ['existing', 'summary', 'type', 'include', 'chain', 'modifier', 'composite', 'filter', 'meta', 'terminology', 'graphql', 'platform'];

// Table rows of INVENTORY.md; `\|` inside a cell is a literal pipe.
const rows = readFileSync(new URL('INVENTORY.md', DIR), 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('| ') && !l.startsWith('| file ') && !l.startsWith('| ---'))
  .map((l) => {
    const c = l.replace(/^\| | \|$/g, '').split(/ (?<!\\)\| /).map((s) => s.replace(/\\\|/g, '|'));
    return { file: c[0], title: c[1], status: c[2], feature: c[3], note: c[4] ?? '' };
  });

// A Medplum port is a test whose title ends in ` [<path>.test.ts]`; "differs on purpose: " is stripped.
// Other files here (harness.test.ts) test the harness and carry no such titles.
const TITLE = /(['"`])((?:\\.|(?!\1)[^\\\n])*? \[(?:server|fhir-router)\/[^\]]+\.test\.ts\])\1/g;
const parityTitles = new Set(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(new URL(f, DIR), 'utf8').matchAll(TITLE)].map((m) => m[2].replace(/\\(.)/g, '$1').replace(/^differs on purpose: /, ''))),
);

test('every ported row has a parity test with its title and file', () => {
  const missing = rows.filter((r) => r.status === 'ported' && !parityTitles.has(`${r.title} [${r.file}]`)).map((r) => `${r.title} [${r.file}]`);
  expect(missing).toEqual([]);
});

test('every parity test title is in the inventory as ported', () => {
  const ported = new Set(rows.filter((r) => r.status === 'ported').map((r) => `${r.title} [${r.file}]`));
  expect([...parityTitles].filter((t) => !ported.has(t))).toEqual([]);
});

test('every skipped row has a reason', () => {
  expect(rows.filter((r) => r.status === 'skipped' && !r.note.trim()).map((r) => `${r.title} [${r.file}]`)).toEqual([]);
});

test('no row is still todo', () => {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.filter((r) => !STATUSES.includes(r.status) || !FEATURES.includes(r.feature)).map((r) => `${r.title} [${r.file}]`)).toEqual([]);
});

test('no row appears twice', () => {
  const keys = rows.map((r) => `${r.title} [${r.file}]`);
  expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
});

test('no row is deferred to plan 2', () => {
  expect(rows.filter((r) => r.status === 'plan-2').map((r) => `${r.title} [${r.file}]`)).toEqual([]);
});

// Final gate: no row is left `not yet ported`.
test('no row is left "not yet ported"', () => {
  expect(rows.filter((r) => /not yet ported/i.test(r.note)).map((r) => `${r.title} [${r.file}]`)).toEqual([]);
});
