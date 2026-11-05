import { expect, test } from 'vitest';
import { riskScore, type RiskInput } from '../src/risk.ts';

// Synthetic patients; expected values generated with the preventr R package (estimate_risk, 10yr base model,
// rounded to 3 decimals; pce_model to 6 decimals).
const cases: [RiskInput, number, number, number | null][] = [
  [{ age: 50, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90, race: 'other' }, 0.019, 0.027, 0.03092],
  [{ age: 62, sex: 'female', sbp: 145, bpTx: true, totalC: 240, hdlC: 45, statin: false, diabetes: true, smoker: true, egfr: 55, race: 'other' }, 0.193, 0.302, 0.301928],
  [{ age: 45, sex: 'male', sbp: 104, bpTx: false, totalC: 280, hdlC: 70, statin: true, diabetes: false, smoker: true, egfr: 105, race: 'black' }, 0.022, 0.032, 0.048634],
  [{ age: 70, sex: 'female', sbp: 132, bpTx: false, totalC: 180, hdlC: 62, statin: true, diabetes: false, smoker: false, egfr: 72, race: 'black' }, 0.053, 0.09, 0.11407],
  [{ age: 38, sex: 'male', sbp: 118, bpTx: false, totalC: 190, hdlC: 48, statin: false, diabetes: false, smoker: false, egfr: 110, race: 'other' }, 0.007, 0.01, null],
  [{ age: 55, sex: 'male', sbp: 160, bpTx: true, totalC: 230, hdlC: 38, statin: false, diabetes: true, smoker: false, egfr: 40, race: 'other' }, 0.224, 0.359, 0.254527],
];

test.each(cases)('matches preventr for %o', (input, ascvd, totalCvd, pce) => {
  const r = riskScore(input);
  expect(Math.abs((r.preventAscvd as number) - ascvd)).toBeLessThanOrEqual(0.0005);
  expect(Math.abs((r.preventTotalCvd as number) - totalCvd)).toBeLessThanOrEqual(0.0005);
  if (pce === null) expect(r.pce).toBeNull();
  else expect(r.pce as number).toBeCloseTo(pce, 5);
});

test('out-of-range inputs return null with a note instead of extrapolating', () => {
  const r = riskScore({ age: 85, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90 });
  expect(r).toMatchObject({ preventAscvd: null, preventTotalCvd: null, pce: null });
  expect(r.notes.join(' ')).toMatch(/age/);
});
