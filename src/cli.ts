#!/usr/bin/env node
import { GaError, getClient, loadConfig } from './config.ts';
import { detectKind, importAny } from './import.ts';
import { enrollLink } from './gateway/passkey.ts';
import { gatewayDir } from './gateway/store.ts';
import { extractWithApi } from './llm.ts';
import { importExtracted, runMcp } from './mcp.ts';
import { setup } from './setup.ts';
import { shareCommand } from './share/cli.ts';
import { smartCommand } from './smart/cli.ts';

try {
  if (process.argv[2] === 'setup') {
    const cfg = await setup();
    console.log(`GA ready. Patient/${cfg.patientId}`);
  } else if (process.argv[2] === 'import' && process.argv[3]) {
    const file = process.argv[3];
    const api = process.argv[4] === '--llm' && process.argv[5] === 'api';
    if (/\.(pdf|png|jpe?g)$/i.test(file)) {
      if (!api) throw new GaError(`PDFs are extracted by your agent: ask it to import ${file}, or pass --llm api`);
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new GaError('--llm api requires the ANTHROPIC_API_KEY environment variable');
      const cfg = loadConfig();
      // Extract first so a missing key/bad file fails before any Medplum work; only the report is printed.
      const resources = await extractWithApi(file, key);
      console.log(JSON.stringify(await importExtracted(await getClient(cfg), cfg, resources, file)));
    } else {
      const kind = detectKind(file);
      let tz: string | undefined;
      if (kind === 'ehi') {
        // R17: the zone the export's local times are in: --tz, else GA_EHI_TZ, else this machine's zone (exportInfo).
        const args = process.argv.slice(4);
        if (args.length === 1 && args[0].startsWith('--tz=')) tz = args[0].slice(5);
        else if (args.length === 2 && args[0] === '--tz') tz = args[1];
        else if (args.length) throw new GaError('usage: ga import <ehi-folder> [--tz <IANA zone>]');
        if (tz !== undefined) {
          try {
            if (!tz) throw new RangeError();
            new Intl.DateTimeFormat('en', { timeZone: tz });
          } catch {
            throw new GaError(`--tz needs an IANA time zone, e.g. America/New_York: ${tz}`);
          }
        }
      } else if (kind === 'apple' && process.argv.length > 4) throw new GaError('usage: ga import <apple-health-folder>');
      const cfg = loadConfig();
      console.log(JSON.stringify(await importAny(await getClient(cfg), cfg, file, { tz })));
    }
  } else if (process.argv[2] === 'migrate' && process.argv.slice(3).every((a) => a === '--delete-old' || a === '--accept')) {
    const { deleteOld, migrate } = await import('./migrate.ts');
    const accept = process.argv.includes('--accept');
    await (process.argv.includes('--delete-old') ? deleteOld({ accept }) : migrate({ accept }));
  } else if (process.argv[2] === 'mcp') {
    await runMcp(loadConfig());
    // keep running: stdio transport holds the process open
  } else if (process.argv[2] === 'gateway' && process.argv[3] === 'serve' && process.argv.length === 4) {
    await (await import('./gateway/server.ts')).serveGateway(); // loaded on demand: oidc-provider is heavy
  } else if (process.argv[2] === 'passkey' && process.argv[3] === 'link' && process.argv.length === 4) {
    const url = process.env.GA_PUBLIC_URL?.replace(/\/+$/, '');
    if (!url) throw new GaError('ga passkey link needs the GA_PUBLIC_URL environment variable (the public https address)');
    console.log(enrollLink(gatewayDir(), url));
  } else if (process.argv[2] === 'apps' && (process.argv.length === 3 || (process.argv[3] === 'disconnect' && process.argv.length === 5))) {
    const { listClients, createProvider, disconnectClient } = await import('./gateway/oauth.ts'); // loaded on demand: oidc-provider is heavy
    if (process.argv.length === 3) console.log(JSON.stringify(listClients(gatewayDir())));
    else {
      const dir = gatewayDir();
      const id = process.argv[4];
      if (!listClients(dir).some((c) => c.clientId === id)) throw new GaError(`no connected app ${id} (see ga apps)`);
      await disconnectClient(createProvider({ publicUrl: process.env.GA_PUBLIC_URL?.replace(/\/+$/, '') || 'http://localhost', dir }), dir, id);
      console.log(`disconnected ${id}`);
    }
  } else if (!(await smartCommand(process.argv.slice(2))) && !(await shareCommand(process.argv.slice(2)))) {
    throw new GaError('usage: ga setup | ga migrate [--delete-old] [--accept] | ga import <path> [--tz <IANA zone>] | ga mcp | ga keys | ga connect <fhir-base-url> | ga sync | ga status | ga disconnect <source> | ga share … | ga gateway serve | ga passkey link | ga apps [disconnect <clientId>] | ga shares | ga revoke <id>');
  }
} catch (e) {
  if (e instanceof GaError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
