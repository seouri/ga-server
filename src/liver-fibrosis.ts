// Liver fibrosis risk: FIB-4 (Sterling 2006; age >= 65 low cut-off 2.0, McPherson 2017) and the NAFLD Fibrosis Score
// (Angulo 2007), with the bands used by the AASLD 2023 MASLD practice guidance.

export type LiverFibrosisInput = {
  age: number;
  ast: number; // U/L
  alt: number; // U/L
  platelets: number; // 10^9/L
  bmi?: number; // kg/m2
  albumin?: number; // g/dL
  ifgOrDiabetes?: boolean; // impaired fasting glucose or diabetes
};
type Band = 'low' | 'indeterminate' | 'high';
type Score = { value: number | null; band: Band | null; cutoffs: { low: number; high: number } };

const band = (v: number, low: number, high: number): Band => (v < low ? 'low' : v > high ? 'high' : 'indeterminate');

export function liverFibrosisRisk(x: LiverFibrosisInput): { fib4: Score; nfs: Score; citations: string[]; notes: string[] } {
  for (const k of ['age', 'ast', 'alt', 'platelets', 'bmi', 'albumin'] as const) {
    const v = x[k];
    if (v !== undefined && !(v > 0)) throw new Error(`${k} must be > 0 (got ${v})`);
  }
  const notes: string[] = [];
  const fib4 = (x.age * x.ast) / (x.platelets * Math.sqrt(x.alt));
  const fibCut = { low: x.age >= 65 ? 2.0 : 1.3, high: 2.67 };
  if (x.age < 35) notes.push('FIB-4 is not validated under age 35: read the value with caution.');
  if (x.age >= 65) notes.push('Age 65 or over: FIB-4 low cut-off is 2.0 instead of 1.3.');
  const nfsCut = { low: -1.455, high: 0.676 };
  const missing = (['bmi', 'albumin', 'ifgOrDiabetes'] as const).filter((k) => x[k] === undefined);
  let nfs: number | null = null;
  if (missing.length) notes.push(`NAFLD Fibrosis Score needs ${missing.join(', ')}: not computed.`);
  else nfs = -1.675 + 0.037 * x.age + 0.094 * x.bmi! + 1.13 * Number(x.ifgOrDiabetes) + 0.99 * (x.ast / x.alt) - 0.013 * x.platelets - 0.66 * x.albumin!;
  notes.push('Not medical advice: input for a conversation with your clinician.');
  return {
    fib4: { value: fib4, band: band(fib4, fibCut.low, fibCut.high), cutoffs: fibCut },
    nfs: { value: nfs, band: nfs === null ? null : band(nfs, nfsCut.low, nfsCut.high), cutoffs: nfsCut },
    citations: [
      'FIB-4: Sterling RK et al. Hepatology 2006;43:1317-25.',
      'FIB-4 age >= 65 cut-off: McPherson S et al. Am J Gastroenterol 2017;112:740-51.',
      'NAFLD Fibrosis Score: Angulo P et al. Hepatology 2007;45:846-54.',
      'Bands: Rinella ME et al. AASLD Practice Guidance on the clinical assessment and management of nonalcoholic fatty liver disease. Hepatology 2023;77:1797-835.',
    ],
    notes,
  };
}
