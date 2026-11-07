import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The containers default to UTC; the host's zone from .env makes their dates and "today" local.
test('ga-sync and ga-gateway take TZ from .env, and setup.sh writes it', () => {
  const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  for (const svc of ['ga-sync', 'ga-gateway']) {
    const block = compose.slice(compose.indexOf(`  ${svc}:\n`)).split(/\n  [a-z-]+:\n/)[0];
    expect(block).toContain('TZ: ${TZ:-UTC}');
  }
  expect(readFileSync(new URL('../setup.sh', import.meta.url), 'utf8')).toMatch(/echo "TZ=\$tz" >> \.env/);
});
