import { GaError } from '../config.ts';
import type { EhiCtx } from './ids.ts';

const pad = (n: string) => n.padStart(2, '0');

// EHI dates are `M/D/YYYY h:mm:ss AM|PM` without a zone. Date-only fields are always exactly midnight: a FHIR date.
// A real time gets the export's UTC offset (from ctx.date), since a FHIR dateTime with a time needs a zone.
// shortcut: one offset for every value, ignores DST changes between the value and the export; upgrade with a tz database.
export function ehiDate(s: string, ctx: EhiCtx): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(s);
  if (!m) throw new GaError('unexpected EHI date format'); // no value in the message: it is PHI
  const [, mo, d, y, h, mi, se, ap] = m;
  const day = `${y}-${pad(mo)}-${pad(d)}`;
  if (h === '12' && mi === '00' && se === '00' && ap === 'AM') return day;
  const hh = (Number(h) % 12) + (ap === 'PM' ? 12 : 0);
  const zone = /(Z|[+-]\d{2}:\d{2})$/.exec(ctx.date)?.[1] ?? 'Z';
  return `${day}T${String(hh).padStart(2, '0')}:${mi}:${se}${zone}`;
}
