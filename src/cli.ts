#!/usr/bin/env node
import { importPath } from './ccda.ts';
import { GaError, getClient, loadConfig } from './config.ts';
import { runMcp } from './mcp.ts';
import { setup } from './setup.ts';

try {
  if (process.argv[2] === 'setup') {
    const cfg = await setup();
    console.log(`GA ready. Patient/${cfg.patientId}`);
  } else if (process.argv[2] === 'import' && process.argv[3]) {
    const cfg = loadConfig();
    console.log(JSON.stringify(await importPath(await getClient(cfg), cfg, process.argv[3])));
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
