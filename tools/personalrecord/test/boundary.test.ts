// tools/personalrecord stands alone: its code imports only node:*, @medplum/fhirtypes (types) and its own files.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const inside = (p: string) => { const r = relative(ROOT, p); return !!r && !r.startsWith('..') && !isAbsolute(r); };
// A relative specifier must stay inside tools/personalrecord (./../src/x does not).
const allowed = (file: string, s: string) => s.startsWith('node:') || s === '@medplum/fhirtypes' || (s.startsWith('./') && inside(resolve(dirname(file), s)));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === 'test' || e.name === 'node_modules' ? [] : e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);

it('code imports only node:*, @medplum/fhirtypes types and ./ files', () => {
  const bad: string[] = [];
  let n = 0;
  for (const f of files(ROOT)) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*([^)]*)\)/g)) {
      n++;
      const s = m[1] ?? m[2] ?? m[3];
      if (!allowed(f, s)) bad.push(`${f}: ${s}`);
      if (s === '@medplum/fhirtypes' && !/import type\b[^;]*from\s*['"]@medplum\/fhirtypes['"]/.test(code)) bad.push(`${f}: fhirtypes must be import type`);
    }
  }
  expect(n).toBeGreaterThan(3);
  expect(bad).toEqual([]);
});

it('a ./ specifier that leaves tools/personalrecord is refused', () => {
  const f = join(ROOT, 'cli.ts');
  expect(allowed(f, './rebuild.ts')).toBe(true);
  expect(allowed(f, './../src/x.ts')).toBe(false);
  expect(allowed(f, './../../src/engine.ts')).toBe(false);
});
