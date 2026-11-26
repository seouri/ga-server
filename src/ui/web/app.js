// The chronology page: every lane on one fisheye time axis (scale.js), drawn on one canvas. Position carries the category,
// grey carries the data, one colour marks values outside their range and one the selection.
import { fisheye, fromDay, perPixel, ticks, toDay } from '/scale.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d'), tip = $('tip'), panel = $('panel'), detail = $('detail');
const GUTTER = 132, RIGHT = 128, AXIS = 58;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let K = {}; // colours, read from the stylesheet so light and dark follow it
const colours = () => { K = Object.fromEntries(['bg', 'ink', 'mid', 'pale', 'faint', 'band', 'alert', 'sel'].map((k) => [k, css(`--${k}`)])); };
const fmt = (d, long = true) => fromDay(d).toLocaleDateString('en', { year: 'numeric', month: 'short', day: long ? 'numeric' : undefined, timeZone: 'UTC' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let data, S, lanes = [], hits = [], selected, hover;
const state = { focus: 0, c: 60, linear: false };

// ---- data preparation: dates to day numbers, stable rows, the lab series worth a row
function prepare(d) {
  const T = (e) => ({ ...e, d: toDay(e.t), d2: e.end ? toDay(e.end) : undefined });
  const today = toDay(d.today);
  const planned = d.planned.map(T);
  // The axis runs a little past today, to the things due within about a year; later due dates are listed, not drawn.
  const later = planned.filter((p) => p.d > today + 400);
  if (later.length) d.left[`items due more than a year from now (${later.map((p) => p.label).join('; ')})`] = later.length;
  const max = Math.max(today + 120, ...planned.filter((p) => p.d <= today + 400).map((p) => p.d + 30));
  const past = d.medications.filter((m) => !m.current).map((m) => ({ ...m, d: toDay(m.t), d2: toDay(m.end) }));
  const rows = []; // past courses packed by date (a year apart), so rows never move while the focus does
  for (const m of [...past].sort((a, b) => a.d - b.d)) {
    let r = rows.findIndex((end) => m.d > end + 365);
    if (r < 0) r = rows.push(0) - 1;
    rows[r] = m.d2;
    m.row = r;
  }
  const flagged = (s) => s.points.at(-1)?.[4];
  // The lab rows: tests whose latest result is outside its range (at most three), then the key tests GA knows by concept
  // (lipids, kidney, liver, blood count, ...), then the most often measured; ten rows.
  const able = d.labs.filter((s) => s.points.length >= 3), byCount = (a, b) => b.points.length - a.points.length;
  const key = able.filter((s) => s.rank !== undefined).sort((a, b) => a.rank - b.rank || byCount(a, b));
  const pick = [...able.filter(flagged).sort(byCount).slice(0, 3), ...key, ...(key.length < 6 ? [...able].sort(byCount).slice(0, 8) : [])];
  const labs = [...new Set(pick)].slice(0, 18)
    .map((s) => ({ ...s, pts: s.points.map((p) => ({ d: toDay(p[0]), v: p[1], lo: p[2], hi: p[3], flag: p[4] })) }));
  const shown = new Set(labs.map((s) => s.key));
  const restLabs = d.labs.filter((s) => !shown.has(s.key));
  return {
    ...d, today, min: toDay(d.min) - 30, max,
    encounters: d.encounters.map(T), problems: d.problems.map(T), procedures: d.procedures.map(T), studies: d.studies.map(T),
    immunizations: d.immunizations.map(T), notes: d.notes.map(T), planned: planned.filter((p) => p.d <= today + 400),
    dx: d.diagnoses.flatMap((x) => x.dates.map((t) => ({ d: toDay(t), label: x.label, t, n: x.dates.length }))),
    current: d.medications.filter((m) => m.current).map((m) => ({ ...m, d: toDay(m.t), d2: toDay(m.end) })), past, pastRows: rows.length,
    labs, restLabs, labTicks: [...restLabs.flatMap((s) => s.points.map((p) => toDay(p[0]))), ...d.otherLabs.map(toDay)],
    wearables: d.wearables.map((w) => {
      // A reading with one value arrives with null in the second place (JSON has no undefined): null, like undefined, means no second value.
      const pts = w.points.map((p) => [toDay(p[0]), p[1], p[2]]), clinic = w.clinic.map((p) => [toDay(p[0]), p[1], p[2], p[3]]);
      const vals = [...pts, ...clinic].flatMap((p) => (p[2] == null ? [p[1]] : [p[1], p[2]])).sort((a, b) => a - b);
      // Of n values the scale leaves out the top and bottom 1 in 100, and with fewer than 100 still the single highest: one
      // mistyped reading (a weight ten times too large) must not flatten the whole lane. A value beyond the scale is drawn at its edge.
      const q = (f) => vals[Math.min(vals.length - 1, Math.floor(f * (vals.length - 1)))];
      return { ...w, pts, clinic, doubted: (w.doubted ?? []).map((p) => ({ ...p, d: toDay(p.t) })), lo: w.draw === 'bars' ? 0 : q(0.01), hi: q(0.99) };
    }),
  };
}

// ---- drawing helpers
const line = (x1, y1, x2, y2, colour, w = 1) => { ctx.strokeStyle = colour; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
const rect = (x, y, w, h, colour) => { ctx.fillStyle = colour; ctx.fillRect(x, y, w, h); };
const dot = (x, y, r, colour, hollow) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); if (hollow) { ctx.strokeStyle = colour; ctx.lineWidth = 1.2; ctx.stroke(); } else { ctx.fillStyle = colour; ctx.fill(); } };
function label(text, x, y, colour = K.mid, opts = {}) {
  ctx.font = `${opts.bold ? '600 ' : ''}${opts.size ?? 11}px system-ui, sans-serif`;
  ctx.textAlign = opts.align ?? 'left'; ctx.textBaseline = opts.base ?? 'alphabetic'; ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  return ctx.measureText(text).width;
}
const width = (text, size = 11) => { ctx.font = `${size}px system-ui, sans-serif`; return ctx.measureText(text).width; };
const X = (d) => S.x(d);
const inPlot = (x) => x >= GUTTER - 1 && x <= S.left + S.width + 1;
const hit = (x, y, w, h, item, kind) => hits.push({ x, y, w, h, item, kind });
const isSel = (item) => selected && selected.item === item;
// A label is drawn only where it collides with none already placed in its row (first come, first kept: callers order by importance).
function placer() {
  const taken = [];
  return (text, x, y, colour, opts = {}) => {
    const w = width(text, opts.size ?? 11), x0 = opts.align === 'right' ? x - w : x;
    if (x0 < GUTTER + 2 || x0 + w > S.left + S.width + RIGHT - 4 || taken.some((t) => t.y === y && x0 < t.x1 + 6 && x0 + w > t.x0 - 6)) return false;
    taken.push({ y, x0, x1: x0 + w });
    label(text, x, y, colour, opts);
    return true;
  };
}

// ---- lanes: each draws itself between y and y + h and registers what can be hovered or clicked
function laneEncounters(y, h) {
  const base = y + h - 6, put = placer();
  const order = { inpatient: 0, emergency: 1, procedure: 2, visit: 3, hospital: 4, contact: 5 };
  for (const e of [...data.encounters].sort((a, b) => order[a.kind] - order[b.kind] || b.d - a.d)) {
    const x = X(e.d), c = isSel(e) ? K.sel : null;
    if (!inPlot(x)) continue;
    const ppd = S.pxPerDay(e.d);
    if (e.kind === 'contact') { dot(x, base, 1.3, c ?? K.pale); hit(x - 3, base - 4, 6, 8, e, 'Contact (no visit)'); continue; }
    const tall = { inpatient: h - 10, emergency: (h - 10) * 0.8, procedure: (h - 10) * 0.62, visit: (h - 10) * 0.42, hospital: (h - 10) * 0.42 }[e.kind];
    const w = e.kind === 'inpatient' ? Math.max(3, X(e.d2 ?? e.d) - x) : e.kind === 'procedure' ? 3 : e.kind === 'emergency' ? 2.5 : 1.5;
    rect(x - (e.kind === 'inpatient' ? 0 : w / 2), base - tall, w, tall, c ?? (e.kind === 'hospital' ? K.pale : e.kind === 'visit' ? K.mid : K.ink));
    hit(x - 3, base - tall, Math.max(6, w), tall, e, { inpatient: 'Inpatient stay', emergency: 'Emergency visit', procedure: 'Day procedure', visit: 'Visit', hospital: 'Hospital outpatient' }[e.kind]);
    if (ppd > 0.5 || e.kind === 'inpatient' || e.kind === 'emergency' || e.kind === 'procedure') put(e.label, x + 4, base - tall + 9, c ?? K.mid, { size: 10.5 });
  }
  line(GUTTER, base + 0.5, S.left + S.width, base + 0.5, K.faint);
}
function intervalRow(item, y, text, colour, strong) {
  const x1 = Math.max(GUTTER, X(item.d)), x2 = Math.min(S.left + S.width, X(item.d2 ?? data.today));
  if (x2 < GUTTER || x1 > S.left + S.width) return;
  const c = isSel(item) ? K.sel : colour;
  rect(x1, y + 8, Math.max(1.5, x2 - x1), strong ? 2.5 : 1.5, c);
  hit(x1, y, Math.max(8, x2 - x1), 12, item, 'Problem');
  return [x1, x2, c];
}
function laneProblems(y) {
  data.problems.forEach((p, i) => {
    const r = intervalRow(p, y + i * 13, p.label, K.mid, true);
    if (r) label(p.label, Math.min(Math.max(r[0], GUTTER) + 2, S.left + S.width - width(p.label, 10.5) - 2), y + i * 13 + 6, r[2] === K.sel ? K.sel : K.ink, { size: 10.5 });
  });
  const yy = y + data.problems.length * 13 + 8;
  for (const v of data.dx) { const x = X(v.d); if (inPlot(x)) { line(x, yy - 4, x, yy + 2, K.pale); hit(x - 2, yy - 6, 4, 10, v, 'Diagnosis at a visit'); } }
  label('coded at visits', GUTTER - 8, yy + 2, K.pale, { align: 'right', size: 10 });
}
function course(m, y, put) {
  const x1 = X(m.d), x2 = X(m.d2), c = isSel(m) ? K.sel : m.current ? K.ink : K.mid;
  if (x2 < GUTTER || x1 > S.left + S.width) return;
  const a = Math.max(GUTTER, x1), b = Math.min(S.left + S.width, x2);
  line(a, y + 12.5, Math.max(a + 1, b), y + 12.5, m.current ? K.mid : K.pale); // the span from first to last order
  for (const o of m.orders) { // each order: its own period thick, its start a tick
    const o1 = Math.max(GUTTER, X(toDay(o.t))), o2 = Math.min(S.left + S.width, X(toDay(o.end)));
    if (o2 >= GUTTER && o1 <= S.left + S.width) { rect(o1, y + 11, Math.max(1, o2 - o1), 2.5, c); line(o1, y + 9, o1, y + 15, c); }
  }
  hit(a, y, Math.max(8, b - a), 16, m, m.current ? 'Current medication' : 'Past medication');
  put(m.label, m.current ? Math.min(a + 2, S.left + S.width - width(m.label, 10.5) - 2) : a + 2, y + 7, m.current ? (c === K.sel ? K.sel : K.ink) : c, { size: 10.5 });
}
function laneMeds(y) {
  const put = placer();
  data.current.forEach((m, i) => course(m, y + i * 17, put));
  const y2 = y + data.current.length * 17 + 6;
  if (data.past.length) line(GUTTER, y2 - 2.5, S.left + S.width, y2 - 2.5, K.faint);
  for (const m of data.past) course(m, y2 + m.row * 17, put);
  label('current', GUTTER - 8, y + 14, K.pale, { align: 'right', size: 10 });
  if (data.past.length) label('past', GUTTER - 8, y2 + 14, K.pale, { align: 'right', size: 10 });
}
const points = (items, kind, shape) => (y, h) => {
  const put = placer(), mid = y + h - 9;
  for (const e of [...items].sort((a, b) => S.pxPerDay(b.d) - S.pxPerDay(a.d))) {
    const x = X(e.d), c = isSel(e) ? K.sel : e.future ? K.mid : K.ink;
    if (!inPlot(x)) continue;
    shape(x, mid, c, e);
    hit(x - 5, mid - 6, 10, 12, e, typeof kind === 'function' ? kind(e) : kind);
    put(e.label, x + 6, mid - 6, c === K.sel ? K.sel : K.mid, { size: 10.5 });
  }
};
const diamond = (x, y, c, e) => { ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); if (e.future) { ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.stroke(); } else { ctx.fillStyle = c; ctx.fill(); } };
const square = (x, y, c) => rect(x - 3, y - 3, 6, 6, c);
const tri = (x, y, c, e) => { ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y + 3); ctx.lineTo(x - 4, y + 3); ctx.closePath(); if (e.future) { ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.stroke(); } else { ctx.fillStyle = c; ctx.fill(); } };
function laneNotes(y, h) {
  const put = placer();
  const rows = [['Progress Notes', y + 8, 'progress'], [null, y + 22, 'other']];
  for (const [kind, yy, name] of rows) {
    label(name, GUTTER - 8, yy + 3, K.pale, { align: 'right', size: 10 });
    for (const n of data.notes.filter((n) => (kind ? n.kind === kind : n.kind !== 'Progress Notes')).sort((a, b) => S.pxPerDay(b.d) - S.pxPerDay(a.d))) {
      const x = X(n.d), c = isSel(n) ? K.sel : K.mid;
      if (!inPlot(x)) continue;
      line(x, yy - 4, x, yy + 4, c, 1.5);
      hit(x - 3, yy - 6, 6, 12, n, 'Note');
      if (S.pxPerDay(n.d) > 0.6) put(kind ? (n.sub ?? n.label) : n.label, x + 4, yy + 3, c === K.sel ? K.sel : K.pale, { size: 10 });
    }
  }
}
function sparkline(s) {
  return (y, h) => {
    const vals = s.pts.flatMap((p) => [p.v, p.lo, p.hi]).filter((v) => v != null);
    const lo = Math.min(...vals), hi = Math.max(...vals), Y = (v) => y + h - 5 - ((v - lo) / (hi - lo || 1)) * (h - 10);
    const last = s.pts.at(-1);
    if (last.lo != null || last.hi != null) { // the reference range of the latest result, as a band behind the line
      const top = Y(last.hi ?? hi), bottom = Y(last.lo ?? lo);
      const from = Math.max(GUTTER, X(s.pts[0].d) - 6);
      rect(from, top, Math.max(1, X(data.today) - from), Math.max(1, bottom - top), K.band);
    }
    ctx.strokeStyle = K.mid; ctx.lineWidth = 1; ctx.beginPath();
    s.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.d), Y(p.v)) : ctx.moveTo(X(p.d), Y(p.v))));
    ctx.stroke();
    for (const p of s.pts) {
      const x = X(p.d), yy = Y(p.v), sel = selected?.item === s;
      dot(x, yy, p.flag ? 2.6 : 1.8, p.flag ? K.alert : sel ? K.sel : K.ink);
      hit(x - 4, y, 8, h, { ...p, series: s }, 'Lab');
    }
    label(`${last.v}${s.unit ? ` ${s.unit}` : ''}`, S.left + S.width + 8, y + h / 2 + 4, last.flag ? K.alert : K.ink, { size: 11 });
  };
}
function laneLabTicks(y) {
  for (const d of data.labTicks) { const x = X(d); if (inPlot(x)) line(x, y + 4, x, y + 10, K.pale); }
  hit(GUTTER, y, S.width, 16, {}, 'labs');
}
const CLINIC_DOT = 1.5; // radius of a ringed clinic reading: small, so a crowded month of readings stays legible
function wearable(w) {
  return (y, h) => {
    const x0 = Math.ceil(GUTTER), n = Math.floor(S.left + S.width) - x0 + 1;
    const Y = (v) => y + h - 4 - Math.max(0, Math.min(1, (v - w.lo) / (w.hi - w.lo || 1))) * (h - 8);
    // One bin per pixel: its lowest, highest and mean reading. Where a day is wider than a pixel a bin is a single reading.
    const lo = new Float64Array(n).fill(Infinity), hi = new Float64Array(n).fill(-Infinity), sum = new Float64Array(n), cnt = new Uint32Array(n);
    const lo2 = new Float64Array(n).fill(Infinity), hi2 = new Float64Array(n).fill(-Infinity), sum2 = new Float64Array(n);
    for (const p of w.pts) {
      const i = Math.round(X(p[0])) - x0;
      if (i < 0 || i >= n) continue;
      if (p[1] < lo[i]) lo[i] = p[1]; if (p[1] > hi[i]) hi[i] = p[1]; sum[i] += p[1]; cnt[i]++;
      if (p[2] != null) { if (p[2] < lo2[i]) lo2[i] = p[2]; if (p[2] > hi2[i]) hi2[i] = p[2]; sum2[i] += p[2]; }
    }
    w.bins = { x0, lo, hi, sum, cnt, sum2 };
    ctx.lineWidth = 1;
    let lastX, lastY, lastY2, latest;
    for (let i = 0; i < n; i++) {
      if (!cnt[i]) continue;
      const x = x0 + i + 0.5, m = sum[i] / cnt[i];
      latest = i;
      if (w.draw === 'bars') { rect(x0 + i, Y(m), 1, y + h - 4 - Y(m), K.mid); continue; }
      if (w.draw === 'range') { // blood pressure: systolic and diastolic means joined by a pale stroke, extremes paler still
        const m2 = sum2[i] / cnt[i];
        line(x, Y(hi[i]), x, Y(lo2[i]), K.faint);
        line(x, Y(m), x, Y(m2), K.pale);
        rect(x - 0.5, Y(m) - 0.5, 1.5, 1.5, K.ink); rect(x - 0.5, Y(m2) - 0.5, 1.5, 1.5, K.ink);
        continue;
      }
      if (hi[i] > lo[i]) line(x, Y(hi[i]), x, Y(lo[i]), K.pale);
      if (lastX !== undefined && x - lastX < 40) line(lastX, lastY, x, Y(m), K.ink);
      else rect(x - 0.5, Y(m) - 0.5, 1.5, 1.5, K.ink);
      lastX = x; lastY = Y(m);
    }
    for (const p of w.clinic) { // clinic readings: ringed, never merged with home readings
      const x = X(p[0]);
      if (!inPlot(x)) continue;
      dot(x, Y(p[1]), CLINIC_DOT, K.ink, true);
      if (p[2] != null) dot(x, Y(p[2]), CLINIC_DOT, K.ink, true);
      hit(x - 4, y, 8, h, { d: p[0], id: p[3], label: w.computed ? w.label : `${w.label} (clinic)`, note: w.computed, value: p[2] == null ? `${p[1]} ${w.unit}` : `${p[1]}/${p[2]} ${w.unit}` }, 'Clinic reading');
    }
    for (const p of w.doubted) { // a computed point set aside as a probable error: a small red question mark, at mid-lane (its value is not to be read)
      const x = X(p.d);
      if (!inPlot(x)) continue;
      label('?', x, y + h / 2 + 3, K.alert, { size: 10, bold: true, align: 'center' });
      hit(x - 4, y, 8, h, { d: p.d, id: p.id, label: `${w.label}: not shown`, note: w.computed, value: `probably an error: ${p.why}` }, 'Clinic reading');
    }
    if (latest !== undefined) {
      const m = sum[latest] / cnt[latest], text = w.draw === 'range' ? `${Math.round(m)}/${Math.round(sum2[latest] / cnt[latest])}` : w.key === 'steps' ? Math.round(m).toLocaleString() : String(Math.round(m * 10) / 10);
      label(`${text}${w.unit ? ` ${w.unit}` : ''}`, S.left + S.width + 8, Math.min(y + h - 4, Math.max(y + 10, Y(m) + 4)), K.ink, { size: 11 });
    }
    hit(GUTTER, y, S.width, h, w, 'wearable');
  };
}

