import { expect, test } from 'vitest';
// @ts-expect-error a browser module (plain JavaScript, no types)
import { fisheye, perPixel, ticks, toDay } from '../src/ui/web/scale.js';

const base = { min: toDay('2007-01-01'), max: toDay('2027-01-01'), focus: toDay('2026-11-23'), c: 60, left: 100, width: 1200 };

test('fisheye: fills the width, increases with time, and inverts', () => {
  const s = fisheye(base);
  expect(s.x(base.min)).toBeCloseTo(100, 6);
  expect(s.x(base.max)).toBeCloseTo(1300, 6);
  let last = -Infinity;
  for (let d = base.min; d <= base.max; d += 17) { const x = s.x(d); expect(x).toBeGreaterThan(last); last = x; }
  for (const d of [base.min + 5, toDay('2015-06-01'), base.focus - 30, base.focus, base.focus + 20]) expect(s.invert(s.x(d))).toBeCloseTo(d, 3);
});

test('fisheye: detail at the focus, compression far away, no jump at the edge of the focus window, a floor for far years', () => {
  const s = fisheye(base);
  const near = s.pxPerDay(base.focus), far = s.pxPerDay(toDay('2008-01-01'));
  expect(near / far).toBeGreaterThan(20);
  expect(s.pxPerDay(base.focus - 59.999)).toBeCloseTo(s.pxPerDay(base.focus - 60.001), 3);
  expect(s.x(toDay('2009-01-01')) - s.x(toDay('2008-01-01'))).toBeGreaterThan(8); // a far year keeps a readable width
  expect(s.x(base.focus + 1) - s.x(base.focus)).toBeCloseTo(near, 6); // linear inside the window
});

test('fisheye: linear mode is plain proportional time; a focus outside the record is clamped', () => {
  const s = fisheye({ ...base, linear: true });
  expect(s.x((base.min + base.max) / 2)).toBeCloseTo(700, 6);
  expect(fisheye({ ...base, focus: base.max + 900 }).focus).toBe(base.max);
});

test('ticks: every year is marked; months and days appear only near the focus', () => {
  const s = fisheye(base), t = ticks(s);
  expect(t.filter((x: { unit: string }) => x.unit === 'year').length).toBeGreaterThanOrEqual(20);
  const months = t.filter((x: { unit: string; label: string }) => x.unit === 'month' && x.label);
  expect(months.length).toBeGreaterThan(2);
  expect(months.every((m: { t: number }) => Math.abs(m.t - base.focus) < 3 * 365)).toBe(true);
  expect(t.some((x: { unit: string; t: number }) => x.unit === 'day' && Math.abs(x.t - base.focus) > 400)).toBe(false);
});

test('perPixel names the local scale', () => {
  expect(perPixel(1 / 400)).toBe('1 px ≈ 1.1 years');
  expect(perPixel(1 / 9)).toBe('1 px ≈ 9 days');
  expect(perPixel(2)).toBe('1 day ≈ 2 px');
});
