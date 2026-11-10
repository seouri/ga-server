import { readFileSync } from 'node:fs';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { attachAnnotations, type PrAnnotation } from '../annotations.ts';
import { rebuild } from '../rebuild.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const KNOWN = load('known.json').fhir as Record<string, Resource[]>;
const ANNS = load('annotations.json') as PrAnnotation[];
const [ENDED_CONDITION, AMBIGUOUS, DATE_CHANGE, NOMATCH] = ANNS;

describe('attachAnnotations', () => {
  it('appends the note to a verbatim copy of the known resource', () => {
    const { resources } = attachAnnotations([ENDED_CONDITION], KNOWN, []);
    expect(resources[0]).toEqual({ ...KNOWN.Condition[0], note: [...(KNOWN.Condition[0] as { note: unknown[] }).note, expect.objectContaining({ authorString: 'Patient', text: expect.stringContaining('Ended') })] });
    expect((KNOWN.Condition[0] as { note: unknown[] }).note).toHaveLength(1); // input untouched
  });
  it('reports an annotation matching two resources', () => expect(attachAnnotations([AMBIGUOUS], KNOWN, []).unmatched).toEqual([{ code: 'Synthetic twin', reason: 'several' }]));
  it('reports one matching none', () => expect(attachAnnotations([NOMATCH], KNOWN, []).unmatched).toEqual([{ code: 'Nothing like this', reason: 'none' }]));
  it('adds a note to a rebuilt resource', () => {
    const rebuilt = rebuild(load('bundle.json') as Bundle, KNOWN, {}).resources;
    const { resources, unmatched } = attachAnnotations([DATE_CHANGE], KNOWN, rebuilt);
    expect(unmatched).toEqual([]);
    expect(resources).toHaveLength(rebuilt.length);
    const c = resources.find((r) => r.resourceType === 'Condition') as { note: { text: string }[] };
    expect(c.note.at(-1)!.text).toContain('Date corrected to 2017-07-27T18:24Z');
  });
});
