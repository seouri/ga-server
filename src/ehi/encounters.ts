import type { Encounter, Resource } from '@medplum/fhirtypes';
import { ehiDate } from './dates.ts';
import { type EhiCtx, ehiId, epicId, localId, PATIENT_REF } from './ids.ts';
import type { EhiTables } from './read.ts';

function status(appt: string): Encounter['status'] {
  if (/complete/i.test(appt)) return 'finished';
  if (/cancel|no show|left without/i.test(appt)) return 'cancelled';
  if (/erroneous/i.test(appt)) return 'entered-in-error';
  return 'unknown';
}

// No class: the export has none. resolveUnlinked sets UNK on new Encounters; linked ones keep the C-CDA class.
export function mapEncounters(t: EhiTables, ctx: EhiCtx): Resource[] {
  return t.rows('PAT_ENC').map((r) => {
    const csn = r.PAT_ENC_CSN_ID;
    const start = ehiDate(r.CONTACT_DATE, ctx);
    return ({
      resourceType: 'Encounter',
      id: localId('PAT_ENC', csn),
      identifier: [ehiId(ctx, 'PAT_ENC', csn), ...epicId(ctx, 'csn', csn)],
      status: status(r.APPT_STATUS_C_NAME || r.CALCULATED_ENC_STAT_C_NAME), // most visits have no appointment status
      subject: PATIENT_REF,
      ...(start && { period: { start } }),
      ...(r.VISIT_PROV_ID_PROV_NAME && { participant: [{ individual: { display: r.VISIT_PROV_ID_PROV_NAME } }] }),
    }) as Encounter;
  });
}
