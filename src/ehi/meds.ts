import type { MedicationRequest, Resource } from '@medplum/fhirtypes';
import { ehiDate } from './dates.ts';
import { type EhiCtx, ehiId, encounterRef, epicId, localId, PATIENT_REF } from './ids.ts';
import type { EhiTables, Row } from './read.ts';

function status(r: Row, ctx: EhiCtx): MedicationRequest['status'] {
  if (r.DISCON_TIME || r.RSN_FOR_DISCON_C_NAME) return 'stopped';
  const end = ehiDate(r.END_DATE, ctx);
  if (end && end.slice(0, 10) <= ctx.date.slice(0, 10)) return 'completed';
  if (/sent|verified|dispensed|active/i.test(r.ORDER_STATUS_C_NAME ?? '')) return 'active';
  return 'unknown';
}

// ORDER_MED -> MedicationRequest, linked to the C-CDA's copy by order id.
export function* mapMeds(t: EhiTables, ctx: EhiCtx): Generator<Resource> {
  const enc = encounterRef(t);
  for (const r of t.rows('ORDER_MED')) {
    const id = r.ORDER_MED_ID;
    const name = r.MEDICATION_ID_MEDICATION_NAME || r.DESCRIPTION;
    const encounter = enc(r.PAT_ENC_CSN_ID);
    const authoredOn = ehiDate(r.ORDERING_DATE, ctx);
    const prescriber = r.MED_PRESC_PROV_ID_PROV_NAME || r.AUTHRZING_PROV_ID_PROV_NAME;
    yield {
      resourceType: 'MedicationRequest',
      id: localId('ORDER_MED', id),
      identifier: [ehiId(ctx, 'ORDER_MED', id), ...epicId(ctx, 'order', id)],
      status: status(r, ctx),
      intent: 'order',
      ...(/historic/i.test(r.ORDER_CLASS_C_NAME ?? '') && { reportedBoolean: true }),
      ...(name && { medicationCodeableConcept: { text: name } }),
      subject: PATIENT_REF,
      ...(encounter && { encounter }),
      ...(authoredOn && { authoredOn }),
      ...(prescriber && { requester: { display: prescriber } }),
    } as MedicationRequest;
  }
}
