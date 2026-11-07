import { describe, expect, it } from 'vitest';
import { keyLabs } from '../src/health.ts';
import type { LabTrend } from '../src/labs.ts';

const t = (name: string, date: string, loinc?: string): LabTrend => ({ name, loinc, latest: { date, value: 1 }, count: 1, outOfRange: 0 });

describe('keyLabs', () => {
  it('matches by LOINC or name, keeps look-alikes out, takes the newest per test', () => {
    const r = keyLabs([
      t('Hemoglobin A1c', '2024-01-01'), t('Hemoglobin', '2024-01-01'), t('Glucose, urine', '2025-01-01'), t('Glucose', '2024-01-01'),
      t('Non-HDL cholesterol', '2024-01-01'), t('Cholesterol/HDL ratio', '2024-01-01'), t('HDL Cholesterol', '2024-01-01'), t('Cholesterol', '2024-01-01'),
      t('Platelet mean volume', '2024-01-01'), t('LDL calc', '2023-01-01', '13457-7'), t('LDL direct', '2024-02-01', '18262-6'),
      t('Creatinine, urine', '2025-01-01'), t('Sodium [Moles/volume] in Serum or Plasma', '2024-01-01', '2951-2'),
    ]);
    expect(r.map((x) => [x.test, x.name])).toEqual([
      ['A1c', 'Hemoglobin A1c'], ['Glucose', 'Glucose'], ['LDL', 'LDL direct'], ['HDL', 'HDL Cholesterol'], ['Total cholesterol', 'Cholesterol'],
      ['Hemoglobin', 'Hemoglobin'], ['Sodium', 'Sodium [Moles/volume] in Serum or Plasma'],
    ]);
  });
});
