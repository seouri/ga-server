// ga ui: the record as chronology lanes. buildTimeline is pure (records in, lanes out); loadRecords reads the store.
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Condition, DiagnosticReport, DocumentReference, Encounter, ImagingStudy, Immunization, MedicationRequest, MedicationStatement, Observation, Procedure, Resource, ResourceType } from '@medplum/fhirtypes';
import { cardiacStudy, hasTag } from '../identity.ts';
import { conceptMatch, highLow, searchAll } from '../labs.ts';
import { concepts } from '../concepts.ts';
import { noteText } from '../notes.ts';
import { loadSchedule } from '../vaccines.ts';
import { growthZ, screenZ } from '../growth.ts';

export type Row = [string, string];
export type Ev = { id?: string; t: string; end?: string; label: string; sub?: string; kind?: string; rows?: Row[]; also?: string[]; text?: string; ref?: string; flags?: string[] };
export type EncounterKind = 'inpatient' | 'emergency' | 'procedure' | 'visit' | 'hospital' | 'contact';
export type Course = { label: string; current: boolean; t: string; end: string; orders: { t: string; end: string; status?: string; text?: string }[] };
export type LabSeries = { key: string; label: string; concept?: string; rank?: number; unit?: string; points: [string, number, number | null, number | null, 'high' | 'low' | '', string][] };
const GROWTH_NOTE = 'computed by GA from the clinic reading: WHO growth standards under 2 years, CDC 2000 growth charts from 2 to 20';
export type Wearable = { key: string; label: string; unit: string; draw: 'line' | 'bars' | 'range'; series?: string; computed?: string; // computed: GA worked the points out; how
  doubted?: { t: string; id: string; why: string }[]; // computed points set aside as probable errors: drawn as a question mark, not as a value
  points: [string, number, number?][]; clinic: [string, number, number | undefined, string][] };
export type Timeline = {
  today: string; min: string; max: string;
  encounters: Ev[]; problems: Ev[]; diagnoses: { label: string; dates: string[] }[]; medications: Course[]; procedureDrugs: { t: string; names: string[] }[];
  procedures: Ev[]; studies: Ev[]; immunizations: Ev[]; notes: Ev[]; planned: Ev[];
  labs: LabSeries[]; otherLabs: string[]; wearables: Wearable[];
  left: Record<string, number>; // what the lanes do not draw, by reason
};

const TYPES: [ResourceType, 'subject' | 'patient' | 'beneficiary'][] = [
  ['Encounter', 'subject'], ['Condition', 'subject'], ['MedicationRequest', 'subject'], ['MedicationStatement', 'subject'], ['Procedure', 'subject'],
  ['DiagnosticReport', 'subject'], ['DocumentReference', 'subject'], ['ImagingStudy', 'subject'], ['Immunization', 'patient'], ['Observation', 'subject'],
];
// Drawn on no lane, but part of the record: the detail of a visit lists them, and "All records" does. A store that cannot search one has none.
const MORE: [ResourceType, 'subject' | 'patient' | 'beneficiary'][] = [
  ['AllergyIntolerance', 'patient'], ['CarePlan', 'subject'], ['CareTeam', 'subject'], ['Goal', 'subject'], ['ServiceRequest', 'subject'], ['MedicationDispense', 'subject'],
  ['Specimen', 'subject'], ['FamilyMemberHistory', 'patient'], ['Communication', 'subject'], ['QuestionnaireResponse', 'subject'], ['Coverage', 'beneficiary'],
];
export async function loadRecords(client: MedplumClient, patientId: string): Promise<Resource[]> {
  const pages = await Promise.all([...TYPES.map(([type, p]) => searchAll(client, type, { [p]: `Patient/${patientId}` })),
    ...MORE.map(([type, p]) => searchAll(client, type, { [p]: `Patient/${patientId}` }).catch(() => [] as Resource[]))]);
  return pages.flat();
}

