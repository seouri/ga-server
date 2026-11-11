import { describe, expect, it } from 'vitest';
import { SNOMED } from '../src/concepts.ts';
import { pickAuto } from '../src/concept-auto.ts';

const c = (code: string, display: string, from?: 'linked record') => ({ system: SNOMED, code, display, ...(from && { from }) });

describe('pickAuto', () => {
  it('maps a single exact name', () => {
    expect(pickAuto('Colonoscopy', [c('73761001', 'Colonoscopy'), c('12350003', 'Colonoscopy with biopsy')])?.code).toBe('73761001');
  });
  it('ignores case and punctuation', () => {
    expect(pickAuto('colonoscopy.', [c('73761001', 'Colonoscopy')])?.code).toBe('73761001');
  });
  it('two exact names map nothing', () => {
    expect(pickAuto('Colonoscopy', [c('73761001', 'Colonoscopy'), c('446521004', 'Colonoscopy')])).toBeUndefined();
  });
  it('a linked-record candidate is never auto-mapped', () => {
    expect(pickAuto('Colonoscopy', [c('73761001', 'Colonoscopy', 'linked record'), c('12350003', 'Colonoscopy with biopsy')])).toBeUndefined();
  });
});
