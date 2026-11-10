// Largest file GA takes in: a chat upload (gateway) and a stored Binary (store server). Apple Health and EHI exports are archived whole.
export const MAX_UPLOAD = 2 * 1024 ** 3;
// The import worker thread (src/import-jobs.ts) inside the gateway: the 512 MB box leaves 190 MiB for the gateway (about 104 idle)
// plus the import, so RSS_MB is the import's increment over the idle gateway. Heap 64 and young generation 8 (batch 500) gave the
// lowest peak, 175 MiB for the whole gateway on a 365-day export (Linux): docs/superpowers/spikes/2026-11-09-import-memory.md.
export const IMPORT_WORKER_HEAP_MB = 64;
export const IMPORT_WORKER_YOUNG_MB = 8;
export const IMPORT_WORKER_RSS_MB = 86;
