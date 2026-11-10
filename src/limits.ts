// Largest file GA takes in: a chat upload (gateway) and a stored Binary (store server). Apple Health and EHI exports are archived whole.
export const MAX_UPLOAD = 2 * 1024 ** 3;
// The import child's caps: the 512 MB box leaves 190 MiB for gateway (about 104 idle) + child, so 86 for the child. Measured today: an empty child with the importer loaded is 72 MiB (macOS) to 107 MiB (Linux), today's 2 GB import peaks 830-930 MiB and OOMs at heap 256: docs/superpowers/spikes/2026-11-09-import-memory.md.
export const IMPORT_CHILD_HEAP_MB = 64;
export const IMPORT_CHILD_RSS_MB = 86;
