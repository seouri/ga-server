#!/usr/bin/env node
import { afterImport } from './concept-auto.ts';
import { defaultConfigPath, GaError, getClient, loadConfig } from './config.ts';
import { detectKind, DOCUMENT_EXT, importAny } from './import.ts';
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
    console.log(cfg.terminologyLookup === false
      ? 'Code lookup is off: term names stay on this machine.'
      : `Code lookup is on: to find standard codes, GA sends term names (never values, dates or ids) to NLM and HL7's tx.fhir.org. To turn it off, set "terminologyLookup": false in ${defaultConfigPath()}.`);
  } else if (process.argv[2] === 'import' && process.argv[3]) {
    const file = process.argv[3];
    const api = process.argv[4] === '--llm' && process.argv[5] === 'api';
    if (DOCUMENT_EXT.test(file)) {
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
      let fhirBase: string | undefined;
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
      } else if (kind === 'fhir-export') {
        const args = process.argv.slice(4);
        const usage = 'usage: ga import <fhir-export.json> --fhir-base <FHIR base URL>';
        if (args.length === 1 && args[0].startsWith('--fhir-base=')) fhirBase = args[0].slice(12);
        else if (args.length === 2 && args[0] === '--fhir-base') fhirBase = args[1];
        else throw new GaError(usage);
        const u = URL.canParse(fhirBase) ? new URL(fhirBase) : undefined;
        if (!u || !['http:', 'https:'].includes(u.protocol) || !u.hostname) throw new GaError('--fhir-base needs an http(s) URL, e.g. https://fhir.example.org/api/FHIR/R4/');
      } else if (kind === 'dicom' && process.argv.length > 4) throw new GaError('usage: ga import <dicom-folder>');
      else if (kind === 'apple' && process.argv.length > 4) throw new GaError('usage: ga import <apple-health-folder>');
      const cfg = loadConfig();
      const client = await getClient(cfg);
      console.log(JSON.stringify(await afterImport(client, cfg, await importAny(client, cfg, file, { tz, fhirBase }))));
    }
  } else if (process.argv[2] === 'import-job' && process.argv[3] && process.argv.length === 4) {
    await (await import('./import-jobs.ts')).runJob(gatewayDir(), process.argv[3]); // internal: one attempt of an import_file job, in this process
  } else if (process.argv[2] === 'migrate' && process.argv.slice(3).every((a) => a === '--delete-old' || a === '--accept')) {
    const { deleteOld, migrate } = await import('./migrate.ts');
    const accept = process.argv.includes('--accept');
    await (process.argv.includes('--delete-old') ? deleteOld({ accept }) : migrate({ accept }));
  } else if (process.argv[2] === 'migrate-store' && /^( --file (?!--)\S+| --yes| --services-stopped)*$/.test(process.argv.slice(3).map((a) => ` ${a}`).join(''))) {
    const { dockerServices, migrateStore } = await import('./migrate-store.ts');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { defaultConfigPath, storeServeOptions } = await import('./config.ts');
    const args = process.argv.slice(3);
    const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // the install: compose.yaml
    const fileAt = args.indexOf('--file');
    await migrateStore({
      file: fileAt >= 0 ? args[fileAt + 1] : storeServeOptions().file, configFile: defaultConfigPath(),
      reportFile: join(dirname(defaultConfigPath()), 'store', 'migrate-report.json'), yes: args.includes('--yes'),
      servicesStopped: args.includes('--services-stopped'), services: dockerServices(root), cfg: loadConfig(),
    });
  } else if (process.argv[2] === 'whats-new' && (process.argv.length === 3 || (process.argv[3] === '--since' && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[4] ?? '') && process.argv.length === 5))) {
    const { whatsNew } = await import('./whats-new.ts');
    const { patientEndpoints } = await import('./smart/sync.ts');
    const cfg = loadConfig();
    const client = await getClient(cfg);
    console.log(JSON.stringify(await whatsNew(client, cfg.patientId as string, patientEndpoints(client, cfg.patientId as string), { since: process.argv[4] })));
  } else if (process.argv[2] === 'maintenance' && (process.argv.length === 3 || (process.argv[3] === '--as-of' && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[4] ?? '') && process.argv.length === 5))) {
    const { healthMaintenance } = await import('./maintenance.ts');
    const cfg = loadConfig();
    console.log(JSON.stringify(await healthMaintenance(await getClient(cfg), cfg.patientId as string, process.argv[4])));
  } else if (process.argv[2] === 'perf' && (process.argv.length === 3 || (process.argv[3] === '--days' && /^[1-9]\d*$/.test(process.argv[4] ?? '') && process.argv.length === 5))) {
    console.log((await import('./perf.ts')).perfSummary(process.argv[4] ? Number(process.argv[4]) : 7));
  } else if (process.argv[2] === 'mcp') {
    await runMcp(loadConfig());
    // keep running: stdio transport holds the process open
  } else if (process.argv[2] === 'calendar' && /^( revoke)?$/.test(process.argv.slice(3).map((a) => ` ${a}`).join(''))) {
    const { newCalendarToken, revokeCalendar } = await import('./calendar.ts');
    if (process.argv[3] === 'revoke') {
      revokeCalendar(gatewayDir());
      console.log('calendar link revoked');
    } else {
      const pub = process.env.GA_PUBLIC_URL?.replace(/\/+$/, '');
      if (!pub) throw new GaError('the calendar link needs remote access: set GA_PUBLIC_URL in .env (see docs/chat-apps.md)');
      console.log(`${pub}/cal/${newCalendarToken(gatewayDir())}.ics\nSubscribe to it in your calendar app. Anyone with the link sees your health maintenance topics and due dates; \`ga calendar\` makes a new link (the old one stops), \`ga calendar revoke\` turns it off.`);
    }
  } else if (process.argv[2] === 'notify') {
    await (await import('./notify/cli.ts')).notifyCommand(process.argv.slice(3));
  } else if (process.argv[2] === 'store' && process.argv[3] === 'serve' && process.argv.length === 4) {
    await (await import('./store-serve.ts')).storeServe();
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
  } else if (process.argv[2] === 'concepts' && /^( --suggested| apply| --agent( --since \S+)?)?$/.test(process.argv.slice(3).map((a) => ` ${a}`).join(''))) {
    const { agentMappings, applyAll, reviewList } = await import('./concepts-cli.ts');
    const cfg = loadConfig();
    const client = await getClient(cfg);
    const pid = cfg.patientId as string;
    const [arg, , since] = process.argv.slice(3);
    const lookup = cfg.terminologyLookup !== false;
    console.log(JSON.stringify(arg === 'apply' ? await applyAll(client, pid, { lookup }) : arg === '--agent' ? await agentMappings(client, since) : await reviewList(client, pid, arg ? 'suggested' : 'unmapped', undefined, { lookup })));
  } else if (!(await smartCommand(process.argv.slice(2))) && !(await shareCommand(process.argv.slice(2)))) {
    throw new GaError('usage: ga setup | ga migrate [--delete-old] [--accept] | ga migrate-store [--file <path>] [--yes] [--services-stopped] | ga concepts [--suggested|--agent [--since YYYY-MM-DD]|apply] | ga import <path> [--tz <IANA zone>] | ga whats-new [--since YYYY-MM-DD] | ga maintenance [--as-of YYYY-MM-DD] | ga perf [--days N] | ga mcp | ga keys | ga connect <fhir-base-url> | ga sync | ga status | ga disconnect <source> | ga share … | ga calendar [revoke] | ga notify setup|test|status|off | ga gateway serve | ga passkey link | ga apps [disconnect <clientId>] | ga shares | ga revoke <id>');
  }
} catch (e) {
  if (e instanceof GaError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