function buildLanes() {
  const fut = data.planned.map((p) => ({ ...p, future: true }));
  const procs = [...data.procedures, ...fut.filter((p) => p.kind !== 'vaccine')], vax = [...data.immunizations, ...fut.filter((p) => p.kind === 'vaccine')];
  const medH = data.current.length * 17 + (data.past.length ? 6 + data.pastRows * 17 : 0) + 6;
  lanes = [
    { name: 'Encounters', h: 50, draw: laneEncounters },
    { name: 'Problems', h: data.problems.length * 13 + 20, draw: laneProblems },
    { name: 'Medications', h: medH, draw: laneMeds },
    { name: 'Procedures', h: 30, draw: points(procs, (e) => (e.future ? 'Due' : 'Procedure'), diamond) },
    { name: 'Studies', h: 30, draw: points(data.studies, (e) => ({ echo: 'Echocardiogram', ecg: 'ECG', imaging: 'Imaging', pathology: 'Pathology', microbiology: 'Microbiology', cardiac: 'Cardiology study', neurology: 'Neurology study' }[e.kind] ?? 'Report'), (x, y, c) => square(x, y, c)) },
    { name: 'Immunizations', h: 28, draw: points(vax, (e) => (e.future ? 'Vaccine due' : 'Immunization'), tri) },
    { name: 'Notes', h: 34, draw: laneNotes },
    ...data.labs.map((s, i) => ({ name: i ? '' : 'Labs', row: s.label, h: 26, draw: sparkline(s) })),
    { name: data.labs.length ? '' : 'Labs', row: `${data.restLabs.length} other tests`, h: 16, draw: laneLabTicks },
    ...data.wearables.map((w, i) => ({ name: i ? '' : 'Measurements', row: w.label, h: 34, draw: wearable(w) })),
  ];
  // The dates again above a long section: the axis at the top scrolls out of view on a record with many rows. A section (a named
  // lane and the unnamed rows under it) gets one when it is tall and the last axis is far above it.
  const out = [];
  let since = 0; // height drawn since the last axis
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i].name) {
      let h = 0;
      for (let j = i; j < lanes.length && (j === i || !lanes[j].name); j++) h += lanes[j].h + 2;
      if (h >= DATES_SECTION && since >= DATES_APART) { out.push({ name: '', h: 26, draw: laneDates }); since = 0; }
    }
    out.push(lanes[i]);
    since += lanes[i].h + (lanes[i].name ? 12 : 2);
  }
  lanes = out;
}
const DATES_SECTION = 150, DATES_APART = 250; // px: how tall a section, and how far below the last axis, before the dates are repeated
function laneDates(y, h) {
  const a = GUTTER, b = S.left + S.width, base = y + h - 2, put = placer();
  for (const t of ticks(S)) {
    const x = Math.round(X(t.t)) + 0.5;
    if (x < a - 1 || x > b + 1) continue;
    line(x, t.major ? base - 20 : t.unit === 'month' ? base - 9 : base - 5, x, base, t.major ? K.mid : K.pale);
    if (t.label) put(t.label, x + 3, t.major ? base - 12 : base - 2, t.major ? K.ink : K.mid, { size: t.major ? 11 : 10 });
  }
  line(a, base + 0.5, b, base + 0.5, K.pale);
}

