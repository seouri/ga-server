// node --max-old-space-size=4096 tools/personalrecord/cli.ts <dir> --known <ehr-data.json> --out <file.json> [--include-before-cutoff]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { attachAnnotations, type PrAnnotation } from './annotations.ts';
import { rebuild } from './rebuild.ts';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const dir = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
const knownPath = flag('--known'), outPath = flag('--out');
if (!dir || !knownPath || !outPath) {
  console.error('usage: node --max-old-space-size=4096 tools/personalrecord/cli.ts <dir> --known <ehr-data.json> --out <file.json> [--include-before-cutoff]');
  process.exit(2);
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const bundle = readJson(join(dir, 'bundle.json')) as Bundle;
const anns = readJson(join(dir, 'annotations.json')) as PrAnnotation[];
const known = (readJson(knownPath) as { fhir?: Record<string, Resource[]> }).fhir ?? {};

const { resources, report } = rebuild(bundle, known, { includeBeforeCutoff: args.includes('--include-before-cutoff') });
const attached = attachAnnotations(anns, known, resources);
const fhir: Record<string, Resource[]> = {};
for (const r of attached.resources) (fhir[r.resourceType] ??= []).push(r);
writeFileSync(outPath, JSON.stringify({ fhir, attachments: [] }));
console.log(JSON.stringify({ ...report, annotationsMatched: anns.length - attached.unmatched.length, annotationsUnmatched: attached.unmatched }, null, 2));
