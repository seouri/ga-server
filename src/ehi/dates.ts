import { GaError } from '../config.ts';
import type { EhiCtx } from './ids.ts';

const pad = (n: string) => n.padStart(2, '0');

// Minutes east of UTC that `timeZone` had at instant `ms` (Intl's built-in tz data).
function offsetAt(timeZone: string, ms: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000);
}

// EHI dates are `M/D/YYYY h:mm:ss AM|PM` without a zone. Date-only fields are always exactly midnight: a FHIR date.
// A real time is local to the exporting site (ctx.timeZone) and gets the UTC offset in force on its own date (R17: DST).
// A local time skipped or repeated at a DST change resolves to one of its candidate offsets.
export function ehiDate(s: string, ctx: EhiCtx): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(s);
  if (!m) throw new GaError('unexpected EHI date format'); // no value in the message: it is PHI
  const [, mo, d, y, h, mi, se, ap] = m;
  const day = `${y}-${pad(mo)}-${pad(d)}`;
  if (h === '12' && mi === '00' && se === '00' && ap === 'AM') return day;
  const hh = (Number(h) % 12) + (ap === 'PM' ? 12 : 0);
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), hh, Number(mi), Number(se));
  const off = offsetAt(ctx.timeZone, local - offsetAt(ctx.timeZone, local) * 60000);
  const abs = Math.abs(off);
  const zone = off === 0 ? 'Z' : `${off < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${day}T${String(hh).padStart(2, '0')}:${mi}:${se}${zone}`;
}
