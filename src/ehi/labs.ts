import type { MedplumClient } from '@medplum/core';
import type { DiagnosticReport, Identifier, Observation, Quantity, Resource } from '@medplum/fhirtypes';
import { EPIC_OID } from '../identity.ts';
import { ehiDate } from './dates.ts';
import { type EhiCtx, ehiId, encounterRef, epicId, localId, PATIENT_REF } from './ids.ts';
import type { EhiTables } from './read.ts';

const NUM = /^-?\d+(\.\d+)?$/;

function status(s: string): Observation['status'] {
  if (/final/i.test(s)) return 'final';
  if (/prelim/i.test(s)) return 'preliminary';
  if (/correct|edit/i.test(s)) return 'corrected';
  return 'unknown';
}

// DiagnosticReport per ORDER_PROC, Observation per ORDER_RESULTS line. The export has no LOINC codes, only LOINC
// long names (recon b): kept as a display without a code, so nothing reads as a code; the component name is code.text.
export function mapLabs(t: EhiTables, ctx: EhiCtx): Resource[] {
  const enc = encounterRef(t);
  const byOrder = new Map<string, Observation[]>();
  for (const r of t.rows('ORDER_RESULTS')) {
    const pk = `${r.ORDER_PROC_ID}-${r.LINE}`;
    const unit = r.REFERENCE_UNIT || undefined;
    const q = (v: string): Quantity => ({ value: Number(v), ...(unit && { unit }) });
    const low = NUM.test(r.REFERENCE_LOW) ? { low: q(r.REFERENCE_LOW) } : {};
    const high = NUM.test(r.REFERENCE_HIGH) ? { high: q(r.REFERENCE_HIGH) } : {};
    const range = Object.keys({ ...low, ...high }).length ? { ...low, ...high } : r.REF_NORMAL_VALS ? { text: r.REF_NORMAL_VALS } : undefined;
    // Specimen time (COMP_OBS_INST_TM), else the result date.
    const effectiveDateTime = ehiDate(r.COMP_OBS_INST_TM || r.RESULT_DATE, ctx);
    const encounter = enc(r.PAT_ENC_CSN_ID);
    const long = r.COMPON_LNC_ID_LNC_LONG_NAME;
    const o = {
      resourceType: 'Observation',
      id: localId('ORDER_RESULTS', pk),
      identifier: [ehiId(ctx, 'ORDER_RESULTS', pk)], // R7: results carry no link identifier
      status: status(r.RESULT_STATUS_C_NAME),
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      ...((r.COMPONENT_ID_NAME || long) && { code: { ...(r.COMPONENT_ID_NAME && { text: r.COMPONENT_ID_NAME }), ...(long && { coding: [{ display: long }] }) } }),
      subject: PATIENT_REF,
      ...(encounter && { encounter }),
      ...(effectiveDateTime && { effectiveDateTime }),
      // ORD_VALUE, parsed strictly: ORD_NUM_VALUE can hold a sentinel for text results.
      ...(NUM.test(r.ORD_VALUE) ? { valueQuantity: q(r.ORD_VALUE) } : r.ORD_VALUE ? { valueString: r.ORD_VALUE } : {}),
      ...(r.RESULT_FLAG_C_NAME && { interpretation: [{ text: r.RESULT_FLAG_C_NAME }] }),
      ...(range && { referenceRange: [range] }),
    } as Observation;
    byOrder.set(r.ORDER_PROC_ID, [...(byOrder.get(r.ORDER_PROC_ID) ?? []), o]);
  }
  const reports = t.rows('ORDER_PROC').map((r) => {
    const id = r.ORDER_PROC_ID;
    const results = byOrder.get(id) ?? [];
    const lab = r.LAB_STATUS_C_NAME;
    const encounter = enc(r.PAT_ENC_CSN_ID);
    const name = r.PROC_ID_PROC_NAME || r.DESCRIPTION;
    const effectiveDateTime = results.find((o) => o.effectiveDateTime)?.effectiveDateTime ?? ehiDate(r.ORDERING_DATE, ctx);
    return {
      resourceType: 'DiagnosticReport',
      id: localId('ORDER_PROC', id),
      identifier: [ehiId(ctx, 'ORDER_PROC', id), ...epicId(ctx, 'order', id)],
      status: lab ? status(lab) : /complete/i.test(r.ORDER_STATUS_C_NAME) ? 'final' : 'unknown',
      ...(name && { code: { text: name } }),
      subject: PATIENT_REF,
      ...(encounter && { encounter }),
      ...(effectiveDateTime && { effectiveDateTime }),
      ...(results.length && { result: results.map((o) => ({ reference: `Observation/${o.id}` })) }),
    } as DiagnosticReport;
  });
  return [...reports, ...[...byOrder.values()].flat()];
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const names = (o: Observation) => [o.code?.text, ...(o.code?.coding ?? []).map((c) => c.display)].map(norm).filter(Boolean);
const unitOf = (o: Observation) => o.valueQuantity?.unit ?? '';
const valueOf = (o: Observation) => (o.valueQuantity ? String(o.valueQuantity.value) : (o.valueString ?? ''));

// R7, order-scoped: an EHI report whose order id matches an existing GA report (same patient) identifies its result
// lines among that report's results, by unit and name (or, if the existing has no name, by unique value and unit).
// An identified line takes the existing LOINC coding and effective time, so the engine's content path decides:
// same value merges, a different value is a possible duplicate. Unidentified lines are created separately.
export async function linkResultsToExisting(
  client: MedplumClient,
  resources: Resource[],
  patientId: string,
): Promise<{ resources: Resource[]; identified: number; unidentified: number }> {
  const out = structuredClone(resources);
  const byRef = new Map(out.filter((r) => r.resourceType === 'Observation').map((r) => [`Observation/${r.id}`, r as Observation]));
  let identified = 0;
  let unidentified = 0;
  for (const dr of out.filter((r): r is DiagnosticReport => r.resourceType === 'DiagnosticReport')) {
    const order = (dr.identifier ?? []).find((i: Identifier) => i.system?.startsWith(EPIC_OID) && i.value);
    if (!order) continue;
    const hits = await client.searchResources('DiagnosticReport', { identifier: `${order.system}|${order.value}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' });
    if (hits.length !== 1) continue; // none, or ambiguous: the engine's link lookup flags it
    const [existing] = hits;
    // Keep the existing report's LOINC code too: the newer EHI body replaces it on update.
    if (existing.code?.coding?.length) dr.code = { ...dr.code, coding: existing.code.coding };
    // One search, not reads: a report can keep a reference to a result that was never written (invalid at import).
    const ids = (existing.result ?? []).map((r) => /^Observation\/([^/]+)$/.exec(r.reference ?? '')?.[1]).filter(Boolean);
    const olds = ids.length ? await client.searchResources('Observation', { _id: ids.join(','), _count: '1000' }, { cache: 'no-cache' }) : [];
    for (const ref of dr.result ?? []) {
      const o = byRef.get(ref.reference ?? '');
      if (!o) continue;
      const mine = names(o);
      const sameUnit = olds.filter((x) => unitOf(x) === unitOf(o));
      const byName = sameUnit.filter((x) => names(x).some((n) => mine.includes(n)));
      const byValue = sameUnit.filter((x) => !names(x).length && valueOf(x) === valueOf(o));
      const match = byName.length === 1 ? byName[0] : !byName.length && byValue.length === 1 ? byValue[0] : undefined;
      if (!match) {
        unidentified++;
        continue;
      }
      identified++;
      if (match.code?.coding?.length) o.code = { ...o.code, coding: match.code.coding };
      if (match.effectiveDateTime) o.effectiveDateTime = match.effectiveDateTime;
    }
  }
  return { resources: out, identified, unidentified };
}
