// ga ui: what the side panel shows for one record, one series (a test or measure over time), one drug, one diagnosis or one
// list, built from the records the page already loaded. Every field a person can read is shown: fields this file knows get a
// plain label and place, the rest are listed as they are (never codes, ids or addresses). The form follows the kind of value:
// numbers over time are a chart and a table, text is read as text, a visit lists what was recorded at it.
import type { DiagnosticReport, DocumentReference, Encounter, ImagingStudy, MedicationRequest, MedicationStatement, Observation, Resource } from '@medplum/fhirtypes';
import { cardiacStudy, geneticTest, hasTag } from '../identity.ts';
import { highLow } from '../labs.ts';
import { noteText } from '../notes.ts';
import { day, drugKey, drugName, encounterKind, encounterLabel, hasCat, seriesKey, text, titled, type Row } from './timeline.ts';

export type Cell = string | { v: string; q?: string; alert?: true };
export type Section = { title: string; note?: string } & (
  | { type: 'text'; text: string }
  | { type: 'table'; head?: string[]; rows: Cell[][] }
  // points: date, one value per name, the usual range (low, high) and "high" | "low" | "" for the first value
  | { type: 'series'; unit: string; names: string[]; points: [string, number[], number | null, number | null, string][] });
export type Detail = { title: string; kind: string; when?: string; t?: string; flags?: string[]; facts: Row[]; sections: Section[] };
export type Query = { ref?: string; series?: string; course?: string; dx?: string; list?: string };

