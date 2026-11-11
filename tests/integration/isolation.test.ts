// Medplum mode: the run is pointed at the ga-test project by global-setup.ts, never the live record.
import { expect, test } from 'vitest';
import { getClient, loadConfig } from '../../src/config.ts';
import { SQLITE } from './helpers.ts';

test.skipIf(SQLITE)('runs against a ga-test project', async () => {
  const me = (await (await getClient(loadConfig())).get('auth/me', { cache: 'no-cache' })) as { project: { name?: string; display?: string } };
  expect(me.project.name ?? me.project.display).toMatch(/^ga-test/);
});

test.skipIf(SQLITE)('the live config is not the run\'s config', () => {
  expect(process.env.GA_CONFIG).toBeTruthy();
  expect(process.env.GA_CONFIG).toBe(process.env.GA_INT_RUN_CONFIG);
});