// ---- the axis: a true-scale strip, then ticks at their true positions (their spacing is the scale)
function drawAxis() {
  const a = GUTTER, b = S.left + S.width, y = 8;
  const lin = (d) => a + ((d - data.min) / (data.max - data.min)) * (b - a);
  rect(a, y, b - a, 5, K.band);
  for (let yr = fromDay(data.min).getUTCFullYear() + 1; yr <= fromDay(data.max).getUTCFullYear(); yr++) { const x = lin(Date.UTC(yr, 0, 1) / 864e5); line(x, y, x, y + 5, K.bg); }
  rect(lin(S.focus - S.c), y - 2, Math.max(2, lin(S.focus + S.c) - lin(S.focus - S.c)), 9, K.sel);
  label('true scale', a - 8, y + 6, K.pale, { align: 'right', size: 10 });
  hit(a, 0, b - a, 18, { strip: lin }, 'strip');
  const put = placer();
  for (const t of ticks(S)) {
    const x = Math.round(X(t.t)) + 0.5;
    if (x < a - 1 || x > b + 1) continue;
    line(x, t.major ? AXIS - 22 : t.unit === 'month' ? AXIS - 9 : AXIS - 5, x, AXIS, t.major ? K.mid : K.pale);
    if (t.label) put(t.label, x + 3, t.major ? AXIS - 14 : AXIS - 2, t.major ? K.ink : K.mid, { size: t.major ? 11 : 10 });
  }
  line(a, AXIS + 0.5, b, AXIS + 0.5, K.pale);
}