export const LINK_ONLY = 'GA holds only a link to this report\'s text at the hospital: the source it came from (Apple Health records or the export file) did not include the text itself.';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = Record<string, any>;
// An instant is shown in this computer's time zone; a date as written.
const when = (s: string): string => (/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(s) ? new Date(s).toLocaleString('sv').slice(0, 16) : s);
const words = (k: string): string => { const w = k.replace(/(DateTime|Boolean|CodeableConcept|Reference|Quantity|Period|String)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return w[0].toUpperCase() + w.slice(1); };
const HIDE = new Set(['id', 'system', 'code', 'reference', 'identifier', 'extension', 'url', 'hash', 'size', 'data', 'contentType', 'use', 'resourceType', 'uid', 'coding', 'div', 'linkId']);
const only = (o: Any, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const quantity = (q?: Any): string | undefined => (typeof q?.value !== 'number' ? undefined : `${q.comparator ?? ''}${q.value}${q.unit ?? (q.system === 'http://unitsofmeasure.org' && q.code) ? ` ${q.unit ?? q.code}` : ''}`);
// Any value in plain words. Codes, ids and addresses are never shown; a coded value with no name says nothing.
export function say(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'string') return when(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) { const p = [...new Set(v.map(say).filter(Boolean))]; return p.length ? p.join('; ') : undefined; }
  const o = v as Any;
  if (o.coding || (typeof o.text === 'string' && only(o, ['text', 'coding', 'extension']))) return o.text ?? o.coding?.find((c: Any) => c.display)?.display;
  if ('reference' in o || ('display' in o && only(o, ['reference', 'display', 'type', 'identifier', 'extension']))) return o.display;
  if (typeof o.value === 'number') return quantity(o);
  if (('start' in o || 'end' in o) && only(o, ['start', 'end'])) return o.start && o.end && o.start !== o.end ? `${when(o.start)} – ${when(o.end)}` : when(o.start ?? o.end);
  if ('contentType' in o && ('data' in o || 'url' in o)) return o.title;
  const parts = Object.entries(o).filter(([k]) => !HIDE.has(k)).map(([k, x]) => { const s = say(x); return s && (k === 'text' || k === 'display' ? s : `${words(k).toLowerCase()} ${s}`); }).filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

const LABEL: Record<string, string> = {
  status: 'Status', clinicalStatus: 'Status', verificationStatus: 'Verification', lifecycleStatus: 'Status', docStatus: 'Document status', category: 'Category', intent: 'Kind of order',
  effectiveDateTime: 'When', effectivePeriod: 'When', issued: 'Reported', performedDateTime: 'Done', performedPeriod: 'Done', authoredOn: 'Ordered', recordedDate: 'Recorded',
  onsetDateTime: 'Since', abatementDateTime: 'Resolved', occurrenceDateTime: 'Given', occurrencePeriod: 'Planned for', whenHandedOver: 'Handed over', startDate: 'Started', date: 'Dated', sent: 'Sent',
  requester: 'Ordered by', recorder: 'Recorded by', asserter: 'Reported by', author: 'Author', authenticator: 'Signed by', custodian: 'Kept by', resultsInterpreter: 'Read by', expressedBy: 'Set by',
  reasonCode: 'Reason', note: 'Comment', specimen: 'Specimen', basedOn: 'Ordered as', location: 'Where', outcome: 'Outcome', usedReference: 'Used', report: 'Report', addresses: 'For',
  lotNumber: 'Lot', expirationDate: 'Vaccine expires', doseQuantity: 'Dose', primarySource: 'Recorded by who gave it', reportOrigin: 'Reported by', manufacturer: 'Maker', site: 'Site', route: 'Route',
  courseOfTherapyType: 'Course', priorPrescription: 'Replaces', priority: 'Priority', reportedBoolean: 'Reported by the patient', dispenseRequest: 'Supply', quantity: 'Quantity',
  conclusionCode: 'Conclusion', interpretation: 'Flag', description: 'Description', payor: 'Insurer', relationship: 'Relationship', serviceType: 'Service', partOf: 'Part of',
  numberOfSeries: 'Series', numberOfInstances: 'Images', started: 'Started', modality: 'Kind of images', asNeededBoolean: 'As needed', bodySite: 'Body site', hasMember: 'Parts', type: 'Type',
};
// Never listed: who the record is about, GA's own bookkeeping, account and member numbers.
const NEVER = ['id', 'resourceType', 'meta', 'identifier', 'subject', 'patient', 'beneficiary', 'subscriber', 'subscriberId', 'text', 'contained', 'extension', 'account', 'encounter', 'code', 'order', 'focus'];

const KIND: Record<string, string> = {
  Condition: 'Problem', MedicationRequest: 'Medication order', MedicationStatement: 'Medication', MedicationDispense: 'Pharmacy fill', Procedure: 'Procedure', DiagnosticReport: 'Report',
  DocumentReference: 'Document', ImagingStudy: 'Imaging study', Immunization: 'Immunization', AllergyIntolerance: 'Allergy', CarePlan: 'Care plan', CareTeam: 'Care team', Goal: 'Goal',
  ServiceRequest: 'Order', Specimen: 'Specimen', FamilyMemberHistory: 'Family history', Communication: 'Message', QuestionnaireResponse: 'Questionnaire', Coverage: 'Insurance',
};
const ENC = { inpatient: 'Inpatient stay', emergency: 'Emergency visit', procedure: 'Day procedure', visit: 'Visit', hospital: 'Hospital outpatient visit', contact: 'Contact (no visit)' };
const isLabPanel = (d: DiagnosticReport) => !cardiacStudy(d) && hasCat(d, /^lab/i) && !hasCat(d, /^(path|pathology|cyt|micro)/i);
const obsKind = (o: Observation): string => (hasTag(o, 'src-apple-health') ? 'Home measurement' : hasCat(o, /^study-finding$/) ? 'Study finding'
  : cardiacStudy(o) ? (cardiacStudy(o) === 'echo' ? 'Echo measurement' : 'ECG measurement') : hasCat(o, /^vital-signs$/) ? 'Vital sign' : geneticTest(o) ? 'Genetic result' : hasCat(o, /^laboratory$/) ? 'Lab result' : hasCat(o, /^survey$/) ? 'Assessment'
  : hasCat(o, /^(exam|smartdata)$/) ? 'Exam finding' : hasCat(o, /^social-history$/) ? 'Social history' : 'Observation');
export function kindOf(r: Resource): string {
  if (r.resourceType === 'Encounter') return ENC[encounterKind(r)];
  if (r.resourceType === 'Observation') return obsKind(r);
  if (r.resourceType === 'Condition') return hasCat(r, /^problem-list-item$/) ? 'Problem' : hasCat(r, /^health-concern$/) ? 'Health concern' : 'Diagnosis at a visit';
  if (r.resourceType === 'DocumentReference') return hasCat(r, /^clinical-note$/) ? 'Note' : hasCat(r, /^summary-document$/) ? 'Encounter summary document' : 'Stored file';
  if (r.resourceType === 'DiagnosticReport') return isLabPanel(r) ? 'Lab panel' : 'Report';
  return KIND[r.resourceType] ?? words(r.resourceType);
}
export function nameOf(r: Resource): string {
  const a = r as Any;
  const n = r.resourceType === 'Encounter' ? encounterLabel(r) : r.resourceType === 'MedicationRequest' || r.resourceType === 'MedicationStatement' ? drugName(r)
    : r.resourceType === 'DocumentReference' ? text(r.type) ?? r.description ?? r.content?.[0]?.attachment?.title
    : text(a.code) ?? text(a.vaccineCode) ?? text(a.medicationCodeableConcept) ?? a.medicationReference?.display ?? a.description?.text ?? (typeof a.description === 'string' ? a.description : undefined)
      ?? a.name ?? text(a.relationship) ?? text(a.type) ?? text([a.category ?? []].flat()[0]);
  return titled(typeof n === 'string' && n ? n : kindOf(r));
}
export const dateOf = (r: Resource): string | undefined => {
  const a = r as Any;
  return a.effectiveDateTime ?? a.effectivePeriod?.start ?? a.performedDateTime ?? a.performedPeriod?.start ?? (r.resourceType === 'Coverage' ? undefined : a.period?.start) ?? a.authoredOn ?? a.occurrenceDateTime
    ?? a.occurrencePeriod?.start ?? a.started ?? a.onsetDateTime ?? a.whenHandedOver ?? a.sent ?? a.startDate ?? a.collection?.collectedDateTime ?? (typeof a.date === 'string' ? a.date : undefined) ?? a.recordedDate ?? a.issued ?? a.period?.start;
};
const range = (o: Observation): string => { const r = o.referenceRange?.[0]; return r?.text ?? (r?.low?.value !== undefined || r?.high?.value !== undefined ? `${r.low?.value ?? ''}–${r.high?.value ?? ''}` : ''); };
// The numbers one observation holds: its own value, or its parts (blood pressure, sleep stages, activity rings).
const numbers = (o: Observation): { name: string; v: number; unit: string }[] => (o.valueQuantity?.value !== undefined && !o.valueQuantity.comparator
  ? [{ name: '', v: o.valueQuantity.value, unit: o.valueQuantity.unit ?? '' }]
  : (o.component ?? []).flatMap((c) => (c.valueQuantity?.value === undefined ? [] : [{ name: text(c.code) ?? '', v: c.valueQuantity.value, unit: c.valueQuantity.unit ?? '' }])));
const parts = (o: Observation): string | undefined => say(o.component?.map((c) => { const v = quantity(c.valueQuantity) ?? say((c as Any).valueString ?? c.valueCodeableConcept ?? (c as Any).valueBoolean); return v && `${text(c.code) ?? ''} ${v}`.trim(); }));
export const valueOf = (o: Observation): string | undefined => {
  const bp = /blood pressure|^nibp$/i.test(text(o.code) ?? '') && o.component?.length === 2 && o.component.every((c) => c.valueQuantity?.value !== undefined);
  return quantity(o.valueQuantity) ?? o.valueString ?? text(o.valueCodeableConcept) ?? say((o as Any).valueBoolean ?? (o as Any).valueInteger ?? (o as Any).valueDateTime)
    ?? (bp ? `${o.component![0].valueQuantity!.value}/${o.component![1].valueQuantity!.value} ${o.component![0].valueQuantity!.unit ?? ''}`.trim() : parts(o));
};
const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
const plain = (html: string) => html.replace(/<\/(h\d|li|p|div|tr)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function makeDetails(all: Resource[]): (q: Query) => Detail | undefined {
  const byId = new Map(all.map((r) => [`${r.resourceType}/${r.id}`, r]));
  const at = new Map<string, Resource[]>(); // what was recorded at a visit, or about a note
  const series = new Map<string, Observation[]>();
  for (const r of all) {
    const a = r as Any;
    const refs: (string | undefined)[] = [a.encounter?.reference, ...(a.context?.encounter ?? []).map((e: Any) => e.reference), ...(a.focus ?? []).map((f: Any) => f.reference)];
    for (const ref of new Set(refs)) if (ref) (at.get(ref) ?? at.set(ref, []).get(ref)!).push(r);
    if (r.resourceType === 'Observation') { const k = seriesKey(r); (series.get(k) ?? series.set(k, []).get(k)!).push(r); }
  }
  for (const s of series.values()) s.sort((a, b) => (dateOf(a) ?? '').localeCompare(dateOf(b) ?? ''));
  const link = (r: Resource, label = nameOf(r)): Cell => ({ v: label, q: `ref=${r.resourceType}/${r.id}` });
  const dated = <T extends Resource>(rs: T[]): T[] => [...rs].sort((a, b) => (dateOf(b) ?? '').localeCompare(dateOf(a) ?? ''));
  const flagsOf = (r: Resource): string[] | undefined => {
    const f = [hasTag(r, 'extracted-by-llm') && 'read by AI from a document', hasTag(r, 'src-apple-clinical') && 'from Apple Health records', hasTag(r, 'src-apple-health') && 'from Apple Health',
      hasTag(r, 'person-edited') && 'edited by a person', hasTag(r, 'source-conflict') && 'a newer source differs from this record'].filter((x): x is string => !!x);
    return f.length ? f : undefined;
  };
  const cell = (o: Observation): Cell => { const v = valueOf(o) ?? ''; return highLow(o) ? { v: `${v} (${highLow(o)})`, alert: true } : v; };
  const group = (r: Resource): string => {
    if (r.resourceType === 'Observation') return ({ 'Lab result': 'Lab tests', 'Genetic result': 'Genetic tests', 'Vital sign': 'Vital signs (clinic)', 'Home measurement': 'Home measurements (Apple Health)', Assessment: 'Assessments',
      'Exam finding': 'Exam findings', 'Social history': 'Social history', 'Echo measurement': 'Echo and ECG measurements', 'ECG measurement': 'Echo and ECG measurements', 'Study finding': 'Study findings' } as Record<string, string>)[obsKind(r)] ?? 'Other observations';
    if (r.resourceType === 'Condition') return hasCat(r, /^problem-list-item$/) ? 'Problems' : 'Diagnoses at visits';
    if (r.resourceType === 'DocumentReference') return hasCat(r, /^clinical-note$/) ? 'Notes' : hasCat(r, /^summary-document$/) ? 'Encounter summary documents' : 'Stored files';
    if (r.resourceType === 'DiagnosticReport') return geneticTest(r) ? 'Genetic test reports' : isLabPanel(r) ? 'Lab panels' : 'Reports';
    return ({ Encounter: 'Encounters', MedicationRequest: 'Medications', MedicationStatement: 'Medications', MedicationDispense: 'Pharmacy fills', Procedure: 'Procedures', ImagingStudy: 'Imaging studies',
      Immunization: 'Immunizations', AllergyIntolerance: 'Allergies', CarePlan: 'Care plans and goals', Goal: 'Care plans and goals', CareTeam: 'Care team', ServiceRequest: 'Orders', Specimen: 'Specimens',
      FamilyMemberHistory: 'Family history', Communication: 'Messages', QuestionnaireResponse: 'Questionnaires', Coverage: 'Insurance' } as Record<string, string>)[r.resourceType] ?? words(r.resourceType);
  };
  // Observations as one row per measure: a single reading as its value, repeated readings as their count and span.
  const measures = (obs: Observation[]): Cell[][] => {
    const by = new Map<string, Observation[]>();
    for (const o of obs) { const k = seriesKey(o); (by.get(k) ?? by.set(k, []).get(k)!).push(o); }
    return [...by].map(([k, os]) => {
      if (os.length === 1) return [link(os[0]), cell(os[0]), range(os[0])];
      const n = os.flatMap((o) => numbers(o).slice(0, 1));
      const span = n.length === os.length ? `${round(Math.min(...n.map((x) => x.v)))}–${round(Math.max(...n.map((x) => x.v)))} ${n[0].unit}`.trim() : [...new Set(os.map((o) => valueOf(o)))].slice(0, 3).join(', ');
      return [{ v: nameOf(os[0]), q: `series=${k}` }, `${os.length} readings: ${span}`, ''];
    });
  };
  const table = (d: Detail, title: string, rows: Cell[][], head?: string[], note?: string) => { if (rows.length) d.sections.push({ title, type: 'table', head, rows, note }); };

  // What was recorded at a visit (or about a note), a section per kind.
  function contents(d: Detail, keys: string[], skip: Resource) {
    const here = [...new Set(keys.flatMap((k) => at.get(k) ?? []))].filter((r) => r !== skip);
    const by = new Map<string, Resource[]>();
    for (const r of here) { const g = group(r); (by.get(g) ?? by.set(g, []).get(g)!).push(r); }
    const order = ['Diagnoses at visits', 'Problems', 'Notes', 'Reports', 'Procedures', 'Medications', 'Orders', 'Immunizations', 'Lab tests', 'Vital signs (clinic)', 'Assessments', 'Exam findings'];
    for (const g of [...by.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99)) {
      const rs = by.get(g)!;
      if (g === 'Echo and ECG measurements' || g === 'Study findings' || g === 'Specimens') continue; // shown with their report and their result
      if (rs[0].resourceType === 'Observation') table(d, g, measures(rs as Observation[]), ['Measure', 'Value', 'Usual range']);
      else if (g === 'Medications') table(d, g, dated(rs).map((r) => [link(r), (r as MedicationRequest).dosageInstruction?.[0]?.text ?? '']));
      else table(d, g, dated(rs).map((r) => [link(r), r.resourceType === 'ServiceRequest' || r.resourceType === 'Procedure' ? (r as Any).status ?? '' : r.resourceType === 'DocumentReference' ? (r as DocumentReference).author?.[0]?.display ?? '' : '']));
    }
  }

  function record(r: Resource): Detail {
    const a = r as Any, t = dateOf(r), me = `${r.resourceType}/${r.id}`;
    const d: Detail = { title: nameOf(r), kind: kindOf(r), t, when: t && when(t), flags: flagsOf(r), facts: [], sections: [] };
    const drop = new Set(NEVER);
    const fact = (k: string, v?: string, ...keys: string[]) => { if (v) d.facts.push([k, v]); for (const x of keys) drop.add(x); };
    const people = (ps?: Any[]) => { // one entry per person, their roles together
      const by = new Map<string, Set<string>>();
      for (const p of ps ?? []) {
        const who = (p.actor ?? p.individual ?? p.member)?.display, role = text(p.function ?? p.role?.[0] ?? p.type?.[0]);
        if (!who) continue;
        const roles = by.get(who) ?? by.set(who, new Set()).get(who)!;
        if (role && !/^participa/i.test(role)) roles.add(role.toLowerCase());
        if (p.onBehalfOf?.display) roles.add(`for ${p.onBehalfOf.display}`);
      }
      return [...by].map(([who, roles]) => `${who}${roles.size ? ` (${[...roles].join(', ')})` : ''}`).join('; ') || undefined;
    };
    const sameDay = (type: string) => all.filter((x) => x.resourceType === type && x !== r && t && day(dateOf(x)) === day(t));

    if (r.resourceType === 'Encounter') {
      const twins = encounterKind(r) === 'procedure' ? (sameDay('Encounter') as Encounter[]).filter((e) => encounterKind(e) === 'procedure') : [];
      const both = [r, ...twins];
      d.when = say(r.period);
      fact('Recorded as', say([...both.flatMap((e) => e.type ?? []), ...both.map((e) => e.class?.display)]), 'type', 'class', 'period');
      fact('Where', say(both.flatMap((e) => e.location?.map((l) => l.location) ?? [])), 'location');
      fact('With', people(both.flatMap((e) => e.participant ?? [])), 'participant');
      fact('Reason', say(both.flatMap((e) => e.reasonCode ?? [])), 'reasonCode');
      fact('Came from', say(r.hospitalization?.admitSource)); fact('Went to', say(r.hospitalization?.dischargeDisposition), 'hospitalization');
      if (twins.length) d.flags = [...(d.flags ?? []), 'the hospital recorded this day twice (hospital encounter and surgery log): shown as one'];
      contents(d, both.map((e) => `Encounter/${e.id}`), r);
      if (encounterKind(r) !== 'contact') { // records of that day that name no visit (Apple Health records, DICOM files)
        const loose = ['Procedure', 'DiagnosticReport', 'ImagingStudy', 'DocumentReference', 'Immunization'].flatMap(sameDay).filter((x) => !(x as Any).encounter?.reference && !(x as Any).context?.encounter?.length && !(x.resourceType === 'DocumentReference' && !hasCat(x, /^clinical-note$/)));
        table(d, 'Also dated that day (not tied to a visit)', loose.map((x) => [link(x), kindOf(x)]));
      }
    } else if (r.resourceType === 'Condition') {
      const same = all.filter((x) => x.resourceType === 'Condition' && x !== r && nameOf(x) === d.title && !hasCat(x, /^problem-list-item$/));
      table(d, 'Coded at visits', dated(same).map((x) => { const e = byId.get((x as Any).encounter?.reference ?? ''); return [day(dateOf(e ?? x)), e ? link(e) : '']; }));
      fact('On the problem list', hasCat(r, /^problem-list-item$/) ? 'yes' : 'no (coded at a visit)', 'category');
    } else if (r.resourceType === 'MedicationRequest' || r.resourceType === 'MedicationStatement') {
      const mr = r as MedicationRequest, ms = r as MedicationStatement;
      const dose = (mr.dosageInstruction ?? ms.dosage ?? []) as Any[];
      fact('Directions', say(dose.map((x) => x.text)), 'dosageInstruction', 'dosage', 'medicationReference', 'medicationCodeableConcept');
      fact('Instructions to the patient', say(dose.map((x) => x.patientInstruction)));
      fact('Dose', say(dose.flatMap((x) => (x.doseAndRate ?? []).map((y: Any) => y.doseQuantity ?? y.doseRange))));
      fact('Route', say(dose.map((x) => x.route))); fact('How', say(dose.map((x) => x.method)));
      fact('Timing', say(dose.map((x) => { const p = x.timing?.repeat; return [text(x.timing?.code) ?? (p?.frequency ? `${p.frequency} time${p.frequency > 1 ? 's' : ''} every ${p.period ?? 1} ${p.periodUnit ?? ''}`.trim() : undefined), p?.timeOfDay?.length && `at ${p.timeOfDay.map((h: string) => h.slice(0, 5)).join(', ')}`].filter(Boolean).join(', '); })));
      fact('From – until', say(dose.map((x) => x.timing?.repeat?.boundsPeriod)));
      fact('As needed', say(dose.map((x) => x.asNeededBoolean)));
      fact('Setting', say(mr.category), 'category');
      const med = (a.contained as Any[] | undefined)?.find((c) => c.resourceType === 'Medication');
      fact('Form', say(med?.form));
      fact('Ingredients', say(med?.ingredient?.map((i: Any) => [say(i.itemCodeableConcept ?? i.itemReference), i.strength?.numerator && `${quantity(i.strength.numerator)}${i.strength.denominator?.value && i.strength.denominator.value !== 1 ? ` per ${quantity(i.strength.denominator)}` : i.strength.denominator?.unit ? ` per ${i.strength.denominator.unit}` : ''}`].filter(Boolean).join(' '))));
      const key = drugKey(drugName(r)), others = all.filter((x) => (x.resourceType === 'MedicationRequest' || x.resourceType === 'MedicationStatement') && drugKey(drugName(x)) === key);
      table(d, 'Pharmacy fills', dated(all.filter((x) => x.resourceType === 'MedicationDispense' && (x as Any).authorizingPrescription?.some((p: Any) => p.reference === me))).map((x) => [day(dateOf(x)), link(x), say((x as Any).quantity) ?? '']));
      if (others.length > 1) table(d, 'This drug over time', [[{ v: `All ${others.length} orders of ${key}`, q: `course=${key}` }]]);
    } else if (r.resourceType === 'Procedure') {
      d.when = say(r.performedPeriod) ?? d.when;
      fact('By', people(r.performer), 'performer', 'performedPeriod', 'performedDateTime');
      table(d, 'Report', (r.report ?? []).flatMap((x) => { const rep = byId.get(x.reference ?? ''); return rep ? [[link(rep)]] : []; }));
      table(d, 'Also recorded that day', sameDay('Procedure').map((x) => [link(x), say((x as Any).category) ?? '']), undefined, 'The hospital often records one procedure twice: as the order and as the surgical record.');
      table(d, 'Drugs given that day', (sameDay('MedicationRequest') as MedicationRequest[]).filter((m) => hasCat(m, /^(inpatient|outpatient)$/) && !hasCat(m, /^(community|discharge)$/)).map((m) => [link(m), m.dosageInstruction?.[0]?.text ?? '']));
    } else if (r.resourceType === 'DiagnosticReport') {
      fact('By', say(r.performer), 'performer', 'presentedForm', 'conclusion', 'result');
      const results = (r.result ?? []).map((x) => byId.get(x.reference ?? '') as Observation | undefined);
      const got = results.filter((o): o is Observation => !!o), long = got.filter((o) => (o.valueString?.length ?? 0) > 120);
      if (r.conclusion) d.sections.push({ title: 'Conclusion', type: 'text', text: r.conclusion });
      const earlier = (o: Observation) => { const before = (series.get(seriesKey(o)) ?? []).filter((x) => (dateOf(x) ?? '') < (dateOf(o) ?? '')).at(-1); return before ? `${valueOf(before) ?? ''} (${day(dateOf(before))})` : ''; };
      const short = got.filter((o) => !long.includes(o));
      if (short.some((o) => numbers(o).length)) table(d, isLabPanel(r) ? 'Results' : 'Measurements', short.map((o) => [link(o), cell(o), range(o), earlier(o)]), ['Measure', 'Value', 'Usual range', 'Time before']);
      else table(d, 'Results', short.map((o) => [link(o), cell(o)])); // words only (pathology, cultures): no range, nothing to compare
      for (const o of long) d.sections.push({ title: nameOf(o), type: 'text', text: o.valueString! });
      const orders = new Set((r.basedOn ?? []).map((b) => b.reference).filter(Boolean));
      const findings = all.filter((x): x is Observation => x.resourceType === 'Observation' && hasCat(x, /^study-finding$/) && !!x.basedOn?.some((b) => orders.has(b.reference)));
      table(d, 'Findings', findings.map((o) => [nameOf(o), valueOf(o) ?? say(o.hasMember) ?? '']));
      const unnamed = (r.result ?? []).filter((x, i) => !results[i] && x.display).map((x) => [x.display!]);
      table(d, 'Results named but not included by the source', unnamed);
      const form = r.presentedForm?.find((f) => f.contentType?.startsWith('text/plain') && f.data);
      if (form?.data) d.sections.push({ title: 'Full text', type: 'text', text: Buffer.from(form.data, 'base64').toString('utf8') });
      else if (r.presentedForm?.some((f) => f.url && !f.data)) {
        // The source gave only the text's address. Epic also files an imaging report's narrative and impression as notes of kind
        // "Diagnostic imaging study": those of the same day are its text when it is the only such report that day.
        const imagingNotes = all.filter((x): x is DocumentReference => x.resourceType === 'DocumentReference' && /imaging study/i.test(text(x.type) ?? '') && !!t && day(x.date ?? x.context?.period?.start) === day(t) && !!noteText(x));
        const rivals = all.filter((x) => x.resourceType === 'DiagnosticReport' && x !== r && day(dateOf(x)) === day(t) && (x as DiagnosticReport).presentedForm?.some((f) => f.url && !f.data));
        // An older export of the same hospital may hold the text as results (named Narrative, Impression) that this report names
        // but does not link: same day, ordered under this report's name.
        const mine = new Set([d.title, ...(r.basedOn ?? []).map((b) => b.display ?? '')].map((x) => x.toLowerCase()).filter(Boolean));
        const loose = all.filter((x): x is Observation => x.resourceType === 'Observation' && (x.valueString?.length ?? 0) > 80 && !!t && day(dateOf(x)) === day(t) && !!x.basedOn?.some((b) => mine.has((b.display ?? '').toLowerCase())));
        if (loose.length) {
          for (const o of loose) d.sections.push({ title: nameOf(o), type: 'text', text: o.valueString! });
          table(d, 'Where this text is from', loose.map((o) => [link(o)]), undefined, 'The report itself arrived as a link only; these results of the same day, filed under the same order name, came from another export of this hospital.');
        } else if (!imagingNotes.length) { if (!long.length) d.sections.push({ title: 'Full text', type: 'text', text: LINK_ONLY }); } // long results above are its text
        else {
          for (const n of imagingNotes) d.sections.push({ title: 'Text, from the imaging note of that day', type: 'text', text: noteText(n)! });
          table(d, 'Where this text is from', imagingNotes.map((n) => [link(n), n.author?.[0]?.display ?? '']), undefined,
            `The report itself arrived as a link only; GA matched ${imagingNotes.length > 1 ? 'these notes' : 'this note'} to it by date${rivals.length ? `. ${rivals.length + 1} such reports share this day, so check which the text belongs to` : ''}.`);
        }
      }
    } else if (r.resourceType === 'Observation') {
      fact('Value', valueOf(r), 'valueQuantity', 'valueString', 'valueCodeableConcept', 'valueBoolean', 'valueInteger', 'component', 'referenceRange', 'interpretation', 'category');
      if (highLow(r)) d.facts[d.facts.length - 1][1] += ` (${highLow(r)})`;
      fact('Usual range', range(r));
      if (r.valueQuantity && r.component?.length) fact('Parts', parts(r));
      const sp = byId.get(r.specimen?.reference ?? '') as Any;
      fact('Specimen', [r.specimen?.display ?? say(sp?.type), sp?.collection?.collectedDateTime && `collected ${when(sp.collection.collectedDateTime)}`, say(sp?.collection?.bodySite), say(sp?.note)].filter(Boolean).join(', '), 'specimen');
      const members = (r.hasMember ?? []).map((m) => byId.get(m.reference ?? '') as Observation | undefined).filter((o): o is Observation => !!o);
      if (members.length) { drop.add('hasMember'); table(d, 'Parts', members.map((o) => [link(o), cell(o)])); }
      const n = series.get(seriesKey(r))?.length ?? 0;
      if (n > 1) table(d, 'Over time', [[{ v: `All ${n} results of ${d.title}`, q: `series=${seriesKey(r)}` }]]);
    } else if (r.resourceType === 'Immunization') {
      fact('By', people(r.performer), 'performer', 'vaccineCode');
      table(d, 'Other doses of this vaccine', dated(all.filter((x) => x.resourceType === 'Immunization' && x !== r && nameOf(x) === d.title)).map((x) => [day(dateOf(x)), link(x)]));
    } else if (r.resourceType === 'DocumentReference') {
      fact('Kind', say(r.type), 'type', 'content', 'context', 'category', 'status');
      const body = noteText(r);
      if (body) d.sections.push({ title: 'Text', type: 'text', text: body });
      else d.sections.push({ title: 'File', type: 'text', text: `GA stores this as a file (${say(r.content?.map((c) => c.attachment?.contentType?.split(';')[0])) ?? 'unknown kind'}); the page does not open it.` });
      contents(d, [me], r);
      fact('Related', say(r.context?.related));
      table(d, 'Written at', (r.context?.encounter ?? []).flatMap((e) => { const enc = byId.get(e.reference ?? ''); return enc ? [[day(dateOf(enc)), link(enc)]] : []; }));
    } else if (r.resourceType === 'ImagingStudy') {
      const s = r as ImagingStudy;
      table(d, 'Series', (s.series ?? []).map((x) => [String(x.number ?? ''), x.modality?.code ?? '', x.description ?? '', String(x.numberOfInstances ?? '')]), ['#', 'Kind', 'Description', 'Images'], 'The images are kept in the archived DICOM folder; the page does not show them.');
      drop.add('series');
    } else if (r.resourceType === 'Coverage') {
      fact('Plan', say(a.class?.map((c: Any) => c.name)), 'class');
      d.when = say(a.period); drop.add('period');
    } else if (r.resourceType === 'CareTeam') {
      fact('Members', people(a.participant), 'participant');
    } else if (r.resourceType === 'Communication') {
      const body = say(a.payload?.map((p: Any) => p.contentString));
      if (body) d.sections.push({ title: 'Message', type: 'text', text: body });
      drop.add('payload');
    }
    if ((r.resourceType === 'CarePlan' || r.resourceType === 'Goal') && a.text?.div) d.sections.push({ title: 'As written', type: 'text', text: plain(a.text.div) });
    for (const [k, v] of Object.entries(r)) if (!drop.has(k)) fact(LABEL[k] ?? words(k), say(v));
    // where it was recorded, and the order behind it
    const enc = byId.get(a.encounter?.reference ?? '');
    if (enc) table(d, 'Recorded at', [[day(dateOf(enc)), link(enc)]]);
    else if (a.encounter?.display) fact('Recorded at', a.encounter.display);
    const orders = ((a.basedOn ?? []) as Any[]).map((b) => byId.get(b.reference ?? '')).filter((x): x is Resource => !!x);
    table(d, 'Order', orders.map((o) => [link(o), say((o as Any).requester) ?? '']));
    return d;
  }

  // One test or measure over time. Few results: every one, charted. Thousands of home readings: monthly means and a row per year.
  function seriesDetail(key: string): Detail | undefined {
    const obs = series.get(key);
    if (!obs?.length) return undefined;
    const last = obs.at(-1)!, d: Detail = { title: nameOf(last), kind: `${obsKind(last)}s over time`.replace('ys over', 'ies over'), t: dateOf(last), facts: [], sections: [] };
    const dense = obs.length > 300;
    // A reading written without its unit (Epic's monitoring during a procedure) takes the unit of the others when they all agree.
    const stated = [...new Set(obs.flatMap((o) => numbers(o).map((n) => n.unit)).filter(Boolean))];
    const nums = (o: Observation) => numbers(o).map((n) => ({ ...n, unit: n.unit || (stated.length === 1 ? stated[0] : '') }));
    const names = [...new Set(obs.flatMap((o) => nums(o).map((n) => `${n.name}|${n.unit}`)))];
    const units = [...new Set(names.map((n) => n.split('|')[1]))];
    d.facts.push(['Results', `${obs.length.toLocaleString('en')}, ${day(dateOf(obs[0]))} to ${day(dateOf(last))}`], ['Latest', `${valueOf(last) ?? ''}${highLow(last) ? ` (${highLow(last)})` : ''}`]);
    if (range(last)) d.facts.push(['Usual range', range(last)]);
    for (const unit of units) {
      const mine = names.filter((n) => n.split('|')[1] === unit).map((n) => n.split('|')[0]);
      let pts = obs.flatMap((o): [string, number[], number | null, number | null, string][] => {
        const n = nums(o), vs = mine.map((m) => n.find((x) => x.name === m && x.unit === unit)?.v);
        const t = dateOf(o), r = o.referenceRange?.[0];
        return t && vs.every((v) => v !== undefined) ? [[t, vs as number[], r?.low?.value ?? null, r?.high?.value ?? null, highLow(o) ?? '']] : [];
      });
      if (!pts.length) continue;
      const lows = mine.map((_, i) => Math.min(...pts.map((p) => p[1][i]))), highs = mine.map((_, i) => Math.max(...pts.map((p) => p[1][i])));
      d.facts.push([`Lowest – highest${mine.length > 1 || mine[0] ? ` (${mine.join(', ')})` : ''}`, mine.map((_, i) => `${round(lows[i])}–${round(highs[i])}`).join(', ') + (unit ? ` ${unit}` : '')]);
      const all0 = pts;
      if (dense) { // monthly means
        const by = new Map<string, number[][]>();
        for (const p of pts) { const m = p[0].slice(0, 7); (by.get(m) ?? by.set(m, []).get(m)!).push(p[1]); }
        pts = [...by].map(([m, vs]) => [`${m}-15`, mine.map((_, i) => round(vs.reduce((s, v) => s + v[i], 0) / vs.length)), null, null, '']);
      }
      d.sections.push({ title: `${mine.filter(Boolean).join(', ') || d.title}${dense ? ', monthly means' : ''}`, type: 'series', unit, names: mine, points: pts });
      if (dense) {
        const years = new Map<string, number[][]>();
        for (const p of all0) { const y = p[0].slice(0, 4); (years.get(y) ?? years.set(y, []).get(y)!).push(p[1]); }
        table(d, `By year${unit ? ` (${unit})` : ''}`, [...years].reverse().map(([y, vs]) => [y, String(vs.length), ...mine.flatMap((_, i) => { const c = vs.map((v) => v[i]); return [String(round(c.reduce((s, v) => s + v, 0) / c.length)), `${round(Math.min(...c))}–${round(Math.max(...c))}`]; })]),
          ['Year', 'Readings', ...mine.flatMap((m) => [`${m || 'Mean'}${m ? ' mean' : ''}`, 'Lowest–highest'])]);
      }
    }
    if (units.length > 1 && names.every((n) => !n.split('|')[0])) d.flags = [`results were reported in different units (${units.join(', ')}): each is charted apart`];
    const rows = [...obs].reverse().slice(0, dense ? 30 : obs.length);
    const days = new Set(obs.map((o) => day(dateOf(o)))), timed = dense || days.size < obs.length; // several a day: show the time too
    const comments = rows.some((o) => o.note?.length);
    table(d, dense ? 'Latest 30 readings' : 'Every result', rows.map((o) => [{ v: timed ? when(dateOf(o) ?? '') : day(dateOf(o)), q: `ref=Observation/${o.id}` }, cell(o), ...(dense ? [] : [range(o)]), ...(comments ? [say(o.note?.map((n) => n.text)) ?? ''] : [])]),
      ['Date', 'Value', ...(dense ? [] : ['Usual range']), ...(comments ? ['Comment'] : [])]);
    const devices = [...new Set(obs.map((o) => o.device?.display).filter(Boolean))];
    if (devices.length) d.facts.push(['Measured by', devices.slice(0, 6).join('; ')]);
    return d;
  }

  function course(key: string): Detail | undefined {
    const orders = dated(all.filter((x): x is MedicationRequest | MedicationStatement => (x.resourceType === 'MedicationRequest' || x.resourceType === 'MedicationStatement') && drugKey(drugName(x)) === key));
    if (!orders.length) return undefined;
    const d: Detail = { title: key, kind: 'Medication, every order', t: dateOf(orders[0]), facts: [], sections: [] };
    const latest = orders[0] as MedicationRequest;
    d.facts.push(['Orders', `${orders.length}, ${day(dateOf(orders.at(-1)!))} to ${day(dateOf(latest))}`], ['Latest order', `${drugName(latest)} (${latest.status ?? ''})`]);
    const sig = latest.dosageInstruction?.[0];
    if (sig?.text) d.facts.push(['Directions (latest)', sig.text]);
    if (sig?.patientInstruction && sig.patientInstruction !== sig.text) d.facts.push(['Instructions (latest)', sig.patientInstruction]);
    if (latest.requester?.display) d.facts.push(['Ordered by (latest)', latest.requester.display]);
    table(d, 'Orders, newest first', orders.map((o) => [day(dateOf(o)), link(o, drugName(o)), (o as MedicationRequest).dosageInstruction?.[0]?.text ?? '', o.status ?? '']), ['Ordered', 'As written', 'Directions', 'Status']);
    return d;
  }

  function diagnosis(label: string): Detail | undefined {
    const cs = dated(all.filter((x) => x.resourceType === 'Condition' && !hasCat(x, /^problem-list-item$/) && (text((x as Any).code) ?? 'Condition') === label));
    if (!cs.length) return undefined;
    const d: Detail = { title: titled(label), kind: 'Diagnosis coded at visits (not on the problem list)', t: dateOf(cs[0]), facts: [['Coded', `${cs.length} time${cs.length > 1 ? 's' : ''}`]], sections: [] };
    table(d, 'Visits', cs.map((c) => { const e = byId.get((c as Any).encounter?.reference ?? ''); return [day(dateOf(e ?? c)), e ? link(e) : link(c, 'record')]; }), ['Date', 'Visit']);
    return d;
  }

  // "All records": every group with its count; a group lists its records (observations: its tests or measures).
  function list(name: string): Detail | undefined {
    const groups = new Map<string, Resource[]>();
    for (const r of all) { const g = group(r); (groups.get(g) ?? groups.set(g, []).get(g)!).push(r); }
    if (name === 'index') {
      const d: Detail = { title: 'All records', kind: 'Everything GA holds, by kind', facts: [], sections: [] };
      table(d, 'Kinds', [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([g, rs]) => [{ v: g, q: `list=${g}` }, rs.length.toLocaleString('en')]), ['Kind', 'Records']);
      return d;
    }
    const rs = groups.get(name);
    if (!rs) return undefined;
    const d: Detail = { title: name, kind: `${rs.length.toLocaleString('en')} records`, facts: [], sections: [] };
    if (rs[0].resourceType === 'Observation') {
      const by = new Map<string, Observation[]>();
      for (const o of rs as Observation[]) { const k = seriesKey(o); (by.get(k) ?? by.set(k, []).get(k)!).push(o); }
      const rows = [...by].map(([k, os]) => { const l = series.get(k)!.filter((o) => os.includes(o)).at(-1)!; return { name: nameOf(l), row: [{ v: nameOf(l), q: `series=${k}` }, String(os.length), cell(l), day(dateOf(l))] as Cell[] }; });
      table(d, 'Tests and measures', rows.sort((a, b) => a.name.localeCompare(b.name)).map((x) => x.row), ['Name', 'Results', 'Latest', 'Date']);
    } else if (name === 'Medications') {
      const by = new Map<string, Resource[]>();
      for (const m of rs) { const k = drugKey(drugName(m as MedicationRequest)); (by.get(k) ?? by.set(k, []).get(k)!).push(m); }
      table(d, 'Drugs', [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([k, ms]) => [{ v: k, q: `course=${k}` }, String(ms.length), day(dateOf(dated(ms)[0]))]), ['Drug', 'Orders', 'Latest']);
    } else table(d, 'Records', dated(rs).map((r) => [day(dateOf(r)), link(r), r.resourceType === 'Encounter' ? ENC[encounterKind(r)] : (r as Any).status ?? '']), ['Date', 'Name', '']);
    return d;
  }

  return (q) => {
    if (q.ref) { const r = byId.get(q.ref); return r && record(r); }
    if (q.series) return seriesDetail(q.series);
    if (q.course) return course(q.course);
    if (q.dx) return diagnosis(q.dx);
    if (q.list) return list(q.list);
    return undefined;
  };
}
