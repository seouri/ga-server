import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');

// Every published port is loopback-only (the store, Medplum, the gateway), quoted or not; the store is chosen by
// .ga/config.json, never by compose.
test('compose publishes ports on 127.0.0.1 only and never sets GA_STORE', () => {
  const ports = (text: string) => [...text.matchAll(/^\s+- ['"]?([\d.]*:?\d+:\d+)['"]?\s*(?:#.*)?$/gm)].map((m) => m[1]);
  expect(ports(compose).length).toBeGreaterThan(3);
  for (const p of ports(compose)) expect(p).toMatch(/^127\.0\.0\.1:/);
  expect(ports("    ports:\n      - 8120:8120\n")).toEqual(['8120:8120']);
  expect(compose).not.toMatch(/GA_STORE:/);
});

// migrate-store opens .ga/store/ga.db itself: the ga-store container must not hold it open meanwhile (host and container
// locks on one file are not reliable across Docker Desktop's file sharing).
test('migrate-store stops ga-store with the writers and starts it again', async () => {
  const { dockerServices } = await import('../src/migrate-store.ts');
  const { commands } = dockerServices('.');
  expect(commands.stop).toBe('docker compose --profile sqlite stop ga-sync ga-gateway ga-store');
  expect(commands.start(false)).toBe('docker compose start ga-sync ga-gateway');
  expect(commands.start(true)).toBe('docker compose --profile sqlite up -d');
});

// Medplum is the default: ga-store and its backup run only with the sqlite profile, and the services that use the store
// when the config says so must not need it to start.
test('ga-store and ga-backup-store are in the sqlite profile; nothing requires ga-store', () => {
  const service = (name: string) => compose.split(/^  (?=\S)/m).find((b) => b.startsWith(`${name}:`)) ?? '';
  for (const s of ['ga-store', 'ga-backup-store']) expect(service(s)).toMatch(/^\s+profiles: \['sqlite'\]$/m);
  for (const s of ['ga-sync', 'ga-gateway']) expect(service(s)).toMatch(/ga-store:\n\s+condition: service_started[^\n]*\n\s+required: false/);
  for (const s of ['medplum-server', 'ga-sync', 'ga-gateway', 'ga-backup']) expect(service(s), s).not.toMatch(/profiles:/);
});

// C-CDA converts in process (vendor/medplum-ccda): no converter service, no ccda profile.
test('compose has no fhir-converter', () => {
  expect(compose).not.toMatch(/fhir-converter|profiles: \['ccda'\]/);
});
