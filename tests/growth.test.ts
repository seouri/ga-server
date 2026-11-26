import { expect, test } from 'vitest';
import { growthZ, growthZAtAge, screenZ } from '../src/growth.ts';

// Cases from the validation files of the CDC's growth-chart programs (CDC-DNPAO/CDCAnthro: output of the CDC SAS program and of WHO Anthro): no patient data.
test('CDC 2000, 2 to 20 years: weight-for-age and height-for-age z as the CDC SAS program gives them', () => {
  const cases: [sex: 'male' | 'female', months: number, kg: number, cm: number, waz: number, haz: number][] = [
    ['male', 197.880903, 88.000000, 176.0000, 1.72368, 0.19890],
    ['male', 239.310062, 39.490000, 157.0000, -4.75776, -2.75181],
    ['female', 203.466119, 70.100000, 171.7000, 1.20229, 1.35918],
    ['male', 156.517454, 50.348744, 160.0200, 0.46373, 0.45614],
    ['female', 219.597536, 67.585252, 172.7200, 0.94973, 1.47755],
    ['female', 230.735113, 88.450497, 162.5600, 1.87660, -0.11074],
  ];
  for (const [sex, months, kg, cm, waz, haz] of cases) {
    expect(growthZAtAge('weight', sex, months * 30.4375, kg)).toMatchObject({ reference: 'CDC 2000' });
    expect(growthZAtAge('weight', sex, months * 30.4375, kg)?.z).toBeCloseTo(waz, 3);
    expect(growthZAtAge('height', sex, months * 30.4375, cm)?.z).toBeCloseTo(haz, 3);
  }
});

test('WHO, under 24 months: weight-for-age and length-for-age z as WHO Anthro gives them (two decimals)', () => {
  const cases: [sex: 'male' | 'female', days: number, kg: number, cm: number, zwei: number, zlen: number][] = [
    ['male', 259, 8.2, 68.3, -0.61, -1.35],
    ['male', 289, 8.5, 71.1, -0.56, -0.67],
    ['female', 411, 8.8, 71.7, -0.43, -1.55],
    ['female', 289, 9.8, 75.2, 1.29, 1.8],
    ['female', 320, 8.6, 67.2, 0.0, -1.98],
    ['female', 350, 9.5, 76.7, 0.59, 1.3],
  ];
  for (const [sex, days, kg, cm, zwei, zlen] of cases) {
    expect(growthZAtAge('weight', sex, days, kg)).toMatchObject({ reference: 'WHO' });
    expect(Math.abs((growthZAtAge('weight', sex, days, kg)?.z as number) - zwei)).toBeLessThan(0.011);
    expect(Math.abs((growthZAtAge('height', sex, days, cm)?.z as number) - zlen)).toBeLessThan(0.006);
  }
});

test('growthZ: age from the dates as written; no answer without sex or birth date, before birth, or past 20 years', () => {
  expect(growthZ('weight', 'female', '2020-01-01', '2021-01-01T15:00:00Z', 9)?.reference).toBe('WHO'); // 366 days
  expect(growthZ('weight', 'female', '2020-01-01', '2023-01-01', 14)?.reference).toBe('CDC 2000');
  expect(growthZ('weight', undefined, '2020-01-01', '2023-01-01', 14)).toBeUndefined();
  expect(growthZ('weight', 'unknown', '2020-01-01', '2023-01-01', 14)).toBeUndefined();
  expect(growthZ('weight', 'male', undefined, '2023-01-01', 14)).toBeUndefined();
  expect(growthZ('weight', 'male', '2020-01-01', '2019-12-31', 3)).toBeUndefined();
  expect(growthZ('height', 'male', '1990-01-01', '2020-01-01', 180)).toBeUndefined();
  expect(growthZ('weight', 'male', '2020-01-01', '2023-01-01', 0)).toBeUndefined();
});

test('screenZ: beyond 4 SD, or 2 SD from the last accepted reading within a year, is set aside', () => {
  const why = screenZ([
    { t: '2021-03-03', z: 0.1 },
    { t: '2021-03-07', z: 31.5 }, // beyond 4
    { t: '2021-03-18', z: 0.2 },   // compared with 0.1, not with the reading set aside
    { t: '2021-08-01', z: 2.3 },   // 2.1 from 0.2 within a year
    { t: '2021-09-01', z: 0.4 },   // compared with 0.2
    { t: '2023-03-01', z: 2.5 },   // 2.1 from 0.4, but more than a year later: stands
    { t: '2023-04-01', z: -4.2 },  // beyond -4
    { t: '2023-05-01', z: 0.5 },   // exactly 2.0 from 2.5 within a year
  ]);
  expect(why.map((w) => w === undefined)).toEqual([true, false, true, false, true, true, false, false]);
  expect(why[1]).toMatch(/more than 4 standard deviations/);
  expect(why[3]).toMatch(/a change of 2.1 standard deviations within a year/);
});

