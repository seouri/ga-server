// The chronology's time scale: one axis for the whole record, linear and detailed within `c` days of the focus date, compressed
// with the logarithm of the distance beyond that, with a linear floor (lambda) so a far year never vanishes. Days are numbers
// (milliseconds / 86400000). C1-continuous: the slope at c is 1/c on both sides. linear: true gives the plain scale, to compare.
export function fisheye({ min, max, focus, c = 60, lambda = 0.15, left = 0, width, linear = false }) {
  const f = Math.min(max, Math.max(min, focus));
  const h = (u) => (linear ? u : (u <= c ? u / c : 1 + Math.log(u / c)) + (lambda * u) / 365);
  const dh = (u) => (linear ? 1 : (u <= c ? 1 / c : 1 / u) + lambda / 365);
  const hl = h(f - min), hr = h(max - f);
  const s = width / (hl + hr || 1);
  const x = (t) => left + s * (hl + Math.sign(t - f) * h(Math.abs(t - f)));
  const pxPerDay = (t) => s * dh(Math.abs(t - f));
  // x is strictly increasing in t: bisect.
  const invert = (px) => {
    let a = min - 3650, b = max + 3650;
    for (let i = 0; i < 48; i++) { const m = (a + b) / 2; if (x(m) < px) a = m; else b = m; }
    return (a + b) / 2;
  };
  return { x, invert, pxPerDay, focus: f, c, min, max, left, width, linear };
}

const DAY = 86400000;
export const toDay = (iso) => Date.parse(iso.length <= 10 ? `${iso}T12:00:00Z` : iso) / DAY;
export const fromDay = (d) => new Date(d * DAY);

// Calendar ticks at their true positions. Each unit is drawn only where its neighbours are at least `gap` px apart, so the
// spacing itself shows the compression (as on a logarithmic axis): years everywhere they fit, months and days near the focus.
export function ticks(scale, gap = { year: 26, month: 30, day: 22 }) {
  const out = [];
  const y0 = fromDay(scale.min).getUTCFullYear(), y1 = fromDay(scale.max).getUTCFullYear() + 1;
  const at = (y, m = 0, d = 1) => Date.UTC(y, m, d) / DAY;
  for (let y = y0; y <= y1; y++) {
    const t = at(y), w = scale.x(at(y + 1)) - scale.x(t);
    if (t >= scale.min - 1 && t <= scale.max + 1) out.push({ t, unit: 'year', label: w >= gap.year ? String(y) : w >= 13 ? `'${String(y).slice(2)}` : '', major: true });
    for (let m = 0; m < 12; m++) {
      const tm = at(y, m), wm = scale.x(at(y, m + 1)) - scale.x(tm);
      if (tm < scale.min || tm > scale.max) continue;
      if (m > 0 && wm >= 6) out.push({ t: tm, unit: 'month', label: wm >= gap.month ? new Date(tm * DAY).toLocaleString('en', { month: 'short', timeZone: 'UTC' }) : '' });
      if (wm < 60) continue; // days only where a month is wide
      const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const every = wm / n >= gap.day ? 1 : wm / n >= gap.day / 7 ? 7 : 0;
      for (let d = 2; every && d <= n; d++) {
        const td = at(y, m, d);
        if (td > scale.max) break;
        if (every === 1 || new Date(td * DAY).getUTCDay() === 1) out.push({ t: td, unit: 'day', label: String(d) });
      }
    }
  }
  return out;
}

// What one pixel means at a point of the axis, in words.
export function perPixel(pxPerDay) {
  const d = 1 / pxPerDay;
  if (d >= 300) return `1 px ≈ ${(d / 365).toFixed(1)} years`;
  if (d >= 45) return `1 px ≈ ${Math.round(d / 30.4)} months`;
  if (d >= 1.5) return `1 px ≈ ${Math.round(d)} days`;
  if (d >= 1 / 20) return `1 day ≈ ${Math.round(1 / d)} px`;
  return `1 hour ≈ ${Math.round(1 / d / 24)} px`;
}