function render() {
  const cssW = canvas.parentElement.clientWidth, dpr = window.devicePixelRatio || 1;
  const total = AXIS + lanes.reduce((n, l) => n + l.h + (l.name ? 12 : 2), 0) + 10;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(total * dpr)) { canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(total * dpr); canvas.style.height = `${total}px`; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, total);
  S = fisheye({ min: data.min, max: data.max, focus: state.focus, c: state.c, left: GUTTER, width: Math.max(200, cssW - GUTTER - RIGHT), linear: state.linear });
  state.focus = S.focus;
  hits = [];
  drawAxis();
  // year rules and the focus and today hairlines run through every lane
  for (const t of ticks(S)) if (t.major) { const x = Math.round(X(t.t)) + 0.5; if (inPlot(x)) line(x, AXIS, x, total, K.faint); }
  const xt = Math.round(X(data.today)) + 0.5;
  line(xt, AXIS - 6, xt, total, K.pale);
  label('today', xt + 3, total - 2, K.pale, { size: 10 });
  let y = AXIS;
  for (const l of lanes) {
    y += l.name ? 12 : 2;
    if (l.name) { line(GUTTER, y - 6.5, S.left + S.width, y - 6.5, K.faint); label(l.name.toUpperCase(), 14, y + 9, K.ink, { size: 10.5, bold: true }); if (l.sub) label(l.sub, 14, y + 21, K.pale, { size: 9.5 }); }
    if (l.row) label(l.row.length > 19 ? `${l.row.slice(0, 18)}…` : l.row, GUTTER - 8, y + l.h / 2 + 4, K.mid, { align: 'right', size: 10.5 });
    ctx.save(); ctx.beginPath(); ctx.rect(GUTTER - 2, y - 4, cssW - GUTTER + 2, l.h + 6); ctx.clip();
    l.y = y; l.draw(y, l.h);
    ctx.restore();
    y += l.h;
  }
  const xf = Math.round(X(S.focus)) + 0.5;
  if (!state.linear && Math.abs(xf - xt) > 2) line(xf, AXIS - 6, xf, total, K.sel, 0.75);
  if (hover) line(Math.round(hover.x) + 0.5, AXIS, Math.round(hover.x) + 0.5, total, K.pale, 0.5);
  $('readout').textContent = `${fmt(data.min, false)} – ${fmt(data.max, false)} · focus ${fmt(S.focus)} ± ${state.c >= 365 ? `${(state.c / 365).toFixed(1)} years` : `${Math.round(state.c)} days`}${hover ? ` · ${fmt(S.invert(hover.x))}: ${perPixel(S.pxPerDay(S.invert(hover.x)))}` : ''}`;
  clearTimeout(render.hash); // the address keeps the view, written once the view rests
  render.hash = setTimeout(() => history.replaceState(null, '', `#${fromDay(S.focus).toISOString().slice(0, 10)}/${Math.round(state.c)}${state.linear ? '/linear' : ''}`), 300);
}
let queued = false;
const draw = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; render(); }); } };

