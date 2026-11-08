import { expect, test } from 'vitest';
import { liverFibrosisRisk } from '../src/liver-fibrosis.ts';

// Synthetic, hand-computed cases. FIB-4 = age*AST/(platelets*sqrt(ALT)); ALT 100 makes sqrt exact.
test.each([
  [50, 25, 1.25, 'low'],
  [50, 26, 1.3, 'indeterminate'], // at the low cut-off
  [60, 44.5, 2.67, 'indeterminate'], // at the high cut-off
  [60, 45, 2.7, 'high'],
  [64, 25, 1.6, 'indeterminate'],
  [65, 25, 1.625, 'low'], // age >= 65: low cut-off 2.0
  [65, 31, 2.015, 'indeterminate'],
] as const)('FIB-4 age %d AST %d = %d (%s)', (age, ast, value, band) => {
  const r = liverFibrosisRisk({ age, ast, alt: 100, platelets: 100 });
  expect(r.fib4.value).toBeCloseTo(value, 10);
  expect(r.fib4.band).toBe(band);
  expect(r.fib4.cutoffs).toEqual({ low: age >= 65 ? 2.0 : 1.3, high: 2.67 });
});

test('NAFLD Fibrosis Score with all inputs; bands at the cut-offs', () => {
  // -1.675 + 0.037*50 + 0.094*30 + 1.13 + 0.99*(40/40) - 0.013*200 - 0.66*4 = -0.125
  const r = liverFibrosisRisk({ age: 50, ast: 40, alt: 40, platelets: 200, bmi: 30, albumin: 4, ifgOrDiabetes: true });
  expect(r.nfs.value).toBeCloseTo(-0.125, 10);
  expect(r.nfs.band).toBe('indeterminate');
  expect(r.nfs.cutoffs).toEqual({ low: -1.455, high: 0.676 });
  expect(r.citations.join(' ')).toMatch(/FIB-4 bands: Rinella/);
  // Without diabetes: -1.255, still indeterminate; with albumin 4.5: -1.585, low.
  expect(liverFibrosisRisk({ age: 50, ast: 40, alt: 40, platelets: 200, bmi: 30, albumin: 4.5, ifgOrDiabetes: false }).nfs).toMatchObject({ band: 'low' });
  // 70 years, BMI 35, diabetes, AST/ALT 2, platelets 120, albumin 3.5: -1.675+2.59+3.29+1.13+1.98-1.56-2.31 = 3.445
  expect(liverFibrosisRisk({ age: 70, ast: 60, alt: 30, platelets: 120, bmi: 35, albumin: 3.5, ifgOrDiabetes: true }).nfs).toMatchObject({ band: 'high' });
  expect(r.citations.join(' ')).toMatch(/Sterling.*2006/);
  expect(r.citations.join(' ')).toMatch(/Angulo.*2007/);
  expect(r.citations.join(' ')).toMatch(/AASLD.*2023/);
  expect(r.notes).toContain('Not medical advice: input for a conversation with your clinician.');
});

test('age >= 65: NFS low cut-off is 0.12 (McPherson 2017)', () => {
  // -1.675 + 0.037*65 + 0.094*25 + 0 + 0.99*1 - 0.013*250 - 0.66*4 = -1.82
  const old = liverFibrosisRisk({ age: 65, ast: 30, alt: 30, platelets: 250, bmi: 25, albumin: 4, ifgOrDiabetes: false });
  expect(old.nfs).toMatchObject({ band: 'low', cutoffs: { low: 0.12, high: 0.676 } });
  // -1.675 + 0.037*65 + 0.094*30 + 1.13 + 0.99 - 0.013*200 - 0.66*4.65 = 0.001: low at 65+, indeterminate at 64 (0.001 - 0.037 = -0.036)
  const mid = { ast: 30, alt: 30, platelets: 200, bmi: 30, albumin: 4.65, ifgOrDiabetes: true };
  expect(liverFibrosisRisk({ age: 65, ...mid }).nfs.band).toBe('low');
  expect(liverFibrosisRisk({ age: 64, ...mid }).nfs.band).toBe('indeterminate');
  expect(old.notes.join(' ')).toMatch(/NFS low cut-off is 0.12/);
});

test('NFS is null with a note when an input is missing', () => {
  const r = liverFibrosisRisk({ age: 50, ast: 40, alt: 40, platelets: 200, bmi: 30 });
  expect(r.nfs).toMatchObject({ value: null, band: null });
  expect(r.notes.join(' ')).toMatch(/NAFLD Fibrosis Score needs.*albumin.*ifgOrDiabetes/);
});

test('35 or under: values returned with a not-validated note for both scores', () => {
  expect(liverFibrosisRisk({ age: 35, ast: 30, alt: 100, platelets: 100 }).notes.join(' ')).toMatch(/FIB-4 and NFS are not validated at age 35 or under/);
  const r = liverFibrosisRisk({ age: 30, ast: 30, alt: 100, platelets: 100 });
  expect(r.fib4.value).toBeCloseTo(0.9, 10);
  expect(r.notes.join(' ')).toMatch(/not validated at age 35 or under/);
});

test('impossible values are rejected', () => {
  expect(() => liverFibrosisRisk({ age: 50, ast: 30, alt: 0, platelets: 100 })).toThrow(/alt must be > 0/);
  expect(() => liverFibrosisRisk({ age: 50, ast: 30, alt: 30, platelets: 100, albumin: -1 })).toThrow(/albumin must be > 0/);
  // Wrong units: albumin in g/L, platelets per microliter.
  expect(() => liverFibrosisRisk({ age: 50, ast: 30, alt: 30, platelets: 100, albumin: 42 })).toThrow(/albumin 42 .*g\/dL/);
  expect(() => liverFibrosisRisk({ age: 50, ast: 30, alt: 30, platelets: 250000 })).toThrow(/platelets 250000 .*10\^9\/L/);
  expect(liverFibrosisRisk({ age: 50, ast: 30, alt: 30, platelets: 2000, albumin: 10 }).fib4.value).toBeGreaterThan(0);
});
