#!/usr/bin/env node
import { importPath } from './ccda.ts';
import { GaError, getClient, loadConfig } from './config.ts';
import { extractWithApi } from './llm.ts';
import { importExtracted, runMcp } from './mcp.ts';
import { setup } from './setup.ts';

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
    const cfg = loadConfig();
    console.log(JSON.stringify(await importPath(await getClient(cfg), cfg, process.argv[3])));
    }
  } else if (process.argv[2] === 'mcp') {
    await runMcp(loadConfig());
    // keep running: stdio transport holds the process open
  } else {
    throw new GaError('usage: ga setup | ga import <path> | ga mcp');
  }
} catch (e) {
  if (e instanceof GaError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
