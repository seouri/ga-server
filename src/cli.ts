#!/usr/bin/env node
import { GaError } from './config.ts';
import { setup } from './setup.ts';

try {
  if (process.argv[2] === 'setup') {
    const cfg = await setup();
    console.log(`GA ready. Patient/${cfg.patientId}`);
  } else {
    throw new GaError('usage: ga setup');
  }
} catch (e) {
  if (e instanceof GaError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
