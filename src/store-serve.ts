// `ga store serve`: GA's wiring of the store (src/store) to .ga/store/ga.db and its token, with config.ts storeServeOptions
// (published on 127.0.0.1 only by compose), GA's upload limit for Binaries and the resource types GA stores.
import { GaError, storeServeOptions } from './config.ts';
import { MAX_UPLOAD } from './limits.ts';
import { GA_STORE_TYPES } from './store-types.ts';
import { runStore } from './store/serve.ts';
import { IndexFormatError } from './store/store.ts';

export { GA_STORE_TYPES }; // defined in store-types.ts, which ga setup imports without loading the store

export const gaStoreOptions = () => ({ ...storeServeOptions(), maxBinaryBytes: MAX_UPLOAD, types: GA_STORE_TYPES });

// An index-format refusal names GA's way to rebuild the file.
export const gaStoreError = (e: unknown): unknown =>
  e instanceof IndexFormatError ? new GaError(`${e.message}: move it aside and run ga migrate-store`) : e;

export async function storeServe(): Promise<void> {
  try { await runStore(gaStoreOptions()); } catch (e) { throw gaStoreError(e); }
}

// `node src/store-serve.ts` skips cli.ts's static imports (MCP, gateway, importers): about 60 MB less RSS for the store process.
if (import.meta.main) await storeServe();
