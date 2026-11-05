// 10-year cardiovascular risk: AHA PREVENT base model (Khan et al., Circulation 2024) and the 2013 ACC/AHA
// Pooled Cohort Equations. Coefficients and term definitions are copied from the MIT-licensed preventr R package
// (base_10yr, run_models/prep_terms, pce_model), which is the reference the tests check against.

export type RiskInput = {
  age: number;
  sex: 'male' | 'female';
  totalC: number; // mg/dL
  hdlC: number; // mg/dL
  sbp: number; // mmHg
  bpTx: boolean;
  statin: boolean;
  diabetes: boolean;
  smoker: boolean;
  egfr: number; // mL/min/1.73m2
  race?: 'black' | 'other'; // PCE only; PREVENT does not use race
};
export type RiskResult = { preventAscvd: number | null; preventTotalCvd: number | null; pce: number | null; notes: string[] };

// Rows: age, non-HDL, HDL, SBP<110, SBP>=110, diabetes, smoking, BMI<30, BMI>=30, eGFR<60, eGFR>=60, BP tx, statin,
// BP tx*SBP>=110, statin*non-HDL, age*non-HDL, age*HDL, age*SBP>=110, age*diabetes, age*smoking, age*BMI>=30, age*eGFR<60, constant.
const PREVENT_10YR = {
  female: {
    ascvd: [0.719883, 0.1176967, -0.151185, -0.0835358, 0.3592852, 0.8348585, 0.4831078, 0, 0, 0.4864619, 0.0397779, 0.2265309, -0.0592374, -0.0395762, 0.0844423, -0.0567839, 0.0325692, -0.1035985, -0.2417542, -0.0791142, 0, -0.1671492, -3.819975],
    totalCvd: [0.7939329, 0.0305239, -0.1606857, -0.2394003, 0.3600781, 0.8667604, 0.5360739, 0, 0, 0.6045917, 0.0433769, 0.3151672, -0.1477655, -0.0663612, 0.1197879, -0.0819715, 0.0306769, -0.0946348, -0.27057, -0.078715, 0, -0.1637806, -3.307728],
  },
  male: {
    ascvd: [0.7099847, 0.1658663, -0.1144285, -0.2837212, 0.3239977, 0.7189597, 0.3956973, 0, 0, 0.3690075, 0.0203619, 0.2036522, -0.0865581, -0.0322916, 0.114563, -0.0300005, 0.0232747, -0.0927024, -0.2018525, -0.0970527, 0, -0.1217081, -3.500655],
    totalCvd: [0.7688528, 0.0736174, -0.0954431, -0.4347345, 0.3362658, 0.7692857, 0.4386871, 0, 0, 0.5378979, 0.0164827, 0.288879, -0.1337349, -0.0475924, 0.150273, -0.0517874, 0.0191169, -0.1049477, -0.2251948, -0.0895067, 0, -0.1543702, -3.031168],
  },
};

const MMOL = 0.02586; // mg/dL -> mmol/L, as in preventr

function preventTerms(x: RiskInput): number[] {
  const age = (x.age - 55) / 10;
  const nonHdl = (x.totalC - x.hdlC) * MMOL - 3.5;
  const hdl = (x.hdlC * MMOL - 1.3) / 0.3;
  const sbpLt = (Math.min(x.sbp, 110) - 110) / 20;
  const sbpGte = (Math.max(x.sbp, 110) - 130) / 20;
  const egfrLt = (Math.min(x.egfr, 60) - 60) / -15;
  const egfrGte = (Math.max(x.egfr, 60) - 90) / -15;
  const [dm, smk, bp, st] = [x.diabetes, x.smoker, x.bpTx, x.statin].map(Number);
  // BMI terms carry zero weight in the base model.
  return [age, nonHdl, hdl, sbpLt, sbpGte, dm, smk, 0, 0, egfrLt, egfrGte, bp, st, bp * sbpGte, st * nonHdl,
    age * nonHdl, age * hdl, age * sbpGte, age * dm, age * smk, 0, age * egfrLt, 1];
}

const logistic = (coef: number[], terms: number[]) => {
  const lo = coef.reduce((s, c, i) => s + c * terms[i], 0);
  return Math.exp(lo) / (1 + Math.exp(lo));
};

function pce(x: RiskInput): number {
  const [la, lt, lh, ls] = [x.age, x.totalC, x.hdlC, x.sbp].map(Math.log);
  const [s, d] = [Number(x.smoker), Number(x.diabetes)];
  const black = x.race === 'black';
  if (x.sex === 'female') {
    return black
      ? 1 - 0.9533 ** Math.exp(17.114 * la + 0.94 * lt - 18.92 * lh + 4.475 * la * lh + (x.bpTx ? 29.291 : 27.82) * ls + (x.bpTx ? -6.432 : -6.087) * la * ls + 0.691 * s + 0.874 * d - 86.6081)
      : 1 - 0.9665 ** Math.exp(-29.799 * la + 4.884 * la ** 2 + 13.54 * lt - 3.114 * la * lt - 13.578 * lh + 3.149 * la * lh + (x.bpTx ? 2.019 : 1.957) * ls + 7.574 * s - 1.665 * la * s + 0.661 * d + 29.1817);
  }
  return black
    ? 1 - 0.8954 ** Math.exp(2.469 * la + 0.302 * lt - 0.307 * lh + (x.bpTx ? 1.916 : 1.809) * ls + 0.549 * s + 0.645 * d - 19.5425)
    : 1 - 0.9144 ** Math.exp(12.344 * la + 11.853 * lt - 2.664 * la * lt - 7.99 * lh + 1.769 * la * lh + (x.bpTx ? 1.797 : 1.764) * ls + 7.837 * s - 1.795 * la * s + 0.658 * d - 61.1816);
}

// Validity ranges as enforced by preventr; out-of-range inputs give null with a note instead of an extrapolation.
export function riskScore(x: RiskInput): RiskResult {
  const notes: string[] = [];
  const inRange = (v: number, lo: number, hi: number, name: string) => (v >= lo && v <= hi) || (notes.push(`${name} ${v} outside ${lo}-${hi}`), false);
  const common = inRange(x.totalC, 130, 320, 'total cholesterol') && inRange(x.hdlC, 20, 100, 'HDL') && inRange(x.sbp, 90, 180, 'SBP');
  const preventOk = inRange(x.age, 30, 79, 'age (PREVENT)') && common && inRange(x.egfr, 15, 140, 'eGFR');
  const pceOk = inRange(x.age, 40, 79, 'age (PCE)') && common;
  if (!x.race) notes.push('race not given: PCE uses the white/other equation');
  if (x.statin) notes.push('PCE assumes no statin; its result ignores the statin input');
  const t = preventOk ? preventTerms(x) : [];
  return {
    preventAscvd: preventOk ? logistic(PREVENT_10YR[x.sex].ascvd, t) : null,
    preventTotalCvd: preventOk ? logistic(PREVENT_10YR[x.sex].totalCvd, t) : null,
    pce: pceOk ? pce(x) : null,
    notes,
  };
}
