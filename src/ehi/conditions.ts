import type { CodeableConcept, Condition, Resource } from '@medplum/fhirtypes';
import { ehiDate } from './dates.ts';
import { type EhiCtx, ehiId, encounterRef, epicId, localId, PATIENT_REF } from './ids.ts';
import type { EhiTables } from './read.ts';

const cc = (system: string, code: string): CodeableConcept => ({ coding: [{ system, code }] });
const category = (code: string) => [cc('http://terminology.hl7.org/CodeSystem/condition-category', code)];
const clinical = (code: string) => cc('http://terminology.hl7.org/CodeSystem/condition-clinical', code);

export function* mapConditions(t: EhiTables, ctx: EhiCtx): Generator<Resource> {
  // PAT_ENC_DX has only DX_ID; its only name source in the export is the linked problem (DX_LINK_PROB_ID).
  const nameOf = new Map<string, string>();
  for (const p of t.rows('PROBLEM_LIST')) if (p.DESCRIPTION) nameOf.set(p.PROBLEM_LIST_ID, p.DESCRIPTION);
  const enc = encounterRef(t);
  for (const r of t.rows('PAT_ENC_DX')) {
    const pk = `${r.PAT_ENC_CSN_ID}-${r.LINE}`;
    const name = nameOf.get(r.DX_LINK_PROB_ID);
    const recordedDate = ehiDate(r.CONTACT_DATE, ctx);
    const encounter = enc(r.PAT_ENC_CSN_ID);
    yield {
      resourceType: 'Condition',
      id: localId('PAT_ENC_DX', pk),
      // R12: the visit diagnosis's own Epic id; C-CDA visit diagnoses carry it.
      identifier: [ehiId(ctx, 'PAT_ENC_DX', pk), ...(r.DX_ID ? epicId(ctx, 'dx', `${r.PAT_ENC_CSN_ID}-${r.DX_ID}`) : [])],
      category: category('encounter-diagnosis'),
      ...(name && { code: { text: name } }),
      subject: PATIENT_REF,
      ...(encounter && { encounter }),
      ...(recordedDate && { recordedDate }),
    } as Condition;
  }
  for (const r of t.rows('PROBLEM_LIST')) {
    const id = r.PROBLEM_LIST_ID;
    const st = r.PROBLEM_STATUS_C_NAME;
    const onsetDateTime = ehiDate(r.NOTED_DATE, ctx);
    const abatementDateTime = ehiDate(r.RESOLVED_DATE, ctx);
    const recordedDate = ehiDate(r.DATE_OF_ENTRY, ctx);
    const deleted = /deleted/i.test(st);
    const resolved = !deleted && (/resolved/i.test(st) || !!abatementDateTime);
    yield {
      resourceType: 'Condition',
      id: localId('PROBLEM_LIST', id),
      identifier: [ehiId(ctx, 'PROBLEM_LIST', id), ...epicId(ctx, 'problem', id)],
      category: category('problem-list-item'),
      ...(resolved ? { clinicalStatus: clinical('resolved') } : /^active$/i.test(st) ? { clinicalStatus: clinical('active') } : {}),
      ...(deleted && { verificationStatus: cc('http://terminology.hl7.org/CodeSystem/condition-ver-status', 'entered-in-error') }),
      ...(r.DESCRIPTION && { code: { text: r.DESCRIPTION } }),
      subject: PATIENT_REF,
      ...(onsetDateTime && { onsetDateTime }),
      ...(abatementDateTime && !deleted && { abatementDateTime }),
      ...(recordedDate && { recordedDate }),
    } as Condition;
  }
}
