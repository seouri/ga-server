// The integration guard rejects a non-test project: a fake client, no Medplum.
import type { MedplumClient } from '@medplum/core';
import { expect, test, vi } from 'vitest';

const live = () => ({ get: vi.fn(async () => ({ project: { name: 'Guardian Angel' } })), createResource: vi.fn(), deleteResource: vi.fn(), searchResources: vi.fn(async () => []) }) as unknown as MedplumClient;

test('the guard rejects the live project in every helper, before any write', async () => {
  vi.stubEnv('GA_STORE', 'medplum');
  vi.resetModules();
  const h = await import('./integration/helpers.ts');
  for (const call of [(c: MedplumClient) => h.assertTestProject(c), (c: MedplumClient) => h.createTestPatient(c), (c: MedplumClient) => h.emptyTestProject(c)]) {
    const c = live();
    await expect(call(c)).rejects.toThrow(/non-test project/);
    expect(c.createResource).not.toHaveBeenCalled();
    expect(c.deleteResource).not.toHaveBeenCalled();
  }
  vi.unstubAllEnvs();
});
