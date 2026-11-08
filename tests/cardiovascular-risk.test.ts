import { expect, test } from 'vitest';
import { cardiovascularRisk10yr, type CardiovascularRiskInput } from '../src/cardiovascular-risk.ts';

// Synthetic patients; expected values generated with the preventr R package (estimate_risk, 10yr base model,
// rounded to 3 decimals; pce_model to 6 decimals).
const cases: [CardiovascularRiskInput, number, number, number | null][] = [
  [{ age: 50, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90, race: 'other' }, 0.019, 0.027, 0.03092],
  [{ age: 62, sex: 'female', sbp: 145, bpTx: true, totalC: 240, hdlC: 45, statin: false, diabetes: true, smoker: true, egfr: 55, race: 'other' }, 0.193, 0.302, 0.301928],
  [{ age: 45, sex: 'male', sbp: 104, bpTx: false, totalC: 280, hdlC: 70, statin: true, diabetes: false, smoker: true, egfr: 105, race: 'black' }, 0.022, 0.032, 0.048634],
  [{ age: 70, sex: 'female', sbp: 132, bpTx: false, totalC: 180, hdlC: 62, statin: true, diabetes: false, smoker: false, egfr: 72, race: 'black' }, 0.053, 0.09, 0.11407],
  [{ age: 38, sex: 'male', sbp: 118, bpTx: false, totalC: 190, hdlC: 48, statin: false, diabetes: false, smoker: false, egfr: 110, race: 'other' }, 0.007, 0.01, null],
  [{ age: 55, sex: 'male', sbp: 160, bpTx: true, totalC: 230, hdlC: 38, statin: false, diabetes: true, smoker: false, egfr: 40, race: 'other' }, 0.224, 0.359, 0.254527],
];

test.each(cases)('matches preventr for %o', (input, ascvd, totalCvd, pce) => {
  const r = cardiovascularRisk10yr(input);
  expect(Math.abs((r.preventAscvd as number) - ascvd)).toBeLessThanOrEqual(0.0005);
  expect(Math.abs((r.preventTotalCvd as number) - totalCvd)).toBeLessThanOrEqual(0.0005);
  if (pce === null) expect(r.pce).toBeNull();
  else expect(r.pce as number).toBeCloseTo(pce, 5);
});

test('out-of-range inputs return null with a note instead of extrapolating', () => {
  const r = cardiovascularRisk10yr({ age: 85, sex: 'male', sbp: 120, bpTx: false, totalC: 200, hdlC: 50, statin: false, diabetes: false, smoker: false, egfr: 90 });
  expect(r).toMatchObject({ preventAscvd: null, preventTotalCvd: null, pce: null });
  expect(r.notes.join(' ')).toMatch(/age/);
});