export const text = (c?: CodeableConcept): string | undefined => c?.text ?? c?.coding?.find((x) => x.display)?.display;
export const day = (s?: string): string => (s ?? '').slice(0, 10);
export const hasCat = (r: { category?: CodeableConcept[] | CodeableConcept }, re: RegExp): boolean =>
  [r.category ?? []].flat().some((c) => [c.text, ...(c.coding ?? []).flatMap((x) => [x.code, x.display])].some((s) => !!s && re.test(s)));
// Epic writes many names in capitals. A name with a long word (five letters or more) reads better in title case, its words of
// up to three letters kept (XR, CT, TTE, LDL); a name of short words only is an abbreviation (EGFR, MCHC) and stays.
export const titled = (s: string): string => (s !== s.toUpperCase() || !/[A-Z]{5}/.test(s) ? s : s.replace(/[A-Z]{4,}/g, (w) => w[0] + w.slice(1).toLowerCase()));
const qty = (o: { valueQuantity?: { value?: number; unit?: string; comparator?: string }; valueString?: string; valueCodeableConcept?: CodeableConcept }): string | undefined =>
  o.valueQuantity?.value !== undefined ? `${o.valueQuantity.comparator ?? ''}${o.valueQuantity.value}${o.valueQuantity.unit ? ` ${o.valueQuantity.unit}` : ''}` : o.valueString ?? text(o.valueCodeableConcept);

// Inpatient, emergency, a day procedure, an office or virtual visit, a hospital outpatient visit (imaging, lab, echo), or a contact
// with no visit (refill, orders, telephone). Standard classes first, then Epic's, then the stay's length.
const GENERIC = new Set(['outpatient', 'elective', 'hospital encounter', 'patient encounter procedure', 'appointment']);
export function encounterKind(e: Encounter): EncounterKind {
  const cls = `${e.class?.code ?? ''} ${e.class?.display ?? ''}`.toLowerCase();
  const types = (e.type ?? []).map((t) => (text(t) ?? '').toLowerCase());
  const any = (re: RegExp) => re.test(cls) || types.some((t) => re.test(t));
  const hours = e.period?.start && e.period.end ? (Date.parse(e.period.end) - Date.parse(e.period.start)) / 3.6e6 : 0;
  if (any(/\b(emer|emergency|ed arrival)\b/)) return 'emergency';
  if (any(/\b(imp|acute|nonac|inpatient|admission|obsenc)\b/) || hours >= 24) return 'inpatient';
  if (any(/support op|\b(refill|orders only|system generated|documentation|telephone|message)\b/)) return 'contact';
  if (any(/\b(surgery|day surgery)\b/) || /discharge/.test(cls)) return 'procedure';
  if (/\bhov\b/.test(cls) || (types.includes('hospital encounter') && !/appointment/.test(cls))) return 'hospital';
  return 'visit';
}
export const encounterLabel = (e: Encounter): string => {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const types = (e.type ?? []).map((t) => text(t) ?? '').filter((t) => t && !GENERIC.has(t.toLowerCase()) && !/^PR /.test(t))
    .filter((t, i, a) => a.findIndex((x) => norm(x) === norm(t)) === i).map(titled); // "Follow-Up" and "FOLLOW UP" are one
  return (types.slice(0, 2).join(', ') || text(e.type?.[0]) || e.class?.display || 'Encounter');
};

