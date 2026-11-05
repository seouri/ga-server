import { getStatus, type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Extension, Identifier, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { GaError } from './config.ts';
import { contentHash, contentKey, EPIC_OID, effective, SINGULAR_ID, stableIdentifier, stamp, type SourceInfo } from './identity.ts';
import { collapsePatients, walkReferences } from './patient.ts';

export type Decision = 'create' | 'update' | 'skip' | 'conflict';
export type ImportReport = {
  created: number;
  updated: number;
  skipped: number;
  merged: number;
  conflicts: number;
  possibleDuplicates: number;
  invalid: number;
};

type R = Resource & { identifier?: Identifier[]; extension?: Extension[] };
export const TAG = 'urn:ga-server:tag';
const SRC_DATE = 'urn:ga-server:ext:source-date';
export const DUP_OF = 'urn:ga-server:ext:possible-duplicate-of';
const KEPT_TAGS = ['possible-duplicate', 'source-conflict'];
// Patient-compartment types and the field (= Medplum search param) naming the patient; link lookups are scoped by it.
const COMPARTMENT: Record<string, string> = {
  ...Object.fromEntries(
    ['Observation', 'DiagnosticReport', 'Encounter', 'Condition', 'MedicationRequest', 'MedicationStatement', 'MedicationAdministration',
      'MedicationDispense', 'Procedure', 'DocumentReference', 'Communication', 'QuestionnaireResponse', 'ServiceRequest', 'CarePlan', 'Goal',
      'Composition', 'Specimen', 'ImagingStudy', 'Media', 'List', 'CareTeam', 'ClinicalImpression', 'RiskAssessment', 'Flag', 'DeviceRequest',
      'DeviceUseStatement'].map((t) => [t, 'subject']),
  ),
  ...Object.fromEntries(['Immunization', 'AllergyIntolerance', 'FamilyMemberHistory', 'Device', 'EpisodeOfCare', 'Consent'].map((t) => [t, 'patient'])),
  Coverage: 'beneficiary',
};
// Not patient data: linked globally. Any other type is not linked.
const SHARED = new Set(['Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication']);
// Medplum's validator reports 400 with structure/invariant issues carrying an element path. Generic 'invalid'
// (badRequest, e.g. bad search params), server errors and anything without a path are not per-resource validation.
const VALIDATION = ['structure', 'invariant', 'value', 'required'];
const isValidationFailure = (e: unknown): e is OperationOutcomeError => {
  if (!(e instanceof OperationOutcomeError)) return false;
  const issues = e.outcome.issue ?? [];
  return getStatus(e.outcome) === 400 && issues.length > 0 && issues.every((i) => VALIDATION.includes(i.code) && !!i.expression?.length);
};

const hasTag = (r: Resource, code: string) => !!r.meta?.tag?.some((t) => t.system === TAG && t.code === code);
const srcDate = (r: R) => r.extension?.find((e) => e.url === SRC_DATE)?.valueDateTime;
const idKey = (i: Identifier) => `${i.system}|${i.value}`;
const idList = (r: R): Identifier[] => [r.identifier ?? []].flat(); // singular on SINGULAR_ID types
const canon = (x: unknown) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );

// Equality ignores id, meta, our bookkeeping extensions and identifiers; identifiers only need incoming ⊆ existing,
// because existing accumulates extra identifiers from merges.
function body(r: R): unknown {
  const { id: _i, meta: _m, identifier: _id, extension, ...rest } = r;
  const ext = (extension ?? []).filter((e) => e.url !== SRC_DATE && e.url !== DUP_OF);
  return ext.length ? { ...rest, extension: ext } : rest;
}

// R11: an EHI export leaves out what it doesn't know, so its update keeps the existing top-level fields it lacks
// (its own fields win). Never kept: a field contradicting the incoming record, or the old narrative.
// C-CDA bodies are complete documents and replace as before.
const BOOKKEEPING = new Set(['id', 'meta', 'identifier', 'extension', 'text']);
// Choice-type element base (onsetDateTime -> onset), so an incoming onsetX replaces any existing onsetY.
const choiceBase = (k: string) => k.replace(/(DateTime|Date|Period|Age|Range|String|Quantity|CodeableConcept|Reference|Boolean|Integer|Instant|Time|Timing|Ratio|SampledData|Attachment|Duration)$/, '');
const code0 = (c: unknown) => (c as { coding?: { code?: string }[] } | undefined)?.coding?.[0]?.code;
function fillFrom(existing: R, incoming: R, s: SourceInfo): R {
  if (s.kind !== 'ehi') return incoming;
  const inc = incoming as unknown as Record<string, unknown>;
  const incBases = new Set(Object.keys(inc).filter((k) => inc[k] !== undefined).map(choiceBase));
  const drop = (k: string): boolean => {
    if (BOOKKEEPING.has(k) || inc[k] !== undefined || incBases.has(choiceBase(k))) return true;
    if (incoming.resourceType !== 'Condition') return false;
    // An open problem has no abatement; an entered-in-error one has neither clinical status nor abatement (con-3, con-4).
    if (code0(inc.verificationStatus) === 'entered-in-error') return k === 'clinicalStatus' || k.startsWith('abatement');
    return k.startsWith('abatement') && !!inc.clinicalStatus && !['resolved', 'inactive', 'remission'].includes(code0(inc.clinicalStatus) ?? '');
  };
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !drop(k)));
  return { ...kept, ...incoming } as R;
}