// PREVENT HF, 30-year and the HbA1c/UACR/full models. Expected values from preventr 0.12.2 (3 decimals):
//   library(preventr)
//   r <- estimate_risk(age=50, sex="male", sbp=120, bp_tx=FALSE, total_c=200, hdl_c=50, statin=FALSE, dm=FALSE,
//                      smoking=FALSE, egfr=90, bmi=27, time="both", quiet=TRUE)   # plus hba1c=, uacr= per case
//   r$risk_est_10yr[1, c("total_cvd","ascvd","heart_failure","model")]; r$risk_est_30yr[1, ...]
// [input, model, 10yr [cvd, ascvd, hf], 30yr [cvd, ascvd, hf] or null (age > 59: preventr warns "questionable"; GA returns null)]
const base = { bpTx: false, statin: false, diabetes: false, smoker: false } as const;
const full: [CardiovascularRiskInput, string, number[], number[] | null][] = [
  [{ ...base, age: 50, sex: 'male', sbp: 120, totalC: 200, hdlC: 50, egfr: 90, bmi: 27 }, 'base', [0.027, 0.019, 0.01], [0.178, 0.115, 0.082]],
  [{ ...base, age: 45, sex: 'female', sbp: 138, bpTx: true, totalC: 230, hdlC: 55, statin: true, diabetes: true, egfr: 95, bmi: 32, hba1c: 7.2 }, 'hba1c', [0.069, 0.044, 0.036], [0.354, 0.223, 0.238]],
  [{ ...base, age: 58, sex: 'male', sbp: 150, bpTx: true, totalC: 210, hdlC: 40, smoker: true, egfr: 55, bmi: 24, uacr: 45 }, 'uacr', [0.197, 0.125, 0.095], [0.485, 0.33, 0.294]],
  [{ ...base, age: 40, sex: 'female', sbp: 105, totalC: 180, hdlC: 65, smoker: true, egfr: 110, bmi: 35, hba1c: 5.8, uacr: 12 }, 'full', [0.01, 0.006, 0.007], [0.071, 0.038, 0.062]],
  [{ ...base, age: 66, sex: 'male', sbp: 162, bpTx: true, totalC: 250, hdlC: 38, statin: true, diabetes: true, egfr: 48, bmi: 31, hba1c: 8.1, uacr: 300 }, 'full', [0.456, 0.323, 0.289], null],
  [{ ...base, age: 48, sex: 'male', sbp: 132, totalC: 240, hdlC: 42, smoker: true, egfr: 100, bmi: 29, hba1c: 6.1 }, 'hba1c', [0.062, 0.044, 0.02], [0.284, 0.2, 0.133]],
  [{ ...base, age: 55, sex: 'male', sbp: 100, totalC: 170, hdlC: 60, statin: true, diabetes: true, egfr: 70, bmi: 26, hba1c: 6.8, uacr: 25 }, 'full', [0.063, 0.036, 0.046], [0.269, 0.151, 0.215]],
  [{ ...base, age: 36, sex: 'female', sbp: 112, totalC: 195, hdlC: 52, egfr: 120, bmi: 38 }, 'base', [0.005, 0.003, 0.002], [0.036, 0.023, 0.021]],
  // hba1c 16 is outside 4.5-15: preventr drops it and runs the UACR model.
  [{ ...base, age: 52, sex: 'female', sbp: 128, totalC: 215, hdlC: 58, egfr: 80, bmi: 22, hba1c: 16, uacr: 8 }, 'uacr', [0.024, 0.016, 0.009], [0.168, 0.102, 0.079]],
];

test.each(full)('PREVENT HF / 30-year / add-on models match preventr for %o', (input, model, ten, thirty) => {
  const r = cardiovascularRisk10yr(input);
  expect(r.preventModel).toBe(model);
  const near = (v: number | null, e: number) => expect(Math.abs((v as number) - e)).toBeLessThanOrEqual(0.0005);
  [r.preventTotalCvd, r.preventAscvd, r.preventHeartFailure].forEach((v, i) => near(v, ten[i]));
  const t30 = [r.preventTotalCvd30yr, r.preventAscvd30yr, r.preventHeartFailure30yr];
  if (thirty) t30.forEach((v, i) => near(v, thirty[i]));
  else {
    expect(t30).toEqual([null, null, null]);
    expect(r.notes.join(' ')).toMatch(/30-year.*59/);
  }
  if (input.hba1c === 16) expect(r.notes.join(' ')).toMatch(/HbA1c 16 outside 4.5-15/);
});

test('without BMI: heart failure is null with a note; ASCVD and total CVD unchanged', () => {
  const { bmi: _, ...noBmi } = full[0][0];
  const r = cardiovascularRisk10yr(noBmi);
  expect(r.preventHeartFailure).toBeNull();
  expect(r.preventHeartFailure30yr).toBeNull();
  expect(Math.abs((r.preventAscvd30yr as number) - 0.115)).toBeLessThanOrEqual(0.0005);
  expect(r.notes.join(' ')).toMatch(/BMI.*heart failure/);
});

test('BMI outside 18.5-39.9 nulls every PREVENT result, as preventr does', () => {
  const r = cardiovascularRisk10yr({ ...full[0][0], bmi: 45 });
  expect(r).toMatchObject({ preventAscvd: null, preventTotalCvd: null, preventHeartFailure: null, preventAscvd30yr: null, preventModel: null });
  expect(r.pce).not.toBeNull();
  expect(r.notes.join(' ')).toMatch(/BMI 45 outside 18.5-39.9/);
});
