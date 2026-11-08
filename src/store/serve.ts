// The store's own entry: `node serve.ts --file <db> --token-file <path> [--host 127.0.0.1] [--port 8120] [--max-binary-bytes N] [--types A,B]`.
// runStore is also what an embedding app calls with its own options.
import { parseArgs } from 'node:util';
import { type ServeOptions, serveStore } from './server.ts';

export async function runStore(opts: ServeOptions): Promise<void> {
  const server = await serveStore(opts);
  // As PID 1 in a container node ignores SIGTERM unless handled: close the server, which closes the database.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  console.log(`FHIR store on ${opts.host ?? '127.0.0.1'}:${opts.port} (${opts.file})`);
}

// The command line as ServeOptions; throws on a missing --file/--token-file or a bad number.
export function parseServeArgs(args: string[]): ServeOptions {
  const { values: v } = parseArgs({ args, strict: true, options: {
    file: { type: 'string' }, 'token-file': { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, 'max-binary-bytes': { type: 'string' }, types: { type: 'string' },
  } });
  if (!v.file || !v['token-file']) throw new Error('usage: serve.ts --file <db> --token-file <path> [--host <ip>] [--port <n>] [--max-binary-bytes <n>] [--types <Type,Type,...>]');
  const num = (name: string, s: string | undefined, dflt?: number) => {
    if (s === undefined) return dflt;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} needs a whole number: ${s}`);
    return n;
  };
  const types = v.types?.split(',').map((t) => t.trim()).filter(Boolean);
  if (types && !types.length) throw new Error('--types: no resource types (leave it out for every R4 type)');
  return { file: v.file, tokenFile: v['token-file'], host: v.host ?? '127.0.0.1', port: num('port', v.port, 8120)!, maxBinaryBytes: num('max-binary-bytes', v['max-binary-bytes']),
    types };
}

if (import.meta.main) {
  let opts: ServeOptions;
  try { opts = parseServeArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exit(2); }
  await runStore(opts);
}