// ---- hover and detail
const LANE = new Set(['wearable', 'labs']);
function find(x, y) {
  let best;
  for (const h of hits) {
    if (LANE.has(h.kind) || x < h.x - 2 || x > h.x + h.w + 2 || y < h.y - 1 || y > h.y + h.h + 1) continue;
    const dist = Math.abs(x - (h.x + Math.min(h.w, 8) / 2));
    if (!best || h.w < best.w || (h.w === best.w && dist < best.dist)) best = { ...h, dist };
  }
  return best ?? hits.find((h) => LANE.has(h.kind) && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
}
function tipFor(h, x) {
  const it = h.item;
  if (h.kind === 'strip') return `<span class="d">Click to move the focus here</span>`;
  if (h.kind === 'labs') return `<span class="d">Click for every test, with its latest result</span>`;
  if (h.kind === 'wearable') {
    const b = it.bins, i = Math.round(x) - b.x0;
    if (!b.cnt[i]) return '';
    const m = b.sum[i] / b.cnt[i], v = it.draw === 'range' ? `${Math.round(m)}/${Math.round(b.sum2[i] / b.cnt[i])}` : Math.round(m * 10) / 10;
    return `<b>${esc(it.label)}</b> ${v.toLocaleString()} ${esc(it.unit)}<br><span class="d">${fmt(S.invert(x))} · ${b.cnt[i] > 1 ? `mean of ${b.cnt[i]} readings (${Math.round(b.lo[i] * 10) / 10}–${Math.round(b.hi[i] * 10) / 10})` : 'one reading'}</span>`;
  }
  if (h.kind === 'Lab') return `<b>${esc(it.series.label)}</b> <span class="${it.flag ? 'a' : ''}">${it.v} ${esc(it.series.unit ?? '')}${it.flag ? ` (${it.flag})` : ''}</span><br><span class="d">${fmt(it.d)}${it.lo != null || it.hi != null ? ` · range ${it.lo ?? ''}–${it.hi ?? ''}` : ''}</span>`;
  if (h.kind === 'Diagnosis at a visit') return `<b>${esc(it.label)}</b><br><span class="d">${fmt(it.d)} · coded at ${it.n} visit${it.n > 1 ? 's' : ''}</span>`;
  if (h.kind === 'Clinic reading') return `<b>${esc(it.label)}</b> ${esc(it.value)}<br><span class="d">${fmt(it.d)}${it.note ? ` · ${esc(it.note)}` : ''}</span>`;
  if (it.orders) return `<b>${esc(it.label)}</b><br><span class="d">${h.kind} · ${fmt(it.d, false)} – ${it.current ? 'now' : fmt(it.d2, false)} · ${it.orders.length} order${it.orders.length > 1 ? 's' : ''}</span>`;
  return `<b>${esc(it.label)}</b>${it.sub ? ` · ${esc(it.sub)}` : ''}<br><span class="d">${h.kind} · ${fmt(it.d)}${it.d2 && !it.orders && h.kind !== 'Problem' ? ` – ${fmt(it.d2)}` : h.kind === 'Problem' && !it.d2 ? ' – now' : ''}${it.also?.length ? ` · also recorded as ${esc(it.also.join(', '))}` : ''}</span>`;
}
// ---- the side panel. The server describes a record, a series, a drug, a diagnosis or a list as a title, facts and sections;
// a section is text to read, a table (cells may link on), or numbers over time, drawn on plain linear time.
const PLANNED_KIND = 'Due';
const trail = [];
const cellHtml = (c) => (typeof c === 'string' ? esc(c) : c.q ? `<a href="#" data-q="${esc(c.q)}">${esc(c.v)}</a>` : `<span class="${c.alert ? 'a' : ''}">${esc(c.v)}</span>`);
const rowsHtml = (rows) => rows.map((r) => `<tr>${r.map((c) => `<td>${cellHtml(c)}</td>`).join('')}</tr>`).join('');
function tableHtml(s) {
  const head = s.head ? `<tr>${s.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` : '';
  const first = s.rows.slice(0, 40), rest = s.rows.slice(40);
  return `<table>${head}${rowsHtml(first)}</table>${rest.length ? `<details><summary>${rest.length} more</summary><table>${head}${rowsHtml(rest)}</table></details>` : ''}`;
}
function chart(s) {
  const W = 380, H = 130, L = 40, R = 10, T = 10, B = 18;
  const pts = s.points.map((p) => ({ d: toDay(p[0]), t: p[0].slice(0, 10), v: p[1], lo: p[2], hi: p[3], flag: p[4] }));
  const last = pts.at(-1), vals = pts.flatMap((p) => p.v).concat(last.lo ?? [], last.hi ?? []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const d0 = pts[0].d, d1 = Math.max(last.d, d0 + 1);
  const x = (d) => (L + ((d - d0) / (d1 - d0)) * (W - L - R)).toFixed(1), y = (v) => (T + (1 - (v - lo) / (hi - lo)) * (H - T - B)).toFixed(1);
  let g = '';
  if (last.lo != null || last.hi != null) g += `<rect class="band" x="${L}" y="${y(last.hi ?? hi)}" width="${W - L - R}" height="${Math.max(1, y(last.lo ?? lo) - y(last.hi ?? hi))}"><title>usual range ${last.lo ?? ''}–${last.hi ?? ''}</title></rect>`;
  for (let yr = fromDay(d0).getUTCFullYear() + 1; yr <= fromDay(d1).getUTCFullYear(); yr++) { const xx = x(Date.UTC(yr, 0, 1) / 864e5); g += `<line class="yr" x1="${xx}" x2="${xx}" y1="${T}" y2="${H - B}"/>`; }
  s.names.forEach((_, i) => { if (pts.length > 1) g += `<polyline class="ln" points="${pts.map((p) => `${x(p.d)},${y(p.v[i])}`).join(' ')}"/>`; });
  if (pts.length <= 200) s.names.forEach((n, i) => { for (const p of pts) g += `<circle class="${p.flag && !i ? 'al' : 'pt'}" cx="${x(p.d)}" cy="${y(p.v[i])}" r="${p.flag && !i ? 2.8 : 2}"><title>${esc(p.t)}: ${n ? `${esc(n)} ` : ''}${p.v[i]} ${esc(s.unit)}${p.flag && !i ? ` (${p.flag})` : ''}</title></circle>`; });
  const r = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  g += `<text x="${L - 5}" y="${T + 8}" text-anchor="end">${r(hi)}</text><text x="${L - 5}" y="${H - B}" text-anchor="end">${r(lo)}</text>`;
  g += `<text x="${L}" y="${H - 4}">${pts[0].t.slice(0, 7)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${last.t.slice(0, 7)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.title)} over time">${g}</svg><div class="d">${pts.length} point${pts.length > 1 ? 's' : ''}${s.unit ? ` · ${esc(s.unit)}` : ''}${last.lo != null || last.hi != null ? ' · band: usual range of the latest result' : ''} · plain time, not the fisheye</div>`;
}
function renderDetail(d) {
  let html = `${trail.length > 1 ? '<button id="back">‹ Back</button>' : ''}<h2>${esc(d.title)}</h2>`;
  html += `<div class="d">${esc(d.kind)}${d.when ? ` · ${esc(d.when)}` : ''}${d.t ? ` · <a href="#" data-go="${esc(d.t.slice(0, 10))}">show on the timeline</a>` : ''}</div>`;
  if (d.flags?.length) html += `<div class="flag">${esc(d.flags.join(' · '))}</div>`;
  if (d.facts.length) html += `<table class="facts">${d.facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
  for (const s of d.sections) {
    html += `<h3>${esc(s.title)}</h3>${s.note ? `<div class="d">${esc(s.note)}</div>` : ''}`;
    html += s.type === 'text' ? `<pre>${esc(s.text)}</pre>` : s.type === 'series' ? chart(s) : tableHtml(s);
  }
  detail.innerHTML = html;
  panel.hidden = false;
  panel.scrollTop = 0;
}
// q is "kind=value": ref (a record), series (a test or measure over time), course (a drug), dx (a diagnosis), list
async function show(q, fresh) {
  if (fresh) trail.length = 0;
  if (trail.at(-1) !== q) trail.push(q);
  const i = q.indexOf('=');
  panel.hidden = false;
  try {
    const res = await fetch(`/api/detail?${q.slice(0, i)}=${encodeURIComponent(q.slice(i + 1))}`);
    if (trail.at(-1) !== q) return; // a later click won
    if (!res.ok) throw new Error(await res.text());
    renderDetail(await res.json());
  } catch (e) { detail.innerHTML = `<h2>Not available</h2><div class="d">${esc(e.message || 'GA could not read this record.')}</div>`; }
  draw();
}
function queryOf(h) {
  const it = h.item;
  if (h.kind === 'Lab') return `series=${it.series.key}`;
  if (h.kind === 'wearable') return it.series && `series=${it.series}`;
  if (h.kind === 'labs') return 'list=Lab tests';
  if (h.kind === 'Clinic reading') return it.id && `ref=Observation/${it.id}`;
  if (it.orders) return `course=${it.label}`;
  if (h.kind === 'Diagnosis at a visit') return `dx=${it.label}`;
  return it.ref && `ref=${it.ref}`;
}
function open(h) {
  if (h.kind === 'strip') return;
  const it = h.kind === 'Lab' ? h.item.series : h.item, q = queryOf(h);
  selected = { item: it };
  if (q) return show(q, true);
  // something due has no record yet: what health maintenance says about it
  trail.length = 0;
  renderDetail({ title: it.label, kind: h.kind, when: it.t, facts: it.rows ?? [], sections: [] });
  draw();
}
const close = () => { panel.hidden = true; selected = undefined; trail.length = 0; draw(); };
detail.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-q], a[data-go], #back');
  if (!a) return;
  e.preventDefault();
  if (a.id === 'back') { trail.pop(); show(trail.at(-1)); } else if (a.dataset.go) glide(toDay(a.dataset.go)); else show(a.dataset.q);
});

// ---- interaction
function glide(to) {
  const from = state.focus, t0 = performance.now();
  const step = (now) => { const k = Math.min(1, (now - t0) / 300), e = 1 - (1 - k) ** 3; state.focus = from + (to - from) * e; render(); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const zoom = (f) => { state.c = Math.min(1500, Math.max(7, state.c * f)); draw(); };
let drag;
const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
canvas.addEventListener('pointerdown', (e) => { const p = pos(e); drag = { x: p.x, focus: state.focus, moved: false, ppd: S.pxPerDay(S.focus) }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  const p = pos(e);
  if (drag) {
    if (Math.abs(p.x - drag.x) > 3) drag.moved = true;
    if (drag.moved) { canvas.classList.add('drag'); tip.hidden = true; state.focus = drag.focus - (p.x - drag.x) / drag.ppd; draw(); }
    return;
  }
  hover = p.x >= GUTTER && p.x <= S.left + S.width ? p : undefined;
  const h = find(p.x, p.y), html = h ? tipFor(h, p.x) : '';
  tip.hidden = !html;
  if (html) { tip.innerHTML = html; tip.style.left = `${Math.min(p.x + 14, canvas.clientWidth - 330)}px`; tip.style.top = `${p.y + 16}px`; }
  canvas.style.cursor = h ? 'pointer' : '';
  draw();
});
canvas.addEventListener('pointerup', (e) => {
  const d = drag; drag = undefined; canvas.classList.remove('drag');
  if (d?.moved) return;
  tip.hidden = true;
  const p = pos(e), h = find(p.x, p.y);
  if (h?.kind === 'strip') { const lin = h.item.strip; glide(data.min + ((p.x - GUTTER) / (lin(data.max) - GUTTER)) * (data.max - data.min)); } else if (h) open(h);
});
canvas.addEventListener('pointerleave', () => { hover = undefined; tip.hidden = true; draw(); });
canvas.addEventListener('dblclick', (e) => { const p = pos(e); if (p.x > GUTTER && !find(p.x, p.y)) glide(S.invert(p.x)); });
canvas.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.01)); } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); state.focus += e.deltaX / S.pxPerDay(S.focus); draw(); }
}, { passive: false });
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (k === 'ArrowLeft') state.focus -= state.c / 4; else if (k === 'ArrowRight') state.focus += state.c / 4;
  else if (k === 'PageUp') state.focus -= 365; else if (k === 'PageDown') state.focus += 365;
  else if (k === '[' || k === '-') return zoom(1.4); else if (k === ']' || k === '+' || k === '=') return zoom(1 / 1.4);
  else if (k === 't' || k === 'T') return glide(data.today);
  else if (k === 'l' || k === 'L') { state.linear = !state.linear; $('linear').checked = state.linear; } else if (k === 'Escape') return close();
  else return;
  e.preventDefault(); draw();
});
$('today').onclick = () => glide(data.today);
$('out').onclick = () => zoom(1.4);
$('in').onclick = () => zoom(1 / 1.4);
$('linear').onchange = (e) => { state.linear = e.target.checked; draw(); };
$('close').onclick = close;
$('wide').onclick = () => panel.classList.toggle('wide');
$('all').onclick = () => { selected = undefined; show('list=index', true); };
addEventListener('resize', draw);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colours(); draw(); });

// ---- start
colours();
try {
  const res = await fetch('/api/timeline');
  if (!res.ok) throw new Error(await res.text());
  data = prepare(await res.json());
  const [f, c, lin] = location.hash.slice(1).split('/');
  state.focus = /^\d{4}-\d\d-\d\d$/.test(f ?? '') ? toDay(f) : data.today;
  state.c = Number(c) >= 7 ? Number(c) : 60;
  state.linear = lin === 'linear'; $('linear').checked = state.linear;
  buildLanes();
  $('key').textContent = 'Encounters: height is acuity (full bar an inpatient stay, then emergency, day procedure, visit; a dot is a refill, order or call) · hollow marks are due, not done · ringed points are clinic readings · the coloured dot is a result outside its range';
  $('left').innerHTML = Object.entries(data.left).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li>${n.toLocaleString()} ${esc(k)}</li>`).join('') || '<li>nothing</li>';
  render();
} catch (e) {
  document.querySelector('main').textContent = e.message || 'GA could not read the record.';
}
