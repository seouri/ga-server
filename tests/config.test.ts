import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';

afterEach(() => vi.unstubAllEnvs());

test('config missing gives clear error', () => {
  expect(() => loadConfig('/nonexistent/config.json')).toThrow('run ga setup first');
});

test('GA_BASE_URL overrides baseUrl (the ga-sync container reaches Medplum by service name)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ga-cfg-')), 'config.json');
  writeFileSync(f, JSON.stringify({ baseUrl: 'http://localhost:8103/', patientId: 'p' }));
  expect(loadConfig(f).baseUrl).toBe('http://localhost:8103/');
  vi.stubEnv('GA_BASE_URL', 'http://medplum-server:8103/');
  expect(loadConfig(f)).toMatchObject({ baseUrl: 'http://medplum-server:8103/', patientId: 'p' });
});
