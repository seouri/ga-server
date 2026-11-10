// tools/personalrecord stands alone: its code imports only node:*, @medplum/fhirtypes (types) and its own files.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
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
      const ok = s.startsWith('node:') || s.startsWith('./') || s === '@medplum/fhirtypes';
      if (!ok) bad.push(`${f}: ${s}`);
      if (s === '@medplum/fhirtypes' && !/import type\b[^;]*from\s*['"]@medplum\/fhirtypes['"]/.test(code)) bad.push(`${f}: fhirtypes must be import type`);
    }
  }
  expect(n).toBeGreaterThan(3);
  expect(bad).toEqual([]);
});