// Records carrying any of these Epic ids (scoped to the patient for compartment types), and those of them not yet
// holding an identifier in the incoming stable system. Exactly one free candidate is a link; shared with the EHI pre-pass.
export async function linkCandidates(
  client: MedplumClient,
  type: string,
  epic: Identifier[],
  patientId: string,
  stableSystem: string,
): Promise<{ found: Resource[]; free: Resource[] }> {
  const field = COMPARTMENT[type];
  const found = new Map<string, R>();
  for (const i of epic) {
    const q = new URLSearchParams([['identifier', idKey(i)], ...(field ? [[field, `Patient/${patientId}`]] : [])]);
    for (const c of (await client.searchResources(type as Resource['resourceType'], q, { cache: 'no-cache' })) as R[]) found.set(c.id as string, c);
  }
  const free = [...found.values()].filter((c) => !idList(c).some((x) => x.system === stableSystem));
  return { found: [...found.values()], free };
}

// author: GA's own writer reference (ClientApplication/<id>); a record last changed by anyone else is a person's edit.
export function decide(existingRes: Resource | undefined, incomingRes: Resource, author?: string): Decision {
  if (!existingRes) return 'create';
  const existing = existingRes as R;
  const incoming = incomingRes as R;
  const ed = srcDate(existing);
  const id = srcDate(incoming);
  if (ed && id && Date.parse(id) <= Date.parse(ed)) return 'skip';
  const have = new Set(idList(existing).map(idKey));
  const subset = idList(incoming).every((i) => have.has(idKey(i)));
  if (subset && canon(body(existing)) === canon(body(incoming))) return 'skip';
  // Only a write that would actually happen is a conflict. The source-conflict tag sticks: tagging it made GA the author.
  const lastBy = existing.meta?.author?.reference;
  if ((author && lastBy && lastBy !== author) || hasTag(existing, 'source-conflict')) return 'conflict';
  return hasTag(existing, 'writer-agent') && hasTag(incoming, 'writer-importer') ? 'conflict' : 'update';
}

const sourceKeys = (r: Resource) => (r.id ? [`${r.resourceType}/${r.id}`, `urn:uuid:${r.id}`] : []);

function topoSort(rs: Resource[]): Resource[] {
  const byKey = new Map<string, Resource>();
  for (const r of rs) for (const k of sourceKeys(r)) byKey.set(k, r);
  const out: Resource[] = [];
  const state = new Map<Resource, 'visiting' | 'done'>();
  const visit = (r: Resource, path: Resource[]) => {
    if (state.get(r) === 'done') return;
    if (state.get(r) === 'visiting') {
      const cycle = path.slice(path.indexOf(r)).map((x) => `${x.resourceType}/${x.id}`);
      throw new GaError(`reference cycle: ${cycle.join(', ')}`);
    }
    state.set(r, 'visiting');
    walkReferences(r, (ref) => {
      const dep = byKey.get(ref);
      if (dep && dep !== r) visit(dep, [...path, r]);
      return undefined;
    });
    state.set(r, 'done');
    out.push(r);
  };
  for (const r of rs) visit(r, []);
  return out;
}

const withTag = (r: Resource, code: string): Resource => ({ ...r, meta: { ...r.meta, tag: [...(r.meta?.tag ?? []), { system: TAG, code }] } });

// R19: coded values compare by their first coding (system|code); a coding-less concept never matches.
const firstCoding = (o: Observation) => {
  const c = o.valueCodeableConcept?.coding?.[0];
  return c?.code ? `${c.system ?? ''}|${c.code}` : undefined;
};
export function sameValue(a: Observation, b: Observation): boolean {
  if (a.valueQuantity && b.valueQuantity) return a.valueQuantity.value === b.valueQuantity.value && a.valueQuantity.unit === b.valueQuantity.unit;
  if (a.valueCodeableConcept && b.valueCodeableConcept) return !!firstCoding(a) && firstCoding(a) === firstCoding(b);
  if (a.valueBoolean !== undefined || b.valueBoolean !== undefined) return a.valueBoolean === b.valueBoolean;
  return a.valueString !== undefined && a.valueString === b.valueString;
}