export const drugName = (r: MedicationRequest | MedicationStatement): string => text(r.medicationCodeableConcept) ?? r.medicationReference?.display ?? 'Medication';
// One row per drug: the name up to its strength ("sertraline 100 mg tablet" and "sertraline 50 mg tablet" are one course).
// One series per test or measure. Apple Health readings go by their name (home readings stay apart from clinic ones). Lab results
// and vital signs go by their LOINC code, else their name: Epic puts the generic "vital signs" code (8716-3) before the specific
// one, so that code never names a series. Anything else (exam findings, assessments) goes by its name: one code there can cover
// the left and the right eye.
const GENERIC_LOINC = new Set(['8716-3', '85353-1']);
const loinc = (c?: CodeableConcept) => c?.coding?.find((x) => x.system === 'http://loinc.org' && !GENERIC_LOINC.has(x.code ?? ''))?.code;
export const seriesKey = (o: Observation): string => {
  const name = text(o.code) ?? '';
  if (hasTag(o, 'src-apple-health')) return `apple|${name}`;
  const code = hasCat(o, /^(laboratory|vital-signs)$/) ? loinc(o.code) : undefined;
  return code ?? `text|${name.toLowerCase()}`;
};
export const drugKey = (name: string): string => (/^[^\d(]+/.exec(name)?.[0] ?? name).trim().toLowerCase().replace(/\s+(tablet|capsule|oral|topical)$/, '') || name.toLowerCase();

// person: the patient's sex and birth date, for a child's growth z-scores (none drawn without both).
export function buildTimeline(all: Resource[], today: string, person: { gender?: string; birthDate?: string } = {}): Timeline {
  const of = <T extends Resource>(type: T['resourceType']) => all.filter((r): r is T => r.resourceType === type);
  const left: Record<string, number> = {};
  const skip = (why: string, n = 1) => { left[why] = (left[why] ?? 0) + n; };
  const byId = new Map(all.map((r) => [`${r.resourceType}/${r.id}`, r]));
  const flagsOf = (r: Resource): string[] | undefined => {
    const f = [hasTag(r, 'extracted-by-llm') && 'read by AI from a document', hasTag(r, 'src-apple-clinical') && 'from Apple Health records'].filter((x): x is string => !!x);
    return f.length ? f : undefined;
  };

  // Encounters. A day procedure is recorded twice by Epic (the hospital encounter and its surgery log): one mark per day.
  const encounters: Ev[] = [];
  const procDay = new Map<string, Ev>();
  for (const e of of<Encounter>('Encounter')) {
    const t = e.period?.start;
    if (!t) { skip('encounters without a date'); continue; }
    const kind = encounterKind(e);
    const where = e.location?.[0]?.location?.display, who = e.participant?.map((p) => p.individual?.display).filter(Boolean).slice(0, 2).join(', ');
    const reason = e.reasonCode?.map((c) => text(c)).filter(Boolean).join('; ');
    const rows: Row[] = [['Kind', kind], ...(where ? [['Where', where] as Row] : []), ...(who ? [['With', who] as Row] : []), ...(reason ? [['Reason', reason] as Row] : []),
      ...(e.period?.end && e.period.end !== t ? [['Until', e.period.end.replace('T', ' ').slice(0, 16)] as Row] : [])];
    const ev: Ev = { id: e.id, ref: `Encounter/${e.id}`, t, end: e.period?.end !== t ? e.period?.end : undefined, label: kind === 'procedure' ? 'Day procedure' : encounterLabel(e), sub: where, kind, rows };
    if (kind === 'procedure') {
      const had = procDay.get(day(t));
      if (had) { // the second record of the same day: keep the longer period, list both
        if (!had.end && ev.end) { had.end = ev.end; had.t = ev.t; }
        had.rows = [...(had.rows ?? []), ...rows.filter(([k]) => !had.rows?.some(([h]) => h === k))];
        skip('second encounter records of a day procedure (the surgery log)');
        continue;
      }
      procDay.set(day(t), ev);
    }
    encounters.push(ev);
  }
  const encDay = (ref?: string) => day((byId.get(ref ?? '') as Encounter | undefined)?.period?.start);

  // Problems (the problem list) as intervals; diagnoses coded at visits as one row of dates per diagnosis.
  const problems: Ev[] = [];
  const dx = new Map<string, Set<string>>();
  for (const c of of<Condition>('Condition')) {
    const label = text(c.code) ?? 'Condition';
    if (hasCat(c, /^problem-list-item$/)) {
      const t = c.onsetDateTime ?? c.onsetPeriod?.start ?? c.recordedDate;
      if (!t) { skip('problems without a date'); continue; }
      problems.push({ id: c.id, ref: `Condition/${c.id}`, t, end: c.abatementDateTime, label, kind: text(c.clinicalStatus)?.toLowerCase(), rows: [['On the problem list since', day(t)], ...(c.recordedDate ? [['Recorded', day(c.recordedDate)] as Row] : [])] });
    } else {
      const t = encDay(c.encounter?.reference) || day(c.onsetDateTime ?? c.recordedDate);
      if (!t) { skip('visit diagnoses without a date'); continue; }
      (dx.get(label) ?? dx.set(label, new Set()).get(label)!).add(t);
    }
  }
  problems.sort((a, b) => a.t.localeCompare(b.t));
  const diagnoses = [...dx].map(([label, d]) => ({ label, dates: [...d].sort() })).sort((a, b) => b.dates.length - a.dates.length);

  // Medications: one course per drug. Drugs given during a procedure (category inpatient) are listed with that day, not as courses.
  const courses = new Map<string, Course>();
  const given = new Map<string, Set<string>>();
  for (const m of [...of<MedicationRequest>('MedicationRequest'), ...of<MedicationStatement>('MedicationStatement')]) {
    const name = drugName(m);
    const mr = m as MedicationRequest, ms = m as MedicationStatement;
    const t = mr.authoredOn ?? ms.effectivePeriod?.start ?? ms.effectiveDateTime ?? ms.dateAsserted;
    if (!t) { skip('medications without a date'); continue; }
    // inpatient or outpatient: given in a care setting (a day procedure's sedation), not a prescription (community, discharge)
    if (hasCat(mr, /^(inpatient|outpatient)$/) && !hasCat(mr, /^(community|discharge)$/)) { (given.get(day(t)) ?? given.set(day(t), new Set()).get(day(t))!).add(name); continue; }
    if (mr.intent === 'plan' || mr.intent === 'proposal') { skip('planned or patient-reported medication entries'); continue; }
    const active = m.status === 'active';
    const stop = mr.dispenseRequest?.validityPeriod?.end ?? mr.dosageInstruction?.[0]?.timing?.repeat?.boundsPeriod?.end ?? ms.effectivePeriod?.end;
    const end = active ? today : stop && stop > t ? stop : t;
    const key = drugKey(name);
    const c = courses.get(key) ?? courses.set(key, { label: key, current: false, t, end, orders: [] }).get(key)!;
    c.orders.push({ t, end, status: m.status, text: name });
    if (t < c.t) c.t = t;
    if (end > c.end) c.end = end;
    c.current ||= active;
  }
  const medications = [...courses.values()].map((c) => ({ ...c, orders: c.orders.sort((a, b) => a.t.localeCompare(b.t)) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.end.localeCompare(a.end));
  const procedureDrugs = [...given].map(([t, n]) => ({ t, names: [...n].sort() })).sort((a, b) => a.t.localeCompare(b.t));

  // Studies: imaging, cardiology (echo, ECG), pathology and microbiology reports, and DICOM studies. A cardiology report lists
  // its measurements; those Observations never count as labs (cardiacStudy).
  const studies: Ev[] = [];
  const inStudy = new Set<string>();
  // The report of a procedure (an endoscopy report) is shown with that procedure, which links to it.
  const ofProcedure = new Set(of<Procedure>('Procedure').flatMap((p) => (p.report ?? []).map((x) => x.reference)));
  const ordered = new Map<string, string>(); // day|order name -> the study, to fold the Procedure record of the same test
  for (const d of of<DiagnosticReport>('DiagnosticReport')) {
    const cardiac = cardiacStudy(d);
    const kind = cardiac ?? (hasCat(d, /^(path|pathology|cyt)/i) ? 'pathology' : hasCat(d, /^micro/i) ? 'microbiology' : hasCat(d, /cardiology|^vasc/i) ? 'cardiac'
      : hasCat(d, /^neurology$/i) ? 'neurology' : hasCat(d, /imaging|radiology|LP29684-5/i) ? 'imaging' : hasCat(d, /^lab/i) ? undefined : 'other');
    if (!kind) continue; // a lab panel: its results are the lab lane
    // (an echo or imaging report that an order-type Procedure points to stays a study: that Procedure folds into it below)
    if (kind === 'other' && ofProcedure.has(`DiagnosticReport/${d.id}`)) { skip('reports of a procedure (endoscopy, audiology), opened from that procedure'); continue; }
    const t = d.effectiveDateTime ?? d.effectivePeriod?.start ?? d.issued;
    if (!t) { skip('reports without a date'); continue; }
    const rows: Row[] = [];
    for (const ref of d.result ?? []) {
      const o = byId.get(ref.reference ?? '') as Observation | undefined;
      if (!o) continue;
      inStudy.add(`Observation/${o.id}`);
      const v = qty(o);
      if (v !== undefined && v.length < 80) rows.push([titled(text(o.code) ?? 'Result'), v]);
    }
    const label = titled(text(d.code) ?? d.basedOn?.[0]?.display ?? 'Report');
    for (const b of d.basedOn ?? []) if (b.display) ordered.set(`${day(t)}|${b.display.toLowerCase()}`, label);
    studies.push({ id: d.id, t, label, kind, rows, text: d.conclusion, ref: `DiagnosticReport/${d.id}`, flags: flagsOf(d) });
  }
  for (const s of of<ImagingStudy>('ImagingStudy')) {
    if (!s.started) { skip('imaging studies without a date'); continue; }
    const mods = [...new Set((s.series ?? []).map((x) => x.modality?.code).filter((m) => m && m !== 'DOC' && m !== 'OT'))].join(', ');
    studies.push({ id: s.id, ref: `ImagingStudy/${s.id}`, t: s.started, label: `${mods || 'Imaging'}: ${(s.description ?? 'study').replace(/\s*\(study time[^)]*\)/, '')}`, kind: 'imaging',
      rows: [['Series', String(s.numberOfSeries ?? s.series?.length ?? '')], ['Images', String(s.numberOfInstances ?? '')], ['Source', 'DICOM files (images are kept in the archive, not shown)']] });
  }
  studies.sort((a, b) => a.t.localeCompare(b.t));

  // Procedures: Epic records an endoscopy as an order-based record and a surgical one. One mark per surgical record; the others
  // of that day are listed under it. A procedure that is the order of a study of that day (an echo) is that study, not a second mark.
  const procedures: Ev[] = [];
  const byDay = new Map<string, Procedure[]>();
  for (const p of of<Procedure>('Procedure')) {
    const t = p.performedDateTime ?? p.performedPeriod?.start;
    if (!t) { skip('procedures without a date'); continue; }
    if (ordered.has(`${day(t)}|${(text(p.code) ?? '').toLowerCase()}`)) { skip('procedure records that are the order of a study shown in Studies'); continue; }
    (byDay.get(day(t)) ?? byDay.set(day(t), []).get(day(t))!).push(p);
  }
  for (const ps of byDay.values()) {
    const surgical = ps.filter((p) => hasCat(p, /^387713003$|surgical/i));
    const shown = surgical.length ? surgical : ps;
    const folded = surgical.length ? ps.filter((p) => !surgical.includes(p)).map((p) => titled(text(p.code) ?? 'Procedure')) : [];
    if (folded.length) skip('procedure records folded into the same procedure of that day', folded.length);
    for (const p of shown) {
      const t = (p.performedDateTime ?? p.performedPeriod?.start)!;
      procedures.push({ id: p.id, ref: `Procedure/${p.id}`, t, label: titled(text(p.code) ?? 'Procedure'), also: folded.length ? folded : undefined, rows: [['Status', p.status ?? ''], ...(given.has(day(t)) ? [['Drugs given that day', [...given.get(day(t))!].join(', ')] as Row] : [])] });
    }
  }
  procedures.sort((a, b) => a.t.localeCompare(b.t));

  const cvx = new Map(loadSchedule().vaccines.flatMap((v) => v.cvx.map((c) => [c.replace(/^0+(?=\d)/, ''), v.name] as [string, string])));
  const immunizations: Ev[] = of<Immunization>('Immunization').flatMap((i) => {
    const t = i.occurrenceDateTime;
    if (!t) { skip('immunizations without a date'); return []; }
    const code = i.vaccineCode?.coding?.find((c) => c.system?.endsWith('/cvx'))?.code?.replace(/^0+(?=\d)/, '');
    return [{ id: i.id, ref: `Immunization/${i.id}`, t, label: text(i.vaccineCode) ?? (code && cvx.get(code)) ?? 'Vaccine (name not recorded)' }];
  }).sort((a, b) => a.t.localeCompare(b.t));

  // Notes: clinical notes by kind. Encounter summary documents and stored source files are not notes.
  // Epic gives a note a new id when it is revised or re-exported, so two exports of one hospital can hold the same note twice:
  // a note with the same day, kind and text as one already placed is that note.
  const notes: Ev[] = [];
  const sameNote = new Set<string>();
  for (const d of of<DocumentReference>('DocumentReference')) {
    if (!hasCat(d, /^clinical-note$/)) { skip(hasCat(d, /^summary-document$/) ? 'encounter summary documents' : 'stored source files and archives'); continue; }
    if (!d.date) { skip('notes without a date'); continue; }
    const body = noteText(d)?.replace(/\s+/g, ' ').trim();
    if (body) { const k = `${day(d.date)}|${text(d.type)}|${body}`; if (sameNote.has(k)) { skip('notes stored twice with the same day, kind and text (two exports of one hospital)'); continue; } sameNote.add(k); }
    notes.push({ id: d.id, t: d.date, label: text(d.type) ?? 'Note', sub: d.author?.[0]?.display, kind: text(d.type) ?? 'Note', ref: `DocumentReference/${d.id}` });
  }
  notes.sort((a, b) => a.t.localeCompare(b.t));

  // Labs: numeric results as one series per test. Wearables and clinic vitals: a few series, home and clinic kept apart.
  const labs = new Map<string, LabSeries>();
  const otherLabs: string[] = [];
  const W: Record<string, Wearable> = {
    weight: { key: 'weight', label: 'Weight', unit: 'kg', draw: 'line', points: [], clinic: [] },
    // Growth measures of a child's record: clinic readings only.
    weightZ: { key: 'weightZ', label: 'Weight z-score', unit: 'SD', draw: 'line', points: [], clinic: [], computed: GROWTH_NOTE },
    height: { key: 'height', label: 'Height', unit: 'cm', draw: 'line', points: [], clinic: [] },
    heightZ: { key: 'heightZ', label: 'Height z-score', unit: 'SD', draw: 'line', points: [], clinic: [], computed: GROWTH_NOTE },
    head: { key: 'head', label: 'Head circumference', unit: 'cm', draw: 'line', points: [], clinic: [] },
    bmiPct: { key: 'bmiPct', label: 'BMI percentile', unit: '%', draw: 'line', points: [], clinic: [] },
    bp: { key: 'bp', label: 'Blood pressure', unit: 'mmHg', draw: 'range', points: [], clinic: [] },
    rhr: { key: 'rhr', label: 'Resting heart rate', unit: '/min', draw: 'line', points: [], clinic: [] },
    steps: { key: 'steps', label: 'Steps per day', unit: '', draw: 'bars', points: [], clinic: [] },
    sleep: { key: 'sleep', label: 'Sleep per night', unit: 'h', draw: 'bars', points: [], clinic: [] },
    fat: { key: 'fat', label: 'Body fat', unit: '%', draw: 'line', points: [], clinic: [] },
  };
  // A key lab (GA's lab concepts, in their order: A1c, glucose, lipids, kidney, liver, blood count, electrolytes, TSH) gets a row first.
  const order = concepts().filter((c) => c.kind === 'lab').map((c) => c.name);
  const keyLab = (o: Observation) => { const m = conceptMatch(o); const rank = m && !m.suggested ? order.indexOf(m.concept.name) : -1; return rank < 0 ? {} : { concept: m!.concept.name, rank }; };
  const bpOf = (o: Observation): [number, number] | undefined => {
    const part = (codes: string[], re: RegExp) => o.component?.find((c) => codes.includes(loinc(c.code) ?? '') || re.test(text(c.code) ?? ''))?.valueQuantity?.value;
    const s = part(['8480-6'], /systolic/i), d = part(['8462-4'], /diastolic/i);
    return s !== undefined && d !== undefined ? [s, d] : undefined;
  };
  // A source that files systolic and diastolic pressure as two records of one instant (Epic C-CDA): paired after the loop.
  const halves = new Map<string, { s?: number; d?: number; id: string }>();
  const length = (o: Observation, v: number): number | undefined => {
    const u = (o.valueQuantity?.code ?? o.valueQuantity?.unit ?? '').toLowerCase();
    return u === 'cm' ? v : u === '[in_i]' || u === 'in' || u === 'inch' || u === 'inches' ? Math.round(v * 25.4) / 10 : u === 'm' ? Math.round(v * 1000) / 10 : undefined;
  };
  for (const o of of<Observation>('Observation')) {
    const t = o.effectiveDateTime ?? o.effectivePeriod?.start;
    const name = text(o.code) ?? '', code = loinc(o.code), v = o.valueQuantity?.value;
    if (hasTag(o, 'src-apple-health')) {
      if (!t) continue;
      const bp = /blood pressure/i.test(name) || code === '85354-9' ? bpOf(o) : undefined;
      const into = (w: Wearable, p: [string, number, number?]) => { w.series ??= seriesKey(o); w.points.push(p); };
      if (bp) into(W.bp, [t, bp[0], bp[1]]);
      else if (v === undefined) skip('Apple Health records with no single value (activity rings and the like)');
      else if (/^body weight$/i.test(name)) into(W.weight, [t, v]);
      else if (/^resting heart rate$/i.test(name)) into(W.rhr, [t, v]);
      else if (/^steps, daily total/i.test(name)) into(W.steps, [t, v]);
      else if (/^sleep, nightly/i.test(name)) into(W.sleep, [o.effectivePeriod?.end ?? t, Math.round(v / 6) / 10]);
      else if (/^body fat percentage$/i.test(name)) into(W.fat, [t, v]);
      else skip('Apple Health series not drawn yet (distance, flights, BMI, lean mass, daily mean heart rate, steadiness, cycling)');
      continue;
    }
    if (!t) { skip('hospital observations without a date (exam findings)'); continue; }
    if (cardiacStudy(o) || inStudy.has(`Observation/${o.id}`)) continue; // shown with its report in Studies
    if (hasCat(o, /^vital-signs$/)) {
      const bp = bpOf(o);
      if (bp) W.bp.clinic.push([t, bp[0], bp[1], o.id ?? '']);
      else if (v !== undefined && (code === '29463-7' || /^weight$/i.test(name))) {
        const u = (o.valueQuantity?.code ?? o.valueQuantity?.unit ?? '').toLowerCase();
        if (u === 'kg') W.weight.clinic.push([t, v, undefined, o.id ?? '']);
        else if (u === '[lb_av]' || u === 'lb' || u === 'lbs') W.weight.clinic.push([t, Math.round(v * 4.5359237) / 10, undefined, o.id ?? '']);
        else skip('clinic weights in a unit the page does not convert');
      }
      else if (v !== undefined && (code === '8480-6' || code === '8462-4' || /^(systolic|diastolic) blood pressure$/i.test(name))) {
        const h = halves.get(t) ?? halves.set(t, { id: o.id ?? '' }).get(t)!;
        if (code === '8480-6' || /^systolic/i.test(name)) h.s = v; else h.d = v;
      }
      else if (v !== undefined && (code === '8302-2' || code === '8306-3' || /^(body )?height$/i.test(name))) {
        const cm = length(o, v);
        if (cm === undefined) skip('clinic heights in a unit the page does not convert'); else W.height.clinic.push([t, cm, undefined, o.id ?? '']);
      }
      else if (v !== undefined && (code === '9843-4' || code === '8287-5' || (/head.*circumference/i.test(name) && !/percentile/i.test(name)))) {
        const cm = length(o, v);
        if (cm === undefined) skip('clinic head circumferences in a unit the page does not convert'); else W.head.clinic.push([t, cm, undefined, o.id ?? '']);
      }
      else if (v !== undefined && (code === '59576-9' || /^(body mass index|bmi).*percentile/i.test(name))) W.bmiPct.clinic.push([t, v, undefined, o.id ?? '']);
      else skip('clinic vital signs not drawn yet (pulse, temperature, monitoring during procedures)');
      continue;
    }
    if (!hasCat(o, /^laboratory$/)) { skip('assessments, exam findings and social history'); continue; }
    if (v === undefined || o.valueQuantity?.comparator) { otherLabs.push(t); continue; }
    const key = seriesKey(o);
    const s = labs.get(key) ?? labs.set(key, { key, label: titled(name || 'Lab result'), ...keyLab(o), unit: o.valueQuantity?.unit, points: [] }).get(key)!;
    const r = o.referenceRange?.[0];
    s.points.push([t, v, r?.low?.value ?? null, r?.high?.value ?? null, highLow(o) ?? '', o.id ?? '']);
  }
  // Both halves at one instant are one reading, unless a record with both parts already gave that reading.
  const whole = new Set(W.bp.clinic.map((p) => `${p[0]}|${p[1]}|${p[2]}`));
  for (const [t, h] of halves) {
    if (h.s === undefined || h.d === undefined) skip('clinic blood pressures with only one of systolic and diastolic');
    else if (!whole.has(`${t}|${h.s}|${h.d}`)) W.bp.clinic.push([t, h.s, h.d, h.id]);
  }
  // Growth z-scores: one for each clinic weight and height that has a reference at that age (birth to 20 years).
  for (const [from, to, measure] of [[W.weight, W.weightZ, 'weight'], [W.height, W.heightZ, 'height']] as const) {
    const zs: [string, number, undefined, string][] = [];
    for (const p of [...from.clinic].sort((a, b) => a[0].localeCompare(b[0]))) {
      const g = growthZ(measure, person.gender, person.birthDate, p[0], p[1]);
      if (g) zs.push([p[0], Math.round(g.z * 100) / 100, undefined, p[3]]);
    }
    // Probable errors (docs/z-scores.md) are set aside, not drawn as values.
    const why = screenZ(zs.map((p) => ({ t: p[0], z: p[1] })));
    zs.forEach((p, i) => { if (why[i]) (to.doubted ??= []).push({ t: p[0], id: p[3], why: why[i] as string }); else to.clinic.push(p); });
  }
  const bySeries = [...labs.values()].map((s) => ({ ...s, points: s.points.sort((a, b) => a[0].localeCompare(b[0])) })).sort((a, b) => b.points.length - a.points.length);
  const wearables = Object.values(W).filter((w) => w.points.length || w.clinic.length)
    .map((w) => ({ ...w, points: w.points.sort((a, b) => a[0].localeCompare(b[0])), clinic: w.clinic.sort((a, b) => a[0].localeCompare(b[0])) }));

  const dates = [...encounters, ...problems, ...procedures, ...studies, ...immunizations, ...notes].map((e) => e.t)
    .concat(medications.map((m) => m.t), bySeries.flatMap((s) => s.points[0]?.[0] ?? []), wearables.flatMap((w) => w.points[0]?.[0] ?? []), diagnoses.flatMap((d) => d.dates[0] ?? []));
  const min = dates.reduce((a, b) => (day(b) < a ? day(b) : a), today);
  return { today, min, max: today, encounters: encounters.sort((a, b) => a.t.localeCompare(b.t)), problems, diagnoses, medications, procedureDrugs, procedures, studies, immunizations, notes, planned: [], labs: bySeries, otherLabs: otherLabs.sort(), wearables, left };
}