// Incoming body wins; keeps identifiers from merges, review tags and possible-duplicate pointers.
async function unionUpdate(client: MedplumClient, existing: R, incoming: R): Promise<void> {
  const ids = idList(existing);
  for (const i of idList(incoming)) if (!ids.some((x) => idKey(x) === idKey(i))) ids.push(i);
  const kept = (existing.meta?.tag ?? []).filter((t) => t.system === TAG && KEPT_TAGS.includes(t.code as string) && !hasTag(incoming, t.code as string));
  const dupOf = (existing.extension ?? []).filter((e) => e.url === DUP_OF);
  await client.updateResource({
    ...incoming,
    id: existing.id,
    identifier: SINGULAR_ID.has(incoming.resourceType) ? incoming.identifier : ids,
    meta: { ...incoming.meta, tag: [...(incoming.meta?.tag ?? []), ...kept] },
    extension: [...(incoming.extension ?? []), ...dupOf],
  } as Resource);
}

export async function importResources(
  client: MedplumClient,
  resources: Resource[],
  source: SourceInfo,
  patientId: string,
  fileHash: string,
): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0 };
  const { resources: collapsed, patientIdentifiers } = collapsePatients(resources, patientId);
  const ordered = topoSort(collapsed); // throws before any write
  const me = client.getProfile();
  const author = me ? `${me.resourceType}/${me.id}` : undefined;
  // A GA write onto a record a person last changed makes GA its author: keep it protected with the sticky source-conflict tag.
  const protect = (r: Resource): Resource => {
    const lastBy = r.meta?.author?.reference;
    return author && lastBy && lastBy !== author && !hasTag(r, 'source-conflict') ? withTag(r, 'source-conflict') : r;
  };

  const patient = await client.readResource('Patient', patientId);
  const have = new Set((patient.identifier ?? []).map(idKey));
  const missing: Identifier[] = [];
  for (const i of patientIdentifiers) {
    if (have.has(idKey(i))) continue;
    have.add(idKey(i));
    missing.push(i);
  }
  // Demographics fill only what the GA Patient lacks; a differing source value is logged (field name only), never applied.
  const next: Patient = { ...patient };
  for (const sp of resources.filter((r): r is Patient => r.resourceType === 'Patient')) {
    for (const f of ['birthDate', 'gender', 'name'] as const) {
      const v = sp[f];
      if (v === undefined || (Array.isArray(v) && !v.length)) continue;
      if (next[f] === undefined || (Array.isArray(next[f]) && !(next[f] as unknown[]).length)) Object.assign(next, { [f]: v });
      else if (JSON.stringify(next[f]) !== JSON.stringify(v)) console.error(`patient demographic conflict: ${f}`);
    }
  }
  const filled = (['birthDate', 'gender', 'name'] as const).some((f) => next[f] !== patient[f]);
  if (missing.length || filled) await client.updateResource<Patient>({ ...next, identifier: [...(patient.identifier ?? []), ...missing] });

  // Same stable identifier twice in one batch with different content would make the second a silent skip:
  // give every member of such a group source id + content hash (deterministic, order-independent).
  const keyOf = (r: Resource) => stableIdentifier(r, source, fileHash, patientId).value as string;
  const groups = new Map<string, Set<string>>();
  for (const r of ordered) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k)?.add(contentHash(r, patientId));
  }
  const colliding = new Set([...groups].filter(([, h]) => h.size > 1).map(([k]) => k));
  for (const r of ordered) if (colliding.has(keyOf(r))) console.error(`source id collision: ${r.resourceType}`);

  // Link lookup by Epic id. A candidate that already has an identifier in the incoming stable system is a different
  // record from the same kind of source (Epic reuses entry ids; one batch must not merge into itself). One remaining
  // candidate is a link; several, or only same-source ones, are possible duplicates (C-CDA excepted: milestone 1 already
  // tells same-id entries apart by content, and real documents reuse ids across whole groups of entries).
  const linkHit = async (incoming: R, ident: Identifier): Promise<{ hit?: R; dups: R[] }> => {
    const type = incoming.resourceType;
    const field = COMPARTMENT[type];
    if (!field && !SHARED.has(type)) return { dups: [] };
    const ref = field && (incoming as unknown as Record<string, { reference?: string } | undefined>)[field]?.reference;
    const epic = idList(incoming).filter((x) => x.system?.startsWith(EPIC_OID) && x.value);
    if (!epic.length) return { dups: [] };
    if (field && ref !== `Patient/${patientId}`) {
      console.error(`link skipped, no patient: ${type}`);
      return { dups: [] };
    }
    const { found: all, free: open } = await linkCandidates(client, type, epic, patientId, ident.system as string);
    const found = all as R[];
    const free = open as R[];
    if (free.length === 1) return { hit: free[0], dups: [] };
    if (free.length) return { dups: free };
    return { dups: source.kind === 'ccda' ? [] : found };
  };

  const idMap = new Map<string, string>();
  for (const src of ordered) {
    const r = structuredClone(src) as R;
    walkReferences(r, (ref) => idMap.get(ref));
    let ident = stableIdentifier(r, source, fileHash, patientId);
    if (!ident.value) throw new GaError(`${r.resourceType} has no source id`);
    if (colliding.has(keyOf(src))) ident = { ...ident, value: `${ident.value}|${contentHash(r, patientId)}` };
    const incoming = stamp(r, source, ident) as R;
    delete incoming.id;
    const type = incoming.resourceType;
    // Searches stay outside the try: only a write's validation failure is tolerated.
    const byStable = (await client.searchOne(type, { identifier: idKey(ident) })) as R | undefined;
    const link = byStable ? { dups: [] } : await linkHit(incoming, ident);
    const linked = link.hit;
    const existing = byStable ?? linked;
    const key = !existing && type === 'Observation' ? contentKey(incoming as Observation) : undefined;
    // Medplum's date=<day> matches only date-only values; a ge/lt range finds every time on that (UTC) day.
    const day = key?.split('|')[2];
    const next = day && new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const contentMatches = key
      ? await client.searchResources(
          'Observation',
          new URLSearchParams([['subject', `Patient/${patientId}`], ['code', key.split('|').slice(0, 2).join('|')], ['date', `ge${day}`], ['date', `lt${next}`]]),
        )
      : [];
    const matches = [...link.dups, ...contentMatches.filter((m) => !link.dups.some((d) => d.id === m.id))] as R[];
    try {
      let target: Resource;
      if (existing) {
        target = existing;
        const filled = fillFrom(existing, incoming, source);
        const d = decide(existing, filled, author);
        if (d === 'update') {
          await unionUpdate(client, existing, filled);
          report.updated++;
        } else if (d === 'conflict') {
          if (!hasTag(existing, 'source-conflict')) await client.updateResource(withTag(existing, 'source-conflict'));
          report.conflicts++;
        } else if (linked) {
          // Equal or older source: only record its identifiers, so the next import finds it by stable identifier.
          const have = new Set(idList(existing).map(idKey));
          await client.updateResource(protect({ ...existing, identifier: [...idList(existing), ...idList(incoming).filter((i) => !have.has(idKey(i)))] } as Resource));
          report.merged++;
        } else report.skipped++;
      } else {
        // Spec §5: only an exact effective time merges; a day-only match is a possible duplicate.
        const same = contentMatches.find((m) => sameValue(m, incoming as Observation) && effective(m) === effective(incoming as Observation)) as R | undefined;
        if (same) {
          target = same;
          const filled = fillFrom(same, incoming, source);
          const d = decide(same, filled, author);
          // conflict: equal value already recorded by the agent; don't attach an importer identifier (it would conflict on every re-import).
          if (d === 'conflict') report.skipped++;
          else {
            // Different writers (hospital record vs PDF extraction): keep the existing body, only record the second source.
            if (d === 'update' && hasTag(same, 'writer-agent') === hasTag(incoming, 'writer-agent')) await unionUpdate(client, same, filled);
            else await client.updateResource(protect({ ...same, identifier: [...(same.identifier ?? []), ident] } as Resource));
            report.merged++;
          }
        } else if (matches.length) {
          const dupExt = (o: Resource): Extension => ({ url: DUP_OF, valueReference: { reference: `${o.resourceType}/${o.id}` } });
          target = await client.createResource(
            withTag({ ...incoming, extension: [...(incoming.extension ?? []), ...matches.map(dupExt)] } as Resource, 'possible-duplicate'),
          );
          for (const m of matches) {
            const tag = protect(hasTag(m, 'possible-duplicate') ? m : withTag(m, 'possible-duplicate'));
            await client.updateResource({ ...tag, extension: [...(m.extension ?? []), dupExt(target)] } as Resource);
          }
          report.possibleDuplicates++;
        } else {
          target = await client.createResource(incoming as Resource);
          report.created++;
        }
      }
      for (const k of sourceKeys(src)) idMap.set(k, `${type}/${target.id}`);
    } catch (e) {
      if (!isValidationFailure(e)) throw e;
      // Element paths only: server diagnostics can echo values. References to this resource stay unresolved.
      console.error(`invalid ${(e.outcome.issue ?? []).map((i) => `${type}/${i.expression?.join(',')}`).join(' ')}`);
      report.invalid++;
    }
  }
  return report;
}
