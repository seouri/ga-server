// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { append, createReference, EMPTY, encodeBase64, generateId, isUUID, LOINC, SNOMED, UCUM } from '@medplum/core';
import type {
  Address,
  AllergyIntolerance,
  AllergyIntoleranceReaction,
  Bundle,
  CarePlan,
  CareTeam,
  CareTeamParticipant,
  CodeableConcept,
  Coding,
  Composition,
  CompositionAttester,
  CompositionEvent,
  CompositionSection,
  Condition,
  ContactPoint,
  Coverage,
  Device,
  DiagnosticReport,
  DocumentReference,
  Dosage,
  DosageDoseAndRate,
  Encounter,
  EncounterParticipant,
  EncounterDiagnosis,
  Extension,
  FamilyMemberHistory,
  FamilyMemberHistoryCondition,
  Goal,
  GoalTarget,
  HumanName,
  Identifier,
  Immunization,
  ImmunizationPerformer,
  Location,
  Medication,
  MedicationDispense,
  MedicationDispensePerformer,
  MedicationRequest,
  MedicationStatement,
  Observation,
  ObservationReferenceRange,
  Organization,
  Patient,
  PatientCommunication,
  Period,
  Practitioner,
  PractitionerQualification,
  PractitionerRole,
  Procedure,
  Specimen,
  Quantity,
  Reference,
  RelatedPerson,
  Resource,
  ServiceRequest,
} from '@medplum/fhirtypes';
import { mapCcdaToFhirDate, mapCcdaToFhirDateTime } from './datetime.ts';
import {
  OID_ACT_CODE_CODE_SYSTEM,
  OID_AGE_OBSERVATION,
  OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL,
  OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL_V2,
  OID_ALLERGIES_SECTION_ENTRIES_REQUIRED,
  OID_ALLERGIES_SECTION_ENTRIES_REQUIRED_V2,
  OID_CARE_TEAMS_SECTION,
  OID_FAMILY_HISTORY_DEATH_OBSERVATION,
  OID_FAMILY_HISTORY_ORGANIZER,
  OID_ENCOUNTER_DIAGNOSIS,
  OID_ENCOUNTER_DIAGNOSIS_V2,
  OID_GOAL_OBSERVATION,
  OID_GUARANTOR_PERFORMER,
  OID_GOALS_SECTION,
  OID_HEALTH_CONCERNS_SECTION,
  OID_HISTORY_OF_PRESENT_ILLNESS_SECTION,
  OID_IMMUNIZATION_REFUSAL_REASON,
  OID_IMMUNIZATIONS_SECTION_ENTRIES_OPTIONAL,
  OID_IMMUNIZATIONS_SECTION_ENTRIES_REQUIRED,
  OID_INSTRUCTION_SECTION_V2,
  OID_INSTRUCTIONS_SECTION,
  OID_MEDICATION_FREE_TEXT_SIG,
  OID_MEDICATIONS_SECTION_ENTRIES_OPTIONAL,
  OID_MEDICATIONS_SECTION_ENTRIES_OPTIONAL_V2,
  OID_MEDICATIONS_SECTION_ENTRIES_REQUIRED,
  OID_MEDICATIONS_SECTION_ENTRIES_REQUIRED_V2,
  OID_NOTE_ACTIVITY,
  OID_NOTES_SECTION,
  OID_PAYERS_SECTION,
  OID_PAYERS_SECTION_V2,
  OID_PLAN_OF_CARE_SECTION,
  OID_PROBLEMS_SECTION_ENTRIES_OPTIONAL,
  OID_PROBLEMS_SECTION_ENTRIES_REQUIRED,
  OID_PROBLEMS_SECTION_V2_ENTRIES_OPTIONAL,
  OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED,
  OID_PROCEDURES_SECTION_ENTRIES_REQUIRED,
  OID_REASON_FOR_REFERRAL,
  OID_SOCIAL_HISTORY_SECTION_ENTRIES_OPTIONAL,
  OID_SOCIAL_HISTORY_SECTION_V2_ENTRIES_OPTIONAL,
  OID_RESULT_ORGANIZER,
  OID_RESULT_ORGANIZER_V2,
  OID_SPECIMEN_RECEIVED,
  OID_REASON_FOR_REFERRAL_V2,
} from './oids.ts';
import { sanitizeNullFlavors } from './sanitize.ts';
import {
  ACT_CODE_SYSTEM,
  ADDRESS_USE_MAPPER,
  ADMINISTRATIVE_GENDER_CODE_SYSTEM,
  ALLERGY_CLINICAL_CODE_SYSTEM,
  ALLERGY_SEVERITY_MAPPER,
  ALLERGY_STATUS_MAPPER,
  ALLERGY_VERIFICATION_CODE_SYSTEM,
  CCDA_NARRATIVE_REFERENCE_URL,
  CLINICAL_CONDITION_CODE_SYSTEM,
  CONDITION_CATEGORY_CODE_SYSTEM,
  CONDITION_VER_STATUS_CODE_SYSTEM,
  CONDITION_VERIFICATION_CODE_SYSTEM,
  DIAGNOSIS_ROLE_CODE_SYSTEM,
  DIAGNOSTIC_SERVICE_SECTION_CODE_SYSTEM,
  ENCOUNTER_STATUS_MAPPER,
  HUMAN_NAME_USE_MAPPER,
  IMMUNIZATION_STATUS_MAPPER,
  LOINC_SUMMARY_OF_EPISODE_NOTE,
  mapCcdaAllergyCategoryAndType,
  mapCcdaCodeToCodeableConcept,
  mapCcdaSystemToFhir,
  MEDICATION_STATUS_MAPPER,
  OBSERVATION_CATEGORY_MAPPER,
  PARTICIPATION_CODE_SYSTEM,
  PLANNED_MEDICATION_MOOD_MAPPER,
  PROBLEM_STATUS_MAPPER,
  PROCEDURE_STATUS_MAPPER,
  TELECOM_USE_MAPPER,
  US_CORE_CONDITION_URL,
  US_CORE_ETHNICITY_URL,
  US_CORE_MEDICATION_REQUEST_URL,
  US_CORE_RACE_URL,
} from './systems.ts';
import type {
  Ccda,
  CcdaAct,
  CcdaAddr,
  CcdaAssignedEntity,
  CcdaAuthor,
  CcdaCode,
  CcdaCustodian,
  CcdaDocumentationOf,
  CcdaEffectiveTime,
  CcdaEncompassingEncounter,
  CcdaEncounter,
  CcdaEntry,
  CcdaId,
  CcdaInteger,
  CcdaLanguageCommunication,
  CcdaName,
  CcdaObservation,
  CcdaOrganizer,
  CcdaOrganizerComponent,
  CcdaParticipant,
  CcdaParticipantRole,
  CcdaPatientRole,
  CcdaPerformer,
  CcdaProcedure,
  CcdaQuantity,
  CcdaReference,
  CcdaReferenceRange,
  CcdaSection,
  CcdaSubstanceAdministration,
  CcdaSupply,
  CcdaTelecom,
  CcdaTemplateId,
  CcdaText,
  CcdaTimestampOrBoolean,
} from './types.ts';
import { convertToCompactXml, NAME_TEXT_GAP } from './xml.ts';

const PROBLEM_LIST_ITEM: Coding = {
  system: CONDITION_CATEGORY_CODE_SYSTEM,
  code: 'problem-list-item',
  display: 'Problem List Item',
};

const ENCOUNTER_DIAGNOSIS: Coding = {
  system: CONDITION_CATEGORY_CODE_SYSTEM,
  code: 'encounter-diagnosis',
  display: 'Encounter Diagnosis',
};

export interface CcdaToFhirOptions {
  ignoreUnsupportedSections?: boolean;
}

/**
 * Converts C-CDA documents to FHIR resources
 * Following Medplum TypeScript rules:
 * - Generates new FHIR resource IDs
 * - Preserves original C-CDA IDs as identifiers
 * - Adds proper metadata and timestamps
 *
 * @param ccda - The C-CDA document to convert
 * @param options - Optional conversion options
 * @returns The converted FHIR resources
 */
const SOCIAL_HISTORY_SECTIONS = [OID_SOCIAL_HISTORY_SECTION_ENTRIES_OPTIONAL, OID_SOCIAL_HISTORY_SECTION_V2_ENTRIES_OPTIONAL];

// C-CDA act status and planned moodCode → ServiceRequest (referrals, planned observations)
const SERVICE_REQUEST_STATUSES: Record<string, ServiceRequest['status']> = {
  active: 'active',
  completed: 'completed',
  aborted: 'revoked',
  cancelled: 'revoked',
  suspended: 'on-hold',
};
const SERVICE_REQUEST_INTENTS: Record<string, ServiceRequest['intent']> = {
  INT: 'plan',
  PRP: 'proposal',
  RQO: 'order',
  ARQ: 'order',
};

export function convertCcdaToFhir(ccda: Ccda, options?: CcdaToFhirOptions): Bundle {
  return new CcdaToFhirConverter(sanitizeNullFlavors(ccda), options).convert();
}

// Medication Activity statusCode → MedicationStatement.status (MEDICATION_STATUS_MAPPER has MedicationRequest values, e.g. cancelled)
const MEDICATION_DISPENSE_PERFORMER_FUNCTION = 'http://terminology.hl7.org/CodeSystem/medicationdispense-performer-function';

// Medication Dispense statusCode → MedicationDispense.status
const MEDICATION_DISPENSE_STATUSES: Record<string, MedicationDispense['status']> = {
  active: 'in-progress',
  completed: 'completed',
  aborted: 'stopped',
  cancelled: 'cancelled',
  suspended: 'on-hold',
  nullified: 'entered-in-error',
};

const MEDICATION_STATEMENT_STATUSES: Record<string, MedicationStatement['status']> = {
  active: 'active',
  completed: 'completed',
  aborted: 'stopped',
  suspended: 'on-hold',
  nullified: 'entered-in-error',
};

class CcdaToFhirConverter {
  private readonly ccda: Ccda;
  private readonly options: CcdaToFhirOptions | undefined;
  private readonly resources: Resource[] = [];
  private readonly specimens = new Map<string, Specimen>();
  private readonly reportEncounters: { report: DiagnosticReport; section: CcdaSection; encounters: CcdaEncounter[] }[] = [];
  private readonly narrativeTexts: Map<string, string | undefined>;
  private patient?: Patient;

  constructor(ccda: Ccda, options?: CcdaToFhirOptions) {
    this.ccda = ccda;
    this.options = options;
    this.narrativeTexts = indexNarrativeTexts(ccda);
  }

  convert(): Bundle {
    this.processHeader();
    const composition = this.createComposition();
    this.mergeSharedResources(composition);

    return {
      resourceType: 'Bundle',
      type: 'document',
      entry: [
        { resource: composition },
        ...(this.patient ? [{ resource: this.patient }] : []),
        ...this.resources.map((resource) => ({ resource })),
      ],
    };
  }

  /**
   * The converter makes a Practitioner, Organization or Location per occurrence: one per identifier is kept (the first, with every
   * field a later copy adds and every distinct element of an array field), then one PractitionerRole per practitioner and organization; every reference points at the kept one.
   * @param composition - The document's Composition (its author and custodian references are repointed too).
   */
  private mergeSharedResources(composition: Composition): void {
    const moved = new Map<string, string>();
    const kept = new Map<string, Resource>();
    const merge = (resource: Resource, keys: string[]): boolean => {
      const first = keys.map((key) => kept.get(key)).find(Boolean);
      if (!first) {
        keys.forEach((key) => kept.set(key, resource));
        return true;
      }
      const target = first as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(resource)) {
        if (k === 'id' || v === undefined) {
          continue;
        }
        if (target[k] === undefined) {
          target[k] = v;
        } else if (Array.isArray(target[k]) && Array.isArray(v)) {
          // Array fields (identifier, name, address, telecom, type): every distinct element of every copy
          const seen = new Set((target[k] as unknown[]).map((e) => JSON.stringify(e)));
          target[k] = [...(target[k] as unknown[]), ...v.filter((e) => !seen.has(JSON.stringify(e)))];
        }
        // A single-valued field both copies hold differently (an Organization's or Location's name, a Location's address): the first wins
      }
      keys.forEach((key) => kept.set(key, first));
      moved.set(`${resource.resourceType}/${resource.id}`, `${first.resourceType}/${first.id}`);
      return false;
    };
    const repoint = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(repoint);
      } else if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (typeof obj.reference === 'string' && moved.has(obj.reference)) {
          obj.reference = moved.get(obj.reference);
        }
        Object.values(obj).forEach(repoint);
      }
    };
    const shared = new Set(['Practitioner', 'Organization', 'Location']);
    const identifierKeys = (r: Resource): string[] =>
      ((r as Practitioner).identifier ?? EMPTY)
        .filter((i) => i.value)
        .map((i) => `${r.resourceType}|${i.system ?? ''}|${i.value}`);
    let resources = this.resources.filter((r) => !shared.has(r.resourceType) || !identifierKeys(r).length || merge(r, identifierKeys(r)));
    repoint(resources);
    const roleKey = (r: PractitionerRole): string =>
      `PractitionerRole|${r.practitioner?.reference ?? ''}|${r.organization?.reference ?? ''}`;
    resources = resources.filter((r) => r.resourceType !== 'PractitionerRole' || merge(r, [roleKey(r as PractitionerRole)]));
    repoint(resources);
    repoint([composition, this.patient]);
    this.resources.splice(0, this.resources.length, ...resources);
  }

  private processHeader(): void {
    const patientRole = this.ccda.recordTarget?.[0]?.patientRole;
    if (patientRole) {
      this.patient = this.createPatient(patientRole);
      this.createRelatedPersons();
    }
  }

  private createPatient(patientRole: CcdaPatientRole): Patient {
    const patient = patientRole.patient;
    const extensions: Extension[] = [];
    if (patient.raceCode && patient.raceCode.length > 0) {
      extensions.push({
        url: US_CORE_RACE_URL,
        extension: [
          ...patient.raceCode.map((raceCode) => ({
            url: 'ombCategory',
            valueCoding: this.mapCodeToCoding(raceCode),
          })),
          ...this.mapCategoryText(patient.raceCode),
        ],
      });
    }

    if (patient.ethnicGroupCode && patient.ethnicGroupCode.length > 0) {
      extensions.push({
        url: US_CORE_ETHNICITY_URL,
        extension: [
          ...patient.ethnicGroupCode.map((ethnicGroupCode) => ({
            url: 'ombCategory',
            valueCoding: this.mapCodeToCoding(ethnicGroupCode),
          })),
          ...this.mapCategoryText(patient.ethnicGroupCode),
        ],
      });
    }

    return {
      resourceType: 'Patient',
      id: this.mapId(patientRole.id),
      identifier: this.mapIdentifiers(patientRole.id),
      name: this.mapCcdaNameArrayFhirHumanNameArray(patient.name),
      gender: this.mapGenderCode(patient.administrativeGenderCode?.['@_code']),
      birthDate: mapCcdaToFhirDate(patient.birthTime?.['@_value']),
      address: this.mapAddresses(patientRole.addr),
      telecom: this.mapTelecom(patientRole.telecom),
      extension: extensions.length > 0 ? extensions : undefined,
      communication: this.mapLanguageCommunication(patient.languageCommunication),
    };
  }

  /**
   * The US Core race and ethnicity extensions require a `text` sub-extension: the codes' original text or display names.
   * @param codes - The raceCode or ethnicGroupCode elements.
   * @returns The `text` sub-extension, or none when the codes name nothing.
   */
  private mapCategoryText(codes: CcdaCode[]): Extension[] {
    const text = codes.map((c) => nodeToPlainText(c.originalText) || c['@_displayName']).filter(Boolean).join(', ');
    return text ? [{ url: 'text', valueString: text }] : [];
  }

  /**
   * Each languageCommunication is a Patient.communication: its BCP-47 language (display from the runtime's language names) and
   * whether it is preferred (preferenceInd).
   * @param languages - The patient's languageCommunication elements.
   * @returns The Patient.communication entries, or undefined when there are none.
   */
  private mapLanguageCommunication(languages: CcdaLanguageCommunication[] | undefined): PatientCommunication[] | undefined {
    const result: PatientCommunication[] = [];
    for (const language of languages ?? EMPTY) {
      const code = language.languageCode?.['@_code'];
      if (!code) {
        continue;
      }
      let display: string | undefined;
      try {
        display = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
      } catch {
        display = undefined; // not a well-formed BCP-47 tag: the code alone
      }
      const preferred = language.preferenceInd?.['@_value'];
      result.push({
        language: { coding: [{ system: 'urn:ietf:bcp:47', code, ...(display && display !== code && { display }) }] },
        ...(preferred === 'true' || preferred === 'false' ? { preferred: preferred === 'true' } : {}),
      });
    }
    return result.length > 0 ? result : undefined;
  }

  private createRelatedPersons(): void {
    const participants = this.ccda.participant;
    for (const participant of participants ?? EMPTY) {
      const relatedPerson = this.mapParticipantToRelatedPerson(participant);
      if (relatedPerson) {
        this.resources.push(relatedPerson);
      }
    }
  }

  private mapParticipantToRelatedPerson(participant: CcdaParticipant): RelatedPerson | undefined {
    const patient = this.patient;
    if (!patient) {
      return undefined;
    }

    const associatedEntity = participant.associatedEntity;
    if (!associatedEntity) {
      return undefined;
    }

    const relationship = mapCcdaCodeToCodeableConcept(associatedEntity.code);

    return {
      resourceType: 'RelatedPerson',
      id: this.mapId(associatedEntity.id),
      patient: createReference(patient),
      relationship: relationship ? [relationship] : undefined,
      identifier: this.mapIdentifiers(associatedEntity.id),
      name: this.mapCcdaNameArrayFhirHumanNameArray(associatedEntity.associatedPerson?.name),
      address: this.mapAddresses(associatedEntity.addr),
      telecom: this.mapTelecom(associatedEntity.telecom),
    };
  }

  private mapId(ids: CcdaId[] | undefined): string {
    // If there is an id without a root, then use that as the FHIR resource ID
    const serverId = ids?.find((id) => !id['@_extension'] && id['@_root'] && isUUID(id['@_root']));
    if (serverId) {
      return serverId['@_root'] as string;
    }

    // Otherwise generate a UUID
    return generateId();
  }

  private mapIdentifiers(ids: CcdaId[] | undefined): Identifier[] | undefined {
    let result: Identifier[] | undefined;
    for (const id of ids ?? EMPTY) {
      if (!id['@_extension'] && id['@_root'] && isUUID(id['@_root'])) {
        // By convention, we use id without a root as the FHIR resource ID
        continue;
      }
      result = append(result, {
        system: mapCcdaSystemToFhir(id['@_root']),
        value: id['@_extension'],
      });
    }
    return result;
  }

  private mapCcdaNameArrayFhirHumanNameArray(names: CcdaName[] | undefined): HumanName[] | undefined {
    const result = names?.map((n) => this.mapCcdaNameToFhirHumanName(n)).filter(Boolean) as HumanName[] | undefined;
    return result?.length ? result : undefined;
  }

  private mapCcdaNameToFhirHumanName(name: CcdaName | string | undefined): HumanName | undefined {
    if (!name) {
      return undefined;
    }
    // A name given as text (no markup), or with text beside its parts: that text is the name's text
    if (typeof name === 'string') {
      return name.trim() ? { text: name.trim() } : undefined;
    }

    const result: HumanName = {};

    const use = name['@_use'] ? HUMAN_NAME_USE_MAPPER.mapCcdaToFhir(name['@_use']) : undefined;
    if (use) {
      result.use = use;
    }

    if (name.prefix) {
      result.prefix = name.prefix.map(nodeToString)?.filter(Boolean) as string[];
    }

    if (name.family) {
      result.family = nodeToString(name.family);
    }

    if (name.given) {
      result.given = name.given.map(nodeToString)?.filter(Boolean) as string[];
    }

    if (name.suffix) {
      result.suffix = name.suffix.map(nodeToString)?.filter(Boolean) as string[];
    }

    // Loose text pieces (NAME_TEXT_GAP marks their ends) joined with single spaces
    const text = (name as { '#text'?: string })['#text']?.split(NAME_TEXT_GAP).join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      result.text = text;
    }

    // A name with no parts and no text (a nullFlavor name, stripped by sanitizeNullFlavors) is no name: an empty HumanName is invalid FHIR
    return result.family || result.given?.length || result.prefix?.length || result.suffix?.length || result.text ? result : undefined;
  }

  private mapAddresses(addresses: CcdaAddr[] | undefined): Address[] | undefined {
    if (!addresses || addresses.length === 0) {
      return undefined;
    }
    return addresses?.map((addr) => ({
      use: addr['@_use'] ? ADDRESS_USE_MAPPER.mapCcdaToFhir(addr['@_use']) : undefined,
      line: addr.streetAddressLine?.map(nodeToString).filter(Boolean) as string[] | undefined,
      city: nodeToString(addr.city),
      state: nodeToString(addr.state),
      postalCode: nodeToString(addr.postalCode),
      country: nodeToString(addr.country),
    }));
  }

  private mapTelecom(telecoms: CcdaTelecom[] | undefined): ContactPoint[] | undefined {
    if (!telecoms || telecoms.length === 0) {
      return undefined;
    }
    return telecoms?.map((tel) => ({
      use: tel['@_use'] ? TELECOM_USE_MAPPER.mapCcdaToFhir(tel['@_use']) : undefined,
      system: this.getTelecomSystem(tel['@_value']),
      value: this.getTelecomValue(tel['@_value']),
    }));
  }

  private createComposition(): Composition {
    const components = this.ccda.component?.structuredBody?.component || [];
    const sections: CompositionSection[] = [];

    for (const component of components) {
      for (const section of component.section) {
        const resources = this.processSection(section);
        sections.push({
          title: nodeToPlainText(section.title),
          code: this.mapCode(section.code),
          mode: 'snapshot',
          text: {
            status: 'generated',
            div: `<div xmlns="http://www.w3.org/1999/xhtml">${convertToCompactXml(section.text)}</div>`,
          },
          entry: resources.map(createReference),
        });
        this.resources.push(...resources);
      }
    }

    this.resolveReportEncounters();
    return {
      resourceType: 'Composition',
      id: this.mapId(this.ccda.id),
      language: this.ccda.languageCode?.['@_code'],
      status: 'final',
      type: this.ccda.code
        ? (this.mapCode(this.ccda.code) as CodeableConcept)
        : { coding: [{ system: LOINC, code: LOINC_SUMMARY_OF_EPISODE_NOTE }] },
      confidentiality: this.ccda.confidentialityCode?.['@_code'] as Composition['confidentiality'],
      subject: this.patient ? createReference(this.patient) : undefined,
      author: this.ccda.author?.length
        ? this.ccda.author.map((author) => this.mapDocumentAuthorToReference(author))
        : [{ display: 'Medplum' }],
      attester: this.mapAuthenticatorsToAttesters(),
      encounter: this.mapEncompassingEncounter(this.ccda.componentOf?.encompassingEncounter),
      custodian: this.mapCustodianToReference(this.ccda.custodian),
      event: this.mapDocumentationOfToEvent(this.ccda.documentationOf),
      date: mapCcdaToFhirDateTime(this.ccda.effectiveTime?.[0]?.['@_value']) ?? new Date().toISOString(),
      title: nodeToPlainText(this.ccda.title) ?? 'Medical Summary',
      section: sections,
    };
  }

  private processSection(section: CcdaSection): Resource[] {
    const resources: Resource[] = [];

    for (const entry of section.entry ?? EMPTY) {
      this.processEntry(section, entry, resources);
    }

    return resources;
  }

  private processEntry(section: CcdaSection, entry: CcdaEntry, resources: Resource[]): void {
    for (const act of entry.act ?? EMPTY) {
      const resource = this.processAct(section, act);
      if (Array.isArray(resource)) {
        resources.push(...resource);
      } else if (resource) {
        resources.push(resource);
      }
    }

    for (const substanceAdmin of entry.substanceAdministration ?? EMPTY) {
      const resource = this.processSubstanceAdministration(section, substanceAdmin);
      if (Array.isArray(resource)) {
        resources.push(...resource);
      } else if (resource) {
        resources.push(resource);
      }
    }

    for (const organizer of entry.organizer ?? EMPTY) {
      resources.push(this.processOrganizer(section, organizer));
    }

    for (const observation of entry.observation ?? EMPTY) {
      const resource = this.processObservation(section, observation);
      if (resource) {
        resources.push(resource);
      }
    }

    for (const encounter of entry.encounter ?? EMPTY) {
      resources.push(this.processEncounter(section, encounter));
    }

    for (const procedure of entry.procedure ?? EMPTY) {
      resources.push(this.processProcedure(section, procedure));
    }
  }

  private processAct(section: CcdaSection, act: CcdaAct): Resource | Resource[] | undefined {
    if (getTemplateIds(act).includes(OID_NOTE_ACTIVITY)) {
      // A Note Activity may appear in any section
      return this.processNoteAct(section, act);
    }

    const templateIds = getTemplateIds(section);
    for (const templateId of templateIds) {
      switch (templateId) {
        case OID_ALLERGIES_SECTION_ENTRIES_REQUIRED:
        case OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL:
        case OID_ALLERGIES_SECTION_ENTRIES_REQUIRED_V2:
        case OID_ALLERGIES_SECTION_ENTRIES_OPTIONAL_V2:
          return this.processAllergyIntoleranceAct(act);
        case OID_PROBLEMS_SECTION_ENTRIES_REQUIRED:
        case OID_PROBLEMS_SECTION_ENTRIES_OPTIONAL:
        case OID_PROBLEMS_SECTION_V2_ENTRIES_REQUIRED:
        case OID_PROBLEMS_SECTION_V2_ENTRIES_OPTIONAL:
          return this.processConditionAct(act);
        case OID_PLAN_OF_CARE_SECTION:
          return this.processCarePlanAct(act);
        case OID_HEALTH_CONCERNS_SECTION:
          return this.processConditionAct(act);
        case OID_PROCEDURES_SECTION_ENTRIES_REQUIRED:
          return this.processProcedureAct(act);
        case OID_REASON_FOR_REFERRAL:
        case OID_REASON_FOR_REFERRAL_V2:
          return this.processReferralAct(act);
        case OID_NOTES_SECTION:
        case OID_INSTRUCTIONS_SECTION:
        case OID_INSTRUCTION_SECTION_V2:
        case OID_HISTORY_OF_PRESENT_ILLNESS_SECTION:
          return this.processNoteAct(section, act);
        case OID_PAYERS_SECTION:
        case OID_PAYERS_SECTION_V2:
          return this.processCoverageAct(act);
      }
    }
    if (this.options?.ignoreUnsupportedSections) {
      return undefined;
    }
    throw new Error('Unhandled act templateId: ' + templateIds[0]);
  }

  /**
   * Returns the observations of a concern act's SUBJ entryRelationships (a concern may hold several).
   * @param act - The concern act.
   * @returns The SUBJ observations, in document order.
   */
  private getSubjectObservations(act: CcdaAct): CcdaObservation[] {
    return (act.entryRelationship ?? EMPTY)
      .filter((rel) => rel['@_typeCode'] === 'SUBJ')
      .flatMap((rel) => rel.observation ?? EMPTY);
  }

  /**
   * Returns the identifiers of one record made from a concern act: its own observation ids first, then (first record only) the act ids.
   * @param act - The concern act.
   * @param observation - The SUBJ observation.
   * @param index - The observation's position among the act's SUBJ observations.
   * @returns The identifiers.
   */
  private mapConcernIdentifiers(act: CcdaAct, observation: CcdaObservation, index: number): Identifier[] | undefined {
    return this.concatArrays(this.mapIdentifiers(observation.id), index === 0 ? this.mapIdentifiers(act.id) : undefined);
  }

  private processAllergyIntoleranceAct(act: CcdaAct): Resource[] {
    return this.getSubjectObservations(act).map((observation, index) =>
      this.processAllergyIntoleranceObservation(act, observation, index)
    );
  }

  private processAllergyIntoleranceObservation(
    act: CcdaAct,
    observation: CcdaObservation,
    index: number
  ): AllergyIntolerance {
    const allergy: AllergyIntolerance = {
      resourceType: 'AllergyIntolerance',
      id: this.mapId(index === 0 ? act.id : observation.id),
      identifier: this.mapConcernIdentifiers(act, observation, index),
      clinicalStatus: this.createClinicalStatus(act),
      verificationStatus: this.createVerificationStatus(),
      ...mapCcdaAllergyCategoryAndType(observation.value),
      patient: createReference(this.patient as Patient),
      recorder: this.mapAuthorToReference(act.author?.[0]),
      recordedDate: this.mapEffectiveTimeToDateTime(act.effectiveTime?.[0]),
      onsetDateTime: this.mapEffectiveTimeToDateTime(observation.effectiveTime?.[0]),
    };

    allergy.extension = this.mapTextReference(observation.text);

    const allergenCode = observation.participant?.[0]?.participantRole?.playingEntity?.code;
    if (allergenCode) {
      allergy.code = this.mapCode(allergenCode);

      // Add allergen reference
      if (allergy.code && allergenCode.originalText?.reference?.['@_value']) {
        allergy.code.extension = this.mapTextReference(allergenCode.originalText);
      }
    }

    const reactionObservations = observation.entryRelationship?.find(
      (rel) => rel['@_typeCode'] === 'MFST'
    )?.observation;
    if (reactionObservations) {
      allergy.reaction = reactionObservations.map((ro) => this.processReaction(ro));
    }

    allergy.asserter = this.mapAuthorToReference(observation.author?.[0]);

    return allergy;
  }

  private processConditionAct(act: CcdaAct, category = PROBLEM_LIST_ITEM): Condition[] {
    return this.getSubjectObservations(act).map((observation, index) =>
      this.processConditionObservation(act, observation, index, category)
    );
  }

  private processConditionObservation(
    act: CcdaAct,
    observation: CcdaObservation,
    index: number,
    category: Coding
  ): Condition {
    const result: Condition = {
      resourceType: 'Condition',
      id: this.mapId(index === 0 ? act.id : observation.id),
      identifier: this.mapConcernIdentifiers(act, observation, index),
      meta: {
        profile: [US_CORE_CONDITION_URL],
      },
      clinicalStatus: {
        coding: [
          {
            system: CLINICAL_CONDITION_CODE_SYSTEM,
            code: PROBLEM_STATUS_MAPPER.mapCcdaToFhirWithDefault(act.statusCode?.['@_code'], 'active'),
          },
        ],
      },
      verificationStatus: {
        coding: [
          {
            system: CONDITION_VERIFICATION_CODE_SYSTEM,
            code: 'confirmed',
          },
        ],
      },
      category: [{ coding: [category] }],
      code: this.mapCode(observation.value as CcdaCode),
      subject: createReference(this.patient as Patient),
      onsetDateTime: mapCcdaToFhirDateTime(observation.effectiveTime?.[0]?.low?.['@_value']),
      abatementDateTime: mapCcdaToFhirDateTime(observation.effectiveTime?.[0]?.high?.['@_value']),
      recordedDate: this.mapEffectiveTimeToDateTime(act.effectiveTime?.[0]),
      recorder: this.mapAuthorToReference(observation.author?.[0]),
      asserter: this.mapAuthorToReference(observation.author?.[0]),
    };

    result.extension = this.mapTextReference(observation.text);

    return result;
  }

  private processCarePlanAct(act: CcdaAct): Resource | undefined {
    const result: CarePlan = {
      resourceType: 'CarePlan',
      id: this.mapId(act.id),
      identifier: this.mapIdentifiers(act.id),
      status: 'completed',
      intent: 'plan',
      title: 'CARE PLAN',
      category: act.code ? [this.mapCode(act.code) as CodeableConcept] : undefined,
      subject: createReference(this.patient as Patient),
      description: nodeToString(act.text) || this.resolveNarrativeReference(act.text?.reference),
      extension: this.mapTextReference(act.text),
    };

    return result;
  }

  private processProcedureAct(act: CcdaAct): Resource | undefined {
    const result: Procedure = {
      resourceType: 'Procedure',
      id: this.mapId(act.id),
      identifier: this.mapIdentifiers(act.id),
      status: 'completed',
      code: this.mapCode(act.code),
      subject: createReference(this.patient as Patient),
      performedDateTime: mapCcdaToFhirDateTime(act.effectiveTime?.[0]?.['@_value']),
      recorder: this.mapAuthorToReference(act.author?.[0]),
      asserter: this.mapAuthorToReference(act.author?.[0]),
      extension: this.mapTextReference(act.text),
    };

    return result;
  }

  private processNoteAct(section: CcdaSection, act: CcdaAct): DocumentReference {
    // The note text is the act's own text, or the section narrative it points at
    const text = nodeToString(act.text) || this.resolveNarrativeReference(act.text?.reference);
    const effectiveTime = act.effectiveTime?.[0];
    const start = this.mapEffectiveTimeToDateTime(effectiveTime);
    return {
      resourceType: 'DocumentReference',
      id: this.mapId(act.id),
      identifier: this.mapIdentifiers(act.id),
      status: 'current',
      type: this.mapCode(act.code),
      category: section.code ? [this.mapCode(section.code) as CodeableConcept] : undefined,
      subject: createReference(this.patient as Patient),
      author: act.author?.map((author) => this.mapAuthorToReference(author)).filter(Boolean) as Reference<Practitioner>[],
      content: [
        {
          attachment: {
            contentType: 'text/plain',
            data: text ? encodeBase64(text) : undefined,
            title: nodeToPlainText(section.title),
          },
        },
      ],
      context: start
        ? { period: this.mapEffectiveTimeToPeriod(effectiveTime) ?? { start } }
        : undefined,
      extension: this.mapTextReference(act.text),
    };
  }

  private processReferralAct(act: CcdaAct): ServiceRequest {
    const text = nodeToString(act.text) || this.resolveNarrativeReference(act.text?.reference);
    return {
      resourceType: 'ServiceRequest',
      id: this.mapId(act.id),
      identifier: this.mapIdentifiers(act.id),
      status: SERVICE_REQUEST_STATUSES[act.statusCode?.['@_code'] ?? ''] ?? 'unknown',
      intent: SERVICE_REQUEST_INTENTS[act['@_moodCode']] ?? 'order',
      category: [{ coding: [{ system: SNOMED, code: '3457005', display: 'Patient referral' }] }],
      code: this.mapCode(act.code),
      subject: createReference(this.patient as Patient),
      occurrenceDateTime: this.mapEffectiveTimeToDateTime(act.effectiveTime?.[0]),
      authoredOn: mapCcdaToFhirDateTime(act.author?.[0]?.time?.['@_value']),
      requester: this.mapAuthorToReference(act.author?.[0]),
      performer: act.performer
        ?.map((performer) => this.mapAssignedEntityToReference(performer.assignedEntity))
        .filter(Boolean) as Reference<PractitionerRole>[],
      note: text ? [{ text }] : undefined,
      extension: this.mapTextReference(act.text),
    };
  }

  private processCoverageAct(act: CcdaAct): Coverage[] {
    // One Coverage per Policy Activity of the Coverage Activity
    const result: Coverage[] = [];
    for (const relationship of act.entryRelationship ?? EMPTY) {
      for (const policy of relationship.act ?? EMPTY) {
        result.push(this.processPolicyActivity(policy, relationship.sequenceNumber));
      }
    }
    return result;
  }

  private processPolicyActivity(policy: CcdaAct, sequenceNumber: CcdaInteger | undefined): Coverage {
    const payors = (policy.performer ?? EMPTY)
      .filter(
        (performer) =>
          !getTemplateIds(performer).includes(OID_GUARANTOR_PERFORMER) &&
          performer.assignedEntity?.code?.['@_code'] !== 'GUAR'
      )
      .map((performer) => this.mapPayerToReference(performer.assignedEntity));
    const coveredParty = policy.participant?.find((participant) => participant['@_typeCode'] === 'COV');
    const policyHolder = policy.participant?.find((participant) => participant['@_typeCode'] === 'HLD');
    const order = Number.parseInt(sequenceNumber?.['@_value'] ?? '', 10);

    return {
      resourceType: 'Coverage',
      id: this.mapId(policy.id),
      identifier: this.concatArrays(this.mapIdentifiers(policy.id), this.mapIdentifiers(coveredParty?.participantRole?.id)),
      // C-CDA has no coverage status: a Policy Activity's statusCode is always "completed"
      status: 'active',
      type: this.mapCode(policy.code),
      beneficiary: createReference(this.patient as Patient),
      subscriberId: policyHolder?.participantRole?.id?.[0]?.['@_extension'],
      relationship: this.mapCode(coveredParty?.participantRole?.code),
      period: this.mapEffectiveTimeToPeriod(coveredParty?.time),
      payor:
        payors.length > 0
          ? payors
          : [{ extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] }],
      order: order > 0 ? order : undefined,
    };
  }

  /**
   * A payer (Payer Performer) is an Organization: its id, and the name, address and telecom of its representedOrganization
   * (the assigned entity's own address and telecom when the organization has none).
   * @param entity - The payer's assigned entity.
   * @returns The Coverage payor reference.
   */
  private mapPayerToReference(entity: CcdaAssignedEntity | undefined): Reference<Organization> {
    const org = entity?.representedOrganization;
    const organization: Organization = {
      resourceType: 'Organization',
      id: this.mapId(entity?.id),
      identifier: this.mapIdentifiers(entity?.id),
      name: org?.name?.[0],
      address: this.mapAddresses(org?.addr?.length ? org.addr : entity?.addr),
      telecom: this.mapTelecom(org?.telecom?.length ? org.telecom : entity?.telecom),
    };
    this.resources.push(organization);
    return { ...createReference(organization), ...(organization.name && { display: organization.name }) };
  }

  private processSubstanceAdministration(
    section: CcdaSection,
    substanceAdmin: CcdaSubstanceAdministration
  ): Resource | Resource[] | undefined {
    const templateIds = getTemplateIds(section);
    for (const templateId of templateIds) {
      switch (templateId) {
        case OID_MEDICATIONS_SECTION_ENTRIES_REQUIRED:
        case OID_MEDICATIONS_SECTION_ENTRIES_OPTIONAL:
        case OID_MEDICATIONS_SECTION_ENTRIES_REQUIRED_V2:
        case OID_MEDICATIONS_SECTION_ENTRIES_OPTIONAL_V2:
          // A medication list entry says what the patient takes, whatever its mood (EVN or INT)
          return this.processMedicationSubstanceAdministration(substanceAdmin, undefined);
        case OID_PLAN_OF_CARE_SECTION:
          // Planned Medication and Planned Immunization Activities carry a planned moodCode (INT, RQO, PRMS, PRP)
          return this.processMedicationSubstanceAdministration(
            substanceAdmin,
            PLANNED_MEDICATION_MOOD_MAPPER.mapCcdaToFhirWithDefault(substanceAdmin['@_moodCode'], 'order')
          );
        case OID_IMMUNIZATIONS_SECTION_ENTRIES_OPTIONAL:
        case OID_IMMUNIZATIONS_SECTION_ENTRIES_REQUIRED:
          return this.processImmunizationSubstanceAdministration(substanceAdmin);
      }
    }
    if (this.options?.ignoreUnsupportedSections) {
      return undefined;
    }
    throw new Error('Unhandled substance administration templateId: ' + templateIds[0]);
  }

  /**
   * A Medication Activity (Medications section) or a planned medication (Plan of Treatment).
   * @param substanceAdmin - The substance administration.
   * @param intent - The MedicationRequest intent of a planned medication; undefined for a medication list entry (a MedicationStatement).
   * @returns The statement or request, then one record per supply inside it.
   */
  private processMedicationSubstanceAdministration(
    substanceAdmin: CcdaSubstanceAdministration,
    intent: MedicationRequest['intent'] | undefined
  ): Resource[] {
    const cdaId = this.mapId(substanceAdmin.id);
    const effectiveTime = substanceAdmin.effectiveTime?.[0];
    const medicationCode = substanceAdmin.consumable?.manufacturedProduct?.[0]?.manufacturedMaterial?.[0]?.code?.[0];
    const routeCode = substanceAdmin.routeCode;
    const doseQuantity = substanceAdmin.doseQuantity;
    const manufacturerOrg = substanceAdmin.consumable?.manufacturedProduct?.[0]?.manufacturerOrganization?.[0];
    const instructions = substanceAdmin.entryRelationship?.find(
      (rel) => rel.substanceAdministration?.[0]?.templateId?.[0]?.['@_root'] === OID_MEDICATION_FREE_TEXT_SIG
    )?.substanceAdministration?.[0];

    let medication: Medication | undefined = undefined;
    let medicationCodeableConcept: CodeableConcept | undefined = undefined;

    if (manufacturerOrg) {
      // If there is a manufacturer, create a Medication resource
      // We need to do this to fully represent the medication for round trip data preservation
      medication = {
        resourceType: 'Medication',
        id: 'med-' + cdaId,
        code: this.mapCode(medicationCode),
        extension: this.mapTextReference(medicationCode?.originalText),
        manufacturer: manufacturerOrg
          ? {
              identifier: {
                value: manufacturerOrg.id?.[0]?.['@_root'],
              },
              display: manufacturerOrg.name?.[0],
            }
          : undefined,
      };
    } else {
      // Otherwise, create a CodeableConcept for the medication
      // Avoid contained resources as much as possible
      medicationCodeableConcept = {
        ...this.mapCode(medicationCode),
        extension: this.mapTextReference(medicationCode?.originalText),
      };
    }

    const supplies = this.processMedicationSupplies(substanceAdmin, medicationCode, intent);
    const dosage: Dosage[] = [
      {
        text: typeof substanceAdmin.text === 'string' ? substanceAdmin.text : undefined,
        extension: this.mapTextReference(instructions?.text),
        route: routeCode ? this.mapCode(routeCode) : undefined,
        timing: {
          repeat: substanceAdmin.effectiveTime?.[1]?.period
            ? {
                period: Number(substanceAdmin.effectiveTime?.[1]?.period['@_value']),
                periodUnit: substanceAdmin.effectiveTime?.[1]?.period['@_unit'],
              }
            : undefined,
        },
        doseAndRate: this.mapDoseAndRate(doseQuantity),
      },
    ];
    const shared = {
      id: cdaId,
      identifier: this.mapIdentifiers(substanceAdmin.id),
      contained: medication ? [medication] : undefined,
      extension: this.mapTextReference(substanceAdmin.text),
      medicationReference: medication ? { reference: '#med-' + cdaId } : undefined,
      medicationCodeableConcept,
      subject: createReference(this.patient as Patient),
    };

    if (!intent) {
      // A medication list entry: the patient takes or took it, a statement rather than an order
      const effectivePeriod = this.mapEffectiveTimeToPeriod(effectiveTime);
      const statement: MedicationStatement = {
        resourceType: 'MedicationStatement',
        ...shared,
        status: MEDICATION_STATEMENT_STATUSES[substanceAdmin.statusCode?.['@_code'] ?? ''] ?? 'unknown',
        ...(effectivePeriod ? { effectivePeriod } : { effectiveDateTime: this.mapEffectiveTimeToDateTime(effectiveTime) }),
        dateAsserted: mapCcdaToFhirDateTime(substanceAdmin.author?.[0]?.time?.['@_value']),
        dosage,
      };
      return [statement, ...supplies];
    }

    const request: MedicationRequest = {
      resourceType: 'MedicationRequest',
      ...shared,
      meta: {
        profile: [US_CORE_MEDICATION_REQUEST_URL],
      },
      status: MEDICATION_STATUS_MAPPER.mapCcdaToFhirWithDefault(substanceAdmin.statusCode?.['@_code'], 'active'),
      intent,
      authoredOn: mapCcdaToFhirDateTime(substanceAdmin.author?.[0]?.time?.['@_value']),
      dispenseRequest: effectiveTime
        ? {
            validityPeriod: {
              // A single @value is a point in time, e.g. when a planned medication should start
              start: mapCcdaToFhirDateTime(effectiveTime.low?.['@_value'] ?? effectiveTime['@_value']),
              end: mapCcdaToFhirDateTime(effectiveTime.high?.['@_value']),
            },
          }
        : undefined,
      dosageInstruction: dosage,
    };
    return [request, ...supplies];
  }

  /**
   * Who entered a dispense (its author: R4 has no recorder, so a performer with function dataenterer, never a requester)
   * and who dispensed it (its performers, with no function).
   * @param supply - The Medication Dispense.
   * @returns The MedicationDispense performers, or undefined when there are none.
   */
  private mapDispensePerformers(supply: CcdaSupply): MedicationDispensePerformer[] | undefined {
    const performers: MedicationDispensePerformer[] = [];
    const author = this.mapAuthorToReference(supply.author?.[0]);
    if (author) {
      performers.push({ function: { coding: [{ system: MEDICATION_DISPENSE_PERFORMER_FUNCTION, code: 'dataenterer' }] }, actor: author });
    }
    for (const performer of supply.performer ?? EMPTY) {
      const actor = this.mapAssignedEntityToReference(performer.assignedEntity);
      if (actor) {
        performers.push({ actor });
      }
    }
    return performers.length > 0 ? performers : undefined;
  }

  /**
   * Medication Supply Orders (INT) and Medication Dispenses (EVN) recorded inside a Medication Activity.
   * @param substanceAdmin - The Medication Activity.
   * @param medicationCode - The Medication Activity's drug, used when a supply names no product of its own.
   * @param intent - A planned medication's intent, which its supply orders share; undefined (a medication list entry): order.
   * @returns A MedicationRequest per supply order and a MedicationDispense per dispense.
   */
  private processMedicationSupplies(
    substanceAdmin: CcdaSubstanceAdministration,
    medicationCode: CcdaCode | undefined,
    intent: MedicationRequest['intent'] | undefined
  ): (MedicationRequest | MedicationDispense)[] {
    const result: (MedicationRequest | MedicationDispense)[] = [];
    for (const supply of (substanceAdmin.entryRelationship ?? EMPTY).flatMap((rel) => rel.supply ?? EMPTY)) {
      const code = supply.product?.manufacturedProduct?.[0]?.manufacturedMaterial?.[0]?.code?.[0] ?? medicationCode;
      const medicationCodeableConcept = { ...this.mapCode(code), extension: this.mapTextReference(code?.originalText) };
      const shared = {
        id: this.mapId(supply.id),
        identifier: this.mapIdentifiers(supply.id),
        medicationCodeableConcept,
        subject: createReference(this.patient as Patient),
      };
      if (supply['@_moodCode'] === 'EVN') {
        result.push({
          resourceType: 'MedicationDispense',
          ...shared,
          status: MEDICATION_DISPENSE_STATUSES[supply.statusCode?.['@_code'] ?? ''] ?? 'unknown',
          quantity: this.mapQuantity(supply.quantity),
          whenHandedOver: this.mapEffectiveTimeToDateTime(supply.effectiveTime?.[0]),
          performer: this.mapDispensePerformers(supply),
        });
        continue;
      }
      // repeatNumber counts every allowed fill; FHIR counts refills after the first
      const fills = Number.parseInt(supply.repeatNumber?.['@_value'] ?? '', 10);
      result.push({
        resourceType: 'MedicationRequest',
        ...shared,
        meta: { profile: [US_CORE_MEDICATION_REQUEST_URL] },
        status: MEDICATION_STATUS_MAPPER.mapCcdaToFhirWithDefault(supply.statusCode?.['@_code'], 'active'),
        intent: intent ?? 'order',
        authoredOn: mapCcdaToFhirDateTime(supply.author?.[0]?.time?.['@_value']),
        requester: this.mapAuthorToReference(supply.author?.[0]),
        dispenseRequest: {
          validityPeriod: this.mapEffectiveTimeToPeriod(supply.effectiveTime?.[0]),
          numberOfRepeatsAllowed: fills > 0 ? fills - 1 : undefined,
          quantity: this.mapQuantity(supply.quantity),
        },
      });
    }
    return result;
  }

  private mapDoseAndRate(doseQuantity: CcdaQuantity | undefined): DosageDoseAndRate[] | undefined {
    if (doseQuantity?.low || doseQuantity?.high) {
      const low = this.mapQuantity(doseQuantity.low);
      const high = this.mapQuantity(doseQuantity.high);
      return low || high ? [{ doseRange: { low, high } }] : undefined;
    }
    const quantity = this.mapQuantity(doseQuantity);
    return quantity ? [{ doseQuantity: quantity }] : undefined;
  }

  private mapQuantity(quantity: CcdaQuantity | undefined): Quantity | undefined {
    const value = Number.parseFloat(quantity?.['@_value'] ?? '');
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const unit = quantity?.['@_unit'];
    return { value, unit, system: unit ? UCUM : undefined, code: unit };
  }

  private processImmunizationSubstanceAdministration(
    substanceAdmin: CcdaSubstanceAdministration
  ): Resource | undefined {
    const consumable = substanceAdmin.consumable;
    if (!consumable) {
      return undefined;
    }

    const result: Immunization = {
      resourceType: 'Immunization',
      id: this.mapId(substanceAdmin.id),
      identifier: this.mapIdentifiers(substanceAdmin.id),
      status: IMMUNIZATION_STATUS_MAPPER.mapCcdaToFhirWithDefault(substanceAdmin.statusCode?.['@_code'], 'completed'),
      vaccineCode: this.mapCode(
        consumable.manufacturedProduct?.[0]?.manufacturedMaterial?.[0]?.code?.[0]
      ) as CodeableConcept,
      patient: createReference(this.patient as Patient),
      occurrenceDateTime: mapCcdaToFhirDateTime(substanceAdmin.effectiveTime?.[0]?.['@_value']),
      lotNumber: consumable.manufacturedProduct?.[0]?.manufacturedMaterial?.[0]?.lotNumberText?.[0],
      route: this.mapCode(substanceAdmin.routeCode),
    };

    // Not given (negationInd): not-done, with the Immunization Refusal Reason as statusReason
    if (substanceAdmin['@_negationInd'] === 'true') {
      result.status = 'not-done';
      const refusal = (substanceAdmin.entryRelationship ?? EMPTY)
        .flatMap((rel) => rel.observation ?? EMPTY)
        .find((o) => o.templateId?.some((t) => t['@_root'] === OID_IMMUNIZATION_REFUSAL_REASON));
      result.statusReason = this.mapCode(refusal?.code);
    }

    if (substanceAdmin.performer) {
      result.performer = this.mapCcdaPerformerArrayToImmunizationPerformerArray(substanceAdmin.performer);
    }

    result.extension = this.mapTextReference(substanceAdmin.text);

    if (substanceAdmin.consumable?.manufacturedProduct?.[0]?.manufacturerOrganization?.[0]) {
      result.manufacturer = {
        display: substanceAdmin.consumable?.manufacturedProduct?.[0]?.manufacturerOrganization?.[0]?.name?.[0],
      };
    }

    return result;
  }

  private processReaction(reactionObs: CcdaObservation): AllergyIntoleranceReaction {
    const manifestation = this.mapCode(reactionObs.value as CcdaCode) ?? {
      extension: [
        {
          url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
          valueCode: 'unknown',
        },
      ],
    };

    const reaction: AllergyIntoleranceReaction = {
      id: this.mapId(reactionObs.id),
      manifestation: [manifestation],
      onset: mapCcdaToFhirDateTime(reactionObs.effectiveTime?.[0]?.low?.['@_value']),
    };

    this.processSeverity(reactionObs, reaction);

    // Add reaction reference
    if (reactionObs.text?.reference?.['@_value']) {
      const textRefExtension = this.mapTextReference(reactionObs.text);
      if (textRefExtension) {
        reaction.manifestation[0].extension = [...(reaction.manifestation[0].extension ?? []), ...textRefExtension];
      }
    }

    return reaction;
  }

  private processSeverity(reactionObs: CcdaObservation, reaction: AllergyIntoleranceReaction): void {
    const severityObs = reactionObs.entryRelationship?.find((rel) => rel['@_typeCode'] === 'SUBJ')?.observation?.[0];
    if (!severityObs) {
      return;
    }

    const severityCode = (severityObs.value as CcdaCode)?.['@_code'];
    if (severityCode) {
      reaction.severity = ALLERGY_SEVERITY_MAPPER.mapCcdaToFhir(severityCode);
    }

    reaction.extension = this.mapTextReference(severityObs.text);
  }

  private mapEffectiveTimeToDateTime(effectiveTime: CcdaEffectiveTime | undefined): string | undefined {
    if (effectiveTime?.['@_value']) {
      return mapCcdaToFhirDateTime(effectiveTime['@_value']);
    }
    if (effectiveTime?.low?.['@_value']) {
      return mapCcdaToFhirDateTime(effectiveTime.low['@_value']);
    }
    return undefined;
  }

  private mapEffectiveTimeToPeriod(effectiveTime: CcdaEffectiveTime | undefined): Period | undefined {
    if (!effectiveTime?.['@_value'] && (effectiveTime?.low || effectiveTime?.high)) {
      return {
        start: mapCcdaToFhirDateTime(effectiveTime?.low?.['@_value']),
        end: mapCcdaToFhirDateTime(effectiveTime?.high?.['@_value']),
      };
    }
    return undefined;
  }

  /**
   * Maps the effectiveTime of an observation or an organizer to Observation.effective[x].
   *
   * A point in time, an interval with only a low, and an interval whose low equals its high are one
   * moment: effectiveDateTime. An interval with a different high, or with only a high, is an
   * effectivePeriod. A nullFlavor carries no date, so it maps to nothing.
   * @param effectiveTime - The C-CDA effectiveTime.
   * @returns The effectiveDateTime or effectivePeriod, or an empty object when there is no date.
   */
  private mapObservationEffectiveTime(
    effectiveTime: CcdaEffectiveTime | undefined
  ): Pick<Observation, 'effectiveDateTime' | 'effectivePeriod'> {
    if (effectiveTime?.['@_value']) {
      return { effectiveDateTime: mapCcdaToFhirDateTime(effectiveTime['@_value']) };
    }
    const start = mapCcdaToFhirDateTime(effectiveTime?.low?.['@_value']);
    const end = mapCcdaToFhirDateTime(effectiveTime?.high?.['@_value']);
    if (start && end && start !== end) {
      return { effectivePeriod: { start, end } };
    }
    if (start) {
      return { effectiveDateTime: start };
    }
    if (end) {
      return { effectivePeriod: { end } };
    }
    return {};
  }

  private mapGenderCode(code: string | undefined): Patient['gender'] {
    if (!code) {
      return undefined;
    }
    const map: { [key: string]: Patient['gender'] } = {
      F: 'female',
      M: 'male',
      UN: 'unknown',
    };
    return map[code];
  }

  private getTelecomSystem(value: string | undefined): ContactPoint['system'] {
    if (!value) {
      return undefined;
    }
    if (value.startsWith('tel:')) {
      return 'phone';
    }
    if (value.startsWith('mailto:')) {
      return 'email';
    }
    return 'other';
  }

  private getTelecomValue(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    return value.replace(/^(tel:|mailto:)/, '');
  }

  private mapCode(code: CcdaCode | undefined): CodeableConcept | undefined {
    if (!code) {
      return undefined;
    }

    const codings: Coding[] = [];

    const system = mapCcdaSystemToFhir(code['@_codeSystem']);
    const codeValue = code['@_code'];
    const display = code['@_displayName'];

    if (system || codeValue || display) {
      codings.push({
        ...(system && { system }),
        ...(codeValue && { code: codeValue }),
        ...(display && { display }),
      });
    }

    let translations: CcdaCode[] = [];
    if (Array.isArray(code.translation)) {
      translations = code.translation;
    } else if (code.translation) {
      translations = [code.translation];
    }
    for (const translation of translations) {
      const translationSystem = mapCcdaSystemToFhir(translation['@_codeSystem']);
      const translationCode = translation['@_code'];
      const translationDisplay = translation['@_displayName'];

      if (translationSystem || translationCode || translationDisplay) {
        codings.push({
          ...(translationSystem && { system: translationSystem }),
          ...(translationCode && { code: translationCode }),
          ...(translationDisplay && { display: translationDisplay }),
        });
      }
    }

    const text =
      code['@_displayName'] ||
      nodeToString(code.originalText) ||
      this.resolveNarrativeReference(code.originalText?.reference);

    if (codings.length === 0) {
      return text ? { text } : undefined;
    }

    return {
      coding: codings,
      ...(text && { text }),
    };
  }

  /**
   * Returns the section narrative text that a reference such as `#Med0Name` points at.
   * @param reference - The C-CDA reference.
   * @returns The narrative text, or undefined if the reference does not point at exactly one narrative element.
   */
  private resolveNarrativeReference(reference: CcdaReference | undefined): string | undefined {
    const value = reference?.['@_value'];
    return value?.startsWith('#') ? this.narrativeTexts.get(value.substring(1)) : undefined;
  }

  private mapCodeToCoding(code: CcdaCode | undefined): Coding | undefined {
    if (!code) {
      return undefined;
    }

    return {
      system: mapCcdaSystemToFhir(code['@_codeSystem']),
      code: code['@_code'],
      display: code['@_displayName'],
    };
  }

  private mapQualification(code: CcdaCode | undefined): PractitionerQualification[] | undefined {
    const codeableConcept = this.mapCode(code);
    if (!codeableConcept) {
      return undefined;
    }
    return [{ code: codeableConcept }];
  }

  private createClinicalStatus(act: CcdaAct): CodeableConcept {
    return {
      coding: [
        {
          system: ALLERGY_CLINICAL_CODE_SYSTEM,
          code: ALLERGY_STATUS_MAPPER.mapCcdaToFhirWithDefault(act.statusCode?.['@_code'], 'active'),
        },
      ],
    };
  }

  private createVerificationStatus(): CodeableConcept {
    return {
      coding: [
        {
          system: ALLERGY_VERIFICATION_CODE_SYSTEM,
          code: 'confirmed',
        },
      ],
    };
  }

  /**
   * A document author: a person (Practitioner) or an authoring device (Device, owned by its represented organization).
   * @param author - The ClinicalDocument author.
   * @returns The Composition author reference.
   */
  private mapDocumentAuthorToReference(author: CcdaAuthor): Reference<Practitioner | Device | Organization> {
    const authoringDevice = author.assignedAuthor?.assignedAuthoringDevice;
    if (!authoringDevice) {
      return this.mapAuthorToReference(author) as Reference<Practitioner>;
    }
    const organization = author.assignedAuthor?.representedOrganization;
    let owner: Organization | undefined;
    if (organization) {
      owner = {
        resourceType: 'Organization',
        id: this.mapId(organization.id),
        identifier: this.mapIdentifiers(organization.id),
        name: organization.name?.[0],
        address: this.mapAddresses(organization.addr),
        telecom: this.mapTelecom(organization.telecom),
      };
      this.resources.push(owner);
    }
    const modelName = nodeToString(authoringDevice.manufacturerModelName);
    const softwareName = nodeToString(authoringDevice.softwareName);
    const device: Device = {
      resourceType: 'Device',
      id: this.mapId(author.assignedAuthor?.id),
      identifier: this.mapIdentifiers(author.assignedAuthor?.id),
      deviceName: modelName ? [{ name: modelName, type: 'model-name' }] : undefined,
      version: softwareName ? [{ value: softwareName }] : undefined,
      owner: owner ? createReference(owner) : undefined,
    };
    this.resources.push(device);
    return createReference(device);
  }

  private mapAuthorToReference(author: CcdaAuthor | undefined): Reference<Practitioner> | undefined {
    if (!author) {
      return undefined;
    }

    const practitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: this.mapId(author.assignedAuthor?.id),
      identifier: this.mapIdentifiers(author.assignedAuthor?.id),
      name: this.mapCcdaNameArrayFhirHumanNameArray(author.assignedAuthor?.assignedPerson?.name),
      address: this.mapAddresses(author.assignedAuthor?.addr),
      telecom: this.mapTelecom(author.assignedAuthor?.telecom),
      qualification: this.mapQualification(author.assignedAuthor?.code),
    };

    this.resources.push(practitioner);

    return createReference(practitioner);
  }

  private mapAssignedEntityToReference(
    assignedEntity: CcdaAssignedEntity | undefined
  ): Reference<PractitionerRole> | undefined {
    if (!assignedEntity) {
      return undefined;
    }

    const assignedPerson = assignedEntity.assignedPerson;
    const representedOrganization = assignedEntity.representedOrganization;

    const practitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: this.mapId(assignedEntity?.id),
      identifier: this.mapIdentifiers(assignedEntity?.id),
      name: this.mapCcdaNameArrayFhirHumanNameArray(assignedPerson?.name),
      address: this.mapAddresses(assignedEntity?.addr),
      telecom: this.mapTelecom(assignedEntity?.telecom),
    };

    this.resources.push(practitioner);

    let organization: Organization | undefined;
    if (representedOrganization) {
      organization = {
        resourceType: 'Organization',
        id: this.mapId(assignedEntity?.id),
        identifier: this.mapIdentifiers(representedOrganization.id),
        name: representedOrganization.name?.[0],
        address: this.mapAddresses(representedOrganization.addr),
      };
      this.resources.push(organization);
    }

    const practitionerRole: PractitionerRole = {
      resourceType: 'PractitionerRole',
      id: this.mapId(assignedEntity?.id),
      practitioner: createReference(practitioner),
      organization: organization ? createReference(organization) : undefined,
      // The assigned entity's code (a provider taxonomy, e.g. NUCC) is what this person practises in this role
      specialty: assignedEntity.code ? [this.mapCode(assignedEntity.code) as CodeableConcept] : undefined,
    };
    this.resources.push(practitionerRole);

    return createReference(practitionerRole);
  }

  /**
   * The encounter the document belongs to (componentOf/encompassingEncounter): the Encounter an entry already made for the same
   * id, else a new one (class, type, period, its facility as the Location, its participants and responsible party).
   * @param encompassing - The encompassingEncounter.
   * @returns The Composition encounter, or undefined when the document names none.
   */
  private mapEncompassingEncounter(encompassing: CcdaEncompassingEncounter | undefined): Reference<Encounter> | undefined {
    if (!encompassing) {
      return undefined;
    }
    const identifier = this.mapIdentifiers(encompassing.id);
    const key = (i: Identifier): string => `${i.system ?? ''}|${i.value ?? ''}`;
    const keys = new Set((identifier ?? EMPTY).filter((i) => i.value).map(key));
    const existing = this.resources.find(
      (r): r is Encounter => r.resourceType === 'Encounter' && !!r.identifier?.some((i) => keys.has(key(i)))
    );
    const facility = encompassing.location?.healthCareFacility;
    const location: Location | undefined = facility
      ? {
          resourceType: 'Location',
          id: this.mapId(facility.id),
          identifier: this.mapIdentifiers(facility.id),
          name: nodeToString(facility.location?.name?.[0] as string | undefined),
          type: facility.code ? [this.mapCode(facility.code) as CodeableConcept] : undefined,
          address: this.mapAddresses(facility.location?.addr)?.[0],
        }
      : undefined;
    const participants = [
      ...(encompassing.responsibleParty?.assignedEntity
        ? [{ typeCode: 'RESP', entity: encompassing.responsibleParty.assignedEntity }]
        : []),
      ...(encompassing.encounterParticipant ?? EMPTY).map((p) => ({ typeCode: p['@_typeCode'], entity: p.assignedEntity })),
    ]
      .filter((p) => p.entity)
      .map((p) => ({
        ...(p.typeCode && { type: [{ coding: [{ system: PARTICIPATION_CODE_SYSTEM, code: p.typeCode }] }] }),
        individual: this.mapAssignedEntityToReference(p.entity),
      }));
    const period = this.mapEffectiveTimeToPeriod(encompassing.effectiveTime?.[0]);
    const encounter: Encounter = existing ?? {
      resourceType: 'Encounter',
      id: this.mapId(encompassing.id),
      identifier,
      status: 'unknown', // the header states none
      class: this.mapEncounterClass(encompassing.code),
      type: encompassing.code ? [this.mapCode(encompassing.code) as CodeableConcept] : undefined,
      subject: this.patient ? createReference(this.patient) : undefined,
    };
    // An entry's Encounter of the same id gains what the header adds: its period when it has none, each header participant it
    // does not already have (same type and individual), and the facility. The facility's Location is always kept (row 33 merges
    // it into a Location of the same id, which gains its name and address); only a second location entry for it is skipped.
    encounter.period ??= period;
    const same = (a: EncounterParticipant, b: EncounterParticipant): boolean =>
      JSON.stringify(a.type) === JSON.stringify(b.type) &&
      this.sameEntity(a.individual?.reference, b.individual?.reference);
    for (const p of participants) {
      if (!(encounter.participant ?? EMPTY).some((q) => same(p, q))) {
        encounter.participant = [...(encounter.participant ?? EMPTY), p];
      }
    }
    if (location) {
      this.resources.push(location);
      const facilityKeys = new Set((location.identifier ?? EMPTY).filter((i) => i.value).map(key));
      const known = (encounter.location ?? EMPTY).some((l) => {
        const target = this.resources.find((r) => `${r.resourceType}/${r.id}` === l.location.reference) as Location | undefined;
        return !!target?.identifier?.some((i) => facilityKeys.has(key(i)));
      });
      if (!known) {
        encounter.location = [...(encounter.location ?? EMPTY), { location: createReference(location) }];
      }
    }
    if (!existing) {
      this.resources.push(encounter);
    }
    return createReference(encounter);
  }

  /**
   * Whether two references name the same person: the same reference, or PractitionerRoles whose practitioners share an identifier.
   * @param a - A reference.
   * @param b - Another reference.
   * @returns True when they are the same entity.
   */
  private sameEntity(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    const find = (ref: string): Resource | undefined => this.resources.find((r) => `${r.resourceType}/${r.id}` === ref);
    const ids = (ref: string): string[] => {
      const role = find(ref) as PractitionerRole | undefined;
      const who = role?.resourceType === 'PractitionerRole' ? (find(role.practitioner?.reference ?? '') as Practitioner | undefined) : (role as Practitioner | undefined);
      return (who?.identifier ?? EMPTY).filter((i) => i.value).map((i) => `${i.system ?? ''}|${i.value}`);
    };
    const theirs = new Set(ids(b));
    return ids(a).some((k) => theirs.has(k));
  }

  /**
   * The document's legalAuthenticator is a `legal` attester, each authenticator a `professional` one: when, and who (as for any
   * assigned entity: a PractitionerRole of the Practitioner and their Organization).
   * @returns The Composition attesters, or undefined when the document names none.
   */
  private mapAuthenticatorsToAttesters(): CompositionAttester[] | undefined {
    const attesters = [
      ...(this.ccda.legalAuthenticator ? [{ mode: 'legal' as const, authenticator: this.ccda.legalAuthenticator }] : []),
      ...(this.ccda.authenticator ?? EMPTY).map((authenticator) => ({ mode: 'professional' as const, authenticator })),
    ].map(({ mode, authenticator }) => ({
      mode,
      time: mapCcdaToFhirDateTime(authenticator.time?.['@_value']),
      party: this.mapAssignedEntityToReference(authenticator.assignedEntity),
    }));
    return attesters.length > 0 ? attesters : undefined;
  }

  private mapCustodianToReference(custodian: CcdaCustodian | undefined): Reference<Organization> | undefined {
    if (!custodian) {
      return undefined;
    }

    const organization: Organization = {
      resourceType: 'Organization',
      id: this.mapId(custodian.assignedCustodian.representedCustodianOrganization.id),
      identifier: this.mapIdentifiers(custodian.assignedCustodian.representedCustodianOrganization.id),
      name: custodian.assignedCustodian.representedCustodianOrganization.name?.[0],
      address: this.mapAddresses(custodian.assignedCustodian.representedCustodianOrganization.addr),
      telecom: this.mapTelecom(custodian.assignedCustodian.representedCustodianOrganization.telecom),
    };

    this.resources.push(organization);

    return createReference(organization);
  }

  private mapDocumentationOfToEvent(documentationOf: CcdaDocumentationOf | undefined): CompositionEvent[] | undefined {
    if (!documentationOf) {
      return undefined;
    }

    const serviceEvent = documentationOf.serviceEvent;
    if (!serviceEvent) {
      return undefined;
    }

    return [
      {
        code: serviceEvent.code ? [this.mapCode(serviceEvent.code) as CodeableConcept] : undefined,
        period: this.mapEffectiveTimeToPeriod(serviceEvent.effectiveTime?.[0]),
      },
    ];
  }

  private concatArrays<T>(array1: T[] | undefined, array2: T[] | undefined): T[] | undefined {
    if (!array1) {
      return array2;
    }
    if (!array2) {
      return array1;
    }
    return [...array1, ...array2];
  }

  private mapCcdaPerformerArrayToImmunizationPerformerArray(performers: CcdaPerformer[]): ImmunizationPerformer[] {
    const result: ImmunizationPerformer[] = [];

    for (const performer of performers) {
      const entity = performer.assignedEntity;
      const reference = this.mapAssignedEntityToReference(entity);
      if (reference) {
        result.push({ actor: reference });
      }
    }

    return result;
  }

  private processOrganizer(section: CcdaSection, organizer: CcdaOrganizer): Resource {
    if (getTemplateIds(section).includes(OID_CARE_TEAMS_SECTION)) {
      return this.processCareTeamOrganizer(organizer);
    }
    // Route by the organizer's own templates: it can have several, such as a vendor template and a C-CDA one
    const templateIds = getTemplateIds(organizer);
    if (templateIds.includes(OID_FAMILY_HISTORY_ORGANIZER)) {
      return this.processFamilyHistoryOrganizer(organizer);
    }
    if (templateIds.includes(OID_RESULT_ORGANIZER) || templateIds.includes(OID_RESULT_ORGANIZER_V2)) {
      return this.processResultOrganizer(section, organizer);
    }
    return this.processVitalsOrganizer(section, organizer);
  }

  private processResultOrganizer(section: CcdaSection, organizer: CcdaOrganizer): DiagnosticReport {
    // A result panel is a report whose results are its observations (C-CDA on FHIR: Result Organizer → DiagnosticReport)
    const statuses: Record<string, DiagnosticReport['status']> = {
      completed: 'final',
      active: 'partial',
      aborted: 'cancelled',
      cancelled: 'cancelled',
    };
    const results: Reference<Observation>[] = [];
    for (const component of organizer.component ?? EMPTY) {
      results.push(...this.processVitalsComponent(component, section));
    }
    const id = this.mapId(organizer.id);
    // The panel's specimens (organizer/specimen, and each collection procedure's specimen participant), one per specimen id
    const specimens = (organizer.specimen ?? EMPTY).map((s) => this.mapSpecimen(s.specimenRole));
    // Other components: a procedure (e.g. the specimen collection) is a Procedure reporting in this report; an encounter (the
    // ordering visit) is the report's encounter (resolved after all sections: an entry's Encounter of the same id is reused)
    for (const component of organizer.component ?? EMPTY) {
      for (const procedure of component.procedure ?? EMPTY) {
        const result = this.processProcedure(section, procedure);
        result.report = [{ reference: `DiagnosticReport/${id}` }];
        this.resources.push(result);
        const received = (procedure.entryRelationship ?? EMPTY)
          .flatMap((er) => er.act ?? EMPTY)
          .find((a) => getTemplateIds(a).includes(OID_SPECIMEN_RECEIVED));
        for (const participant of procedure.participant ?? EMPTY) {
          if (participant['@_typeCode'] === 'PRD' && participant.participantRole?.['@_classCode'] === 'SPEC') {
            specimens.push(this.mapSpecimen(participant.participantRole, procedure, received));
          }
        }
      }
    }
    const encounters = (organizer.component ?? EMPTY).flatMap((c) => c.encounter ?? EMPTY);
    const report: DiagnosticReport = {
      resourceType: 'DiagnosticReport',
      id,
      identifier: this.mapIdentifiers(organizer.id),
      status: statuses[organizer.statusCode?.['@_code'] ?? ''] ?? 'unknown',
      category: [{ coding: [{ system: DIAGNOSTIC_SERVICE_SECTION_CODE_SYSTEM, code: 'LAB', display: 'Laboratory' }] }],
      // The code is required in FHIR, so a panel the document does not name is unknown
      code: this.mapCode(organizer.code) ?? {
        extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }],
      },
      subject: createReference(this.patient as Patient),
      ...this.mapObservationEffectiveTime(organizer.effectiveTime?.[0]),
      // Who performed the tests (the lab, as an assigned entity)
      performer: organizer.performer?.length
        ? organizer.performer.map((p) => this.mapAssignedEntityToReference(p.assignedEntity)).filter((r) => !!r)
        : undefined,
      specimen: specimens.length > 0 ? [...new Set(specimens.map((r) => r.reference))].map((reference) => ({ reference })) : undefined,
      result: results.length > 0 ? results : undefined,
    };
    if (encounters.length > 0) {
      this.reportEncounters.push({ report, section, encounters });
    }
    return report;
  }

  /**
   * A specimen (a specimenRole) is a Specimen, one per specimen id in the document: its id and type, and, from the procedure
   * that collected it, when and where it was collected and when it was received (an IHE Specimen Received act).
   * @param role - The specimen role.
   * @param collection - The collection procedure, if any.
   * @param received - Its specimen received act, if any.
   * @returns A reference to the Specimen.
   */
  private mapSpecimen(role: CcdaParticipantRole | undefined, collection?: CcdaProcedure, received?: CcdaAct): Reference<Specimen> {
    const identifier = this.mapIdentifiers(role?.id);
    const key = identifier?.filter((i) => i.value).map((i) => `${i.system ?? ''}|${i.value}`)[0];
    let specimen = key ? this.specimens.get(key) : undefined;
    if (!specimen) {
      specimen = {
        resourceType: 'Specimen',
        id: this.mapId(role?.id),
        identifier,
        subject: this.patient ? createReference(this.patient) : undefined,
      };
      this.resources.push(specimen);
      if (key) {
        this.specimens.set(key, specimen);
      }
    }
    // A specimenRole names its material as specimenPlayingEntity, a participantRole as playingEntity
    specimen.type ??= this.mapCode((role?.specimenPlayingEntity ?? role?.playingEntity)?.code);
    const collected = mapCcdaToFhirDateTime(collection?.effectiveTime?.[0]?.['@_value'] ?? collection?.effectiveTime?.[0]?.low?.['@_value']);
    if (collection && !specimen.collection) {
      specimen.collection = {
        collectedDateTime: collected,
        method: this.mapCode(collection.code),
        bodySite: this.mapCode(collection.targetSiteCode),
      };
    }
    specimen.receivedTime ??= mapCcdaToFhirDateTime(received?.effectiveTime?.[0]?.['@_value']);
    return createReference(specimen);
  }

  /**
   * Each result report's encounter components (the ordering visit): an Encounter an entry made for the same id, else a new one;
   * the report's encounter is the first.
   */
  private resolveReportEncounters(): void {
    const key = (i: Identifier): string => `${i.system ?? ''}|${i.value ?? ''}`;
    for (const { report, section, encounters } of this.reportEncounters) {
      const refs = encounters.map((encounter) => {
        const keys = new Set((this.mapIdentifiers(encounter.id) ?? EMPTY).filter((i) => i.value).map(key));
        const existing = keys.size
          ? this.resources.find((r): r is Encounter => r.resourceType === 'Encounter' && !!r.identifier?.some((i) => keys.has(key(i))))
          : undefined;
        if (existing) {
          return createReference(existing);
        }
        const made = this.processEncounter(section, encounter);
        this.resources.push(made);
        return createReference(made);
      });
      report.encounter = refs[0];
    }
  }

  private processCareTeamOrganizer(organizer: CcdaOrganizer): CareTeam {
    const participants: CareTeamParticipant[] = [];

    for (const component of organizer.component ?? EMPTY) {
      participants.push(...this.processCareTeamMembers(component));
    }

    const result: CareTeam = {
      resourceType: 'CareTeam',
      id: this.mapId(organizer.id),
      identifier: this.mapIdentifiers(organizer.id),
      subject: this.patient ? createReference(this.patient) : undefined,
      participant: participants.length > 0 ? participants : undefined,
    };

    return result;
  }

  private processCareTeamMembers(component: CcdaOrganizerComponent): CareTeamParticipant[] {
    // Every member act, and every performer of each act, is a participant
    const result: CareTeamParticipant[] = [];
    for (const act of component.act ?? EMPTY) {
      for (const performer of act.performer ?? EMPTY) {
        result.push({
          role: performer.functionCode ? [this.mapCode(performer.functionCode) as CodeableConcept] : undefined,
          member: this.mapAssignedEntityToReference(performer.assignedEntity),
          period: this.mapEffectiveTimeToPeriod(act.effectiveTime?.[0]),
        });
      }
    }
    return result;
  }

  private processFamilyHistoryOrganizer(organizer: CcdaOrganizer): FamilyMemberHistory {
    const relatedSubject = organizer.subject?.relatedSubject;
    const person = relatedSubject?.subject;
    const sex = this.mapGenderCode(person?.administrativeGenderCode?.['@_code']);
    // GA: the relative's birth and death (sdtc:deceasedInd, with sdtc:deceasedTime when given)
    const deceased = person?.['sdtc:deceasedInd']?.['@_value'];
    const deceasedDate = mapCcdaToFhirDate(person?.['sdtc:deceasedTime']?.['@_value']);

    const conditions: FamilyMemberHistoryCondition[] = [];
    for (const component of organizer.component ?? EMPTY) {
      for (const observation of component.observation ?? EMPTY) {
        const condition = this.processFamilyHistoryObservation(observation);
        if (condition) {
          conditions.push(condition);
        }
      }
    }

    return {
      resourceType: 'FamilyMemberHistory',
      id: this.mapId(organizer.id),
      identifier: this.mapIdentifiers(organizer.id),
      status: 'completed',
      patient: createReference(this.patient as Patient),
      // The relationship is required in FHIR, so a relationship the document does not state is unknown
      relationship: this.mapCode(relatedSubject?.code) ?? {
        extension: [
          {
            url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
            valueCode: 'unknown',
          },
        ],
      },
      sex: sex ? { coding: [{ system: ADMINISTRATIVE_GENDER_CODE_SYSTEM, code: sex }] } : undefined,
      bornDate: mapCcdaToFhirDate(person?.birthTime?.['@_value']),
      deceasedDate: deceased !== 'false' ? deceasedDate : undefined,
      deceasedBoolean: deceasedDate && deceased !== 'false' ? undefined : deceased === 'true' ? true : deceased === 'false' ? false : undefined,
      condition: conditions.length > 0 ? conditions : undefined,
    };
  }

  private processFamilyHistoryObservation(observation: CcdaObservation): FamilyMemberHistoryCondition | undefined {
    // FHIR has no negated condition of a family member, so a negated observation would state the opposite
    if (observation['@_negationInd'] === 'true') {
      return undefined;
    }

    const code = this.mapCode(observation.value as CcdaCode);
    if (!code) {
      return undefined;
    }

    const related =
      observation.entryRelationship
        ?.flatMap((relationship) => relationship.observation ?? EMPTY)
        .filter((relatedObservation) => relatedObservation['@_negationInd'] !== 'true') ?? [];
    const ageObservation = related.find((o) => o.templateId?.some((t) => t['@_root'] === OID_AGE_OBSERVATION));
    const causedDeath = related.some((o) =>
      o.templateId?.some((t) => t['@_root'] === OID_FAMILY_HISTORY_DEATH_OBSERVATION)
    );

    // GA: without an age at onset, the observation's own time is the onset (FHIR allows one onset)
    const onsetAge = this.mapQuantity(ageObservation?.value as CcdaQuantity | undefined);
    const time = observation.effectiveTime?.[0];
    const onsetPeriod = time?.['@_value'] ? { start: mapCcdaToFhirDateTime(time['@_value']) } : this.mapEffectiveTimeToPeriod(time);
    return {
      code,
      onsetAge,
      onsetPeriod: !onsetAge && (onsetPeriod?.start || onsetPeriod?.end) ? onsetPeriod : undefined,
      ...(causedDeath && { contributedToDeath: true }),
    };
  }

  private processVitalsOrganizer(section: CcdaSection, organizer: CcdaOrganizer): Observation {
    const result: Observation = {
      resourceType: 'Observation',
      id: this.mapId(organizer.id),
      identifier: this.mapIdentifiers(organizer.id),
      status: 'final',
      category: this.mapObservationCategory(organizer.templateId, section),
      code: this.mapCode(organizer.code) as CodeableConcept,
      subject: createReference(this.patient as Patient),
    };

    Object.assign(result, this.mapObservationEffectiveTime(organizer.effectiveTime?.[0]));

    const members: Reference<Observation>[] = [];
    for (const component of organizer.component ?? EMPTY) {
      members.push(...this.processVitalsComponent(component, section));
    }

    if (members.length > 0) {
      result.hasMember = members;
    }
    return result;
  }

  private processVitalsComponent(component: CcdaOrganizerComponent, section: CcdaSection): Reference<Observation>[] {
    const result: Reference<Observation>[] = [];
    for (const observation of component.observation ?? EMPTY) {
      const child = this.processVitalsObservation(observation, section);
      if (child) {
        result.push(createReference(child));
        this.resources.push(child);
      }
    }
    return result;
  }

  private processObservation(section: CcdaSection, observation: CcdaObservation): Resource | undefined {
    const observationTemplateIds = getTemplateIds(observation);
    if (observationTemplateIds.includes(OID_GOALS_SECTION) || observationTemplateIds.includes(OID_GOAL_OBSERVATION)) {
      // Goal template
      return this.processGoalObservation(observation);
    }

    const sectionTemplateIds = getTemplateIds(section);
    if (sectionTemplateIds.includes(OID_PLAN_OF_CARE_SECTION) && SERVICE_REQUEST_INTENTS[observation['@_moodCode']]) {
      // A planned observation (a test to be done) is a request, not a goal
      return this.processPlannedObservation(observation);
    }
    if (sectionTemplateIds.includes(OID_PLAN_OF_CARE_SECTION) || sectionTemplateIds.includes(OID_GOALS_SECTION)) {
      return this.processGoalObservation(observation);
    }

    // Treat this as a normal observation by default
    return this.processVitalsObservation(observation, section);
  }

  private processPlannedObservation(observation: CcdaObservation): ServiceRequest {
    const text = nodeToString(observation.text) || this.resolveNarrativeReference(observation.text?.reference);
    const when = this.mapObservationEffectiveTime(observation.effectiveTime?.[0]);
    return {
      resourceType: 'ServiceRequest',
      id: this.mapId(observation.id),
      identifier: this.mapIdentifiers(observation.id),
      status: SERVICE_REQUEST_STATUSES[observation.statusCode?.['@_code'] ?? ''] ?? 'unknown',
      intent: SERVICE_REQUEST_INTENTS[observation['@_moodCode']] ?? 'order',
      // A negated planned observation is a plan not to do it
      doNotPerform: observation['@_negationInd'] === 'true' ? true : undefined,
      code: this.mapCode(observation.code),
      subject: createReference(this.patient as Patient),
      occurrenceDateTime: when.effectiveDateTime,
      occurrencePeriod: when.effectivePeriod,
      authoredOn: mapCcdaToFhirDateTime(observation.author?.[0]?.time?.['@_value']),
      requester: this.mapAuthorToReference(observation.author?.[0]),
      note: text ? [{ text }] : undefined,
      extension: this.mapTextReference(observation.text),
    };
  }

  private processGoalObservation(observation: CcdaObservation): Goal {
    const category: CodeableConcept[] = [];
    if (observation.code) {
      category.push(this.mapCode(observation.code) as CodeableConcept);
    }

    const target: GoalTarget[] = [];

    let description: CodeableConcept | undefined = undefined;
    const ccdaValue = observation.value;
    if (ccdaValue) {
      const type = ccdaValue['@_xsi:type'];
      if (type === 'CD') {
        description = mapCcdaCodeToCodeableConcept(ccdaValue);
      } else if (type === 'ST') {
        description = { text: ccdaValue['#text'] ?? '' };
      }
    }

    for (const entryRelationship of observation.entryRelationship ?? EMPTY) {
      const act = entryRelationship.act?.[0];
      const measure = this.mapCode(act?.code);
      const dueDate = mapCcdaToFhirDateTime(act?.effectiveTime?.[0]?.low?.['@_value']);
      // Only an act is a target: an observation-only relationship (or an act with neither code nor time) says nothing about one
      if (measure || dueDate) {
        target.push({ measure, detailCodeableConcept: measure, dueDate });
      }
    }

    const result: Goal = {
      resourceType: 'Goal',
      id: this.mapId(observation.id),
      extension: this.mapTextReference(observation.text),
      identifier: this.mapIdentifiers(observation.id),
      lifecycleStatus: this.mapGoalLifecycleStatus(observation),
      category: category.length > 0 ? category : undefined,
      description: description ?? { text: 'Unknown goal' },
      subject: createReference(this.patient as Patient),
      startDate: mapCcdaToFhirDate(observation.effectiveTime?.[0]?.['@_value']),
      target: target.length > 0 ? target : undefined,
    };

    return result;
  }

  private mapGoalLifecycleStatus(observation: CcdaObservation): Goal['lifecycleStatus'] {
    // - Map from observation's `statusCode/@code`
    // - Mapping logic:
    //   - If statusCode is "active" → "active"
    //   - If statusCode is "completed" → "achieved"
    //   - If statusCode is "cancelled" → "cancelled"
    //   - If statusCode is "aborted" → "cancelled"
    //   - If no status or other value → "active"
    const map: { [key: string]: Goal['lifecycleStatus'] } = {
      active: 'active',
      completed: 'completed',
      cancelled: 'cancelled',
      aborted: 'cancelled',
    };
    return map[observation.statusCode?.['@_code'] ?? 'active'];
  }

  private processVitalsObservation(observation: CcdaObservation, section: CcdaSection): Observation | undefined {
    // Skip observations with neither a valid code (e.g., nullFlavor="NA") nor a value; a value without a code is still a result,
    // and FHIR requires a code, so it is data-absent
    const value = observation.value as Record<string, unknown> | undefined;
    const valued = OBSERVATION_VALUE_CONTENT.some((k) => value?.[k] !== undefined);
    const code =
      this.mapCode(observation.code) ??
      (valued
        ? { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] }
        : undefined);
    if (!code) {
      return undefined;
    }

    const result: Observation = {
      resourceType: 'Observation',
      id: this.mapId(observation.id),
      identifier: this.mapIdentifiers(observation.id),
      status: 'final',
      category: this.mapObservationCategory(observation.templateId, section),
      code,
      subject: createReference(this.patient as Patient),
      referenceRange: this.mapReferenceRangeArray(observation.referenceRange),
      interpretation: this.mapInterpretation(observation.interpretationCode),
      performer: observation.author
        ?.map((author) => this.mapAuthorToReference(author))
        .filter(Boolean) as Reference<Practitioner>[],
    };

    if (observation.value?.['@_xsi:type'] && !valued) {
      // A typed value with no content (its nullFlavor, stripped by sanitizeNullFlavors) is data-absent, never an empty value
      result.dataAbsentReason = { coding: [{ system: DATA_ABSENT_REASON_CODE_SYSTEM, code: 'unknown' }] };
    } else if (observation.value?.['@_xsi:type']) {
      switch (observation.value['@_xsi:type']) {
        case 'PQ': { // Physical Quantity; a number that does not parse gives no value (never NaN)
          const number = Number.parseFloat(observation.value['@_value'] ?? '');
          if (Number.isFinite(number)) {
            result.valueQuantity = {
              value: number,
              unit: observation.value['@_unit'],
              system: UCUM,
              code: observation.value['@_unit'],
            };
          }
          break;
        }

        case 'REAL': // Real number, with a unit only if the document gives one
          result.valueQuantity = this.mapQuantity(observation.value);
          break;

        case 'CD': // Code
        case 'CE': // Code with Extensions
        case 'CO': // Coded Ordinal (a code with an order, such as 1+ or Positive)
          result.valueCodeableConcept = this.mapCode(observation.value);
          break;

        case 'ST': // String
          result.valueString = observation.value['#text'] ?? '';
          break;

        case 'ED': // Encapsulated Data
          result.valueString = this.mapEncapsulatedDataToString(observation.value);
          break;

        case 'TS': // Timestamp, such as a last menstrual period date
        case 'BL': // Boolean
          Object.assign(result, mapTimestampOrBooleanValue(observation.value));
          break;

        case 'INT': // Integer
          result.valueInteger = Number.isFinite(Number.parseInt(observation.value['@_value'] ?? '', 10))
            ? Number.parseInt(observation.value['@_value'] as string, 10)
            : undefined;
          break;

        default:
          console.warn(`Unhandled observation value type: ${observation.value['@_xsi:type']}`);
      }
    }

    Object.assign(result, this.mapObservationEffectiveTime(observation.effectiveTime?.[0]));

    result.extension = this.mapTextReference(observation.text);

    // Look for child observations
    const relationships = observation.entryRelationship;
    for (const relationship of relationships ?? EMPTY) {
      const childObservation = relationship.observation;
      for (const child of childObservation ?? EMPTY) {
        const childResource = this.processVitalsObservation(child, section);
        if (childResource) {
          this.resources.push(childResource);
          if (!result.hasMember) {
            result.hasMember = [];
          }
          result.hasMember.push(createReference(childResource));
        }
      }
    }

    return result;
  }

  private mapInterpretation(codes: CcdaCode[] | undefined): CodeableConcept[] | undefined {
    // Every interpretationCode (High, Abnormal, ...); a nullFlavor maps to nothing
    const result = codes?.map((code) => this.mapCode(code)).filter(Boolean) as CodeableConcept[] | undefined;
    return result?.length ? result : undefined;
  }

  private mapEncapsulatedDataToString(value: CcdaReference): string | undefined {
    const mediaType = value['@_mediaType'] ?? 'text/plain';
    const representation = value['@_representation'] ?? 'TXT';
    if (!mediaType.startsWith('text/') || representation !== 'TXT') {
      // Binary content, such as a PDF, has no Observation.value[x] type in FHIR R4
      console.warn(`Unhandled observation value type: ED (${mediaType}, ${representation})`);
      return undefined;
    }
    return value['#text'] || this.resolveNarrativeReference(value.reference);
  }

  private mapObservationCategory(
    templateIds: CcdaTemplateId[] | undefined,
    section: CcdaSection
  ): CodeableConcept[] | undefined {
    // Its own templates' categories; its section's when they give none (an observation may carry only a vendor template), and
    // always social-history in the Social History section (an assessment there is both)
    const own = this.mapObservationTemplateIdToObservationCategory(templateIds) ?? [];
    const sectionTemplates = (section.templateId ?? []).filter(
      (t) => own.length === 0 || SOCIAL_HISTORY_SECTIONS.includes(t['@_root'])
    );
    const result = this.mapObservationTemplateIdToObservationCategory([...(templateIds ?? []), ...sectionTemplates]) ?? [];
    if (result.length === 0) {
      // Nothing classifies it (such as a Reason for Visit observation): its section's code says what it is
      const sectionCode = this.mapCode(section.code);
      if (sectionCode) {
        result.push(sectionCode);
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private mapObservationTemplateIdToObservationCategory(
    templateIds: CcdaTemplateId[] | undefined
  ): CodeableConcept[] | undefined {
    if (!templateIds) {
      return undefined;
    }

    const codes = new Set<string>();
    const result: CodeableConcept[] = [];

    for (const templateId of templateIds) {
      const category = OBSERVATION_CATEGORY_MAPPER.mapCcdaToFhirCodeableConcept(templateId['@_root']);
      if (category?.coding?.[0]?.code && !codes.has(category.coding[0].code)) {
        codes.add(category.coding[0].code);
        result.push(category);
      }
    }

    return Array.from(result.values());
  }

  private mapReferenceRangeArray(
    referenceRange: CcdaReferenceRange[] | undefined
  ): ObservationReferenceRange[] | undefined {
    if (!referenceRange || referenceRange.length === 0) {
      return undefined;
    }

    return referenceRange.map((r) => this.mapReferenceRange(r)).filter(Boolean) as ObservationReferenceRange[];
  }

  private mapReferenceRange(referenceRange: CcdaReferenceRange | undefined): ObservationReferenceRange | undefined {
    if (!referenceRange) {
      return undefined;
    }

    const observationRange = referenceRange.observationRange;
    if (!observationRange) {
      return undefined;
    }

    const result: ObservationReferenceRange = {};

    result.extension = this.mapTextReference(observationRange.text);

    const value = observationRange.value as CcdaQuantity | undefined;
    if (value?.low) {
      result.low = {
        value: value.low['@_value'] ? Number.parseFloat(value.low['@_value']) : undefined,
        unit: value.low['@_unit'],
        system: UCUM,
        code: value.low['@_unit'],
      };
    }
    if (value?.high) {
      result.high = {
        value: value.high['@_value'] ? Number.parseFloat(value.high['@_value']) : undefined,
        unit: value.high['@_unit'],
        system: UCUM,
        code: value.high['@_unit'],
      };
    }

    if (!result.extension && !result.low && !result.high) {
      return undefined;
    }

    return result;
  }

  private mapLocationToReference(role: CcdaParticipantRole): Reference<Location> {
    const location: Location = {
      resourceType: 'Location',
      id: this.mapId(role.id),
      identifier: this.mapIdentifiers(role.id),
      name: nodeToString(role.playingEntity?.name?.[0] as string | undefined),
      type: role.code ? [this.mapCode(role.code) as CodeableConcept] : undefined,
      address: this.mapAddresses(role.addr)?.[0],
      telecom: this.mapTelecom(role.telecom),
    };
    this.resources.push(location);
    return createReference(location);
  }

  /**
   * Encounter.class is a v3 ActCode (ActEncounterCode): the encounter code or one of its translations in that system. Another
   * code (a CPT visit code) is only the encounter type; with no ActCode the class is data-absent.
   * @param code - The encounter code.
   * @returns The class.
   */
  private mapEncounterClass(code: CcdaCode | undefined): Coding {
    const act = [code, ...(code?.translation ?? EMPTY)].find(
      (c) => c?.['@_codeSystem'] === OID_ACT_CODE_CODE_SYSTEM && c['@_code']
    );
    if (!act) {
      return { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'unknown' }] };
    }
    return { system: ACT_CODE_SYSTEM, code: act['@_code'], display: act['@_displayName'] };
  }

  private processEncounter(section: CcdaSection, encounter: CcdaEncounter): Encounter {
    // Create the main encounter resource
    const result: Encounter = {
      resourceType: 'Encounter',
      id: this.mapId(encounter.id),
      identifier: this.mapIdentifiers(encounter.id),
      status: ENCOUNTER_STATUS_MAPPER.mapCcdaToFhirWithDefault(encounter.statusCode?.['@_code'], 'unknown'),
      class: this.mapEncounterClass(encounter.code),
      type: encounter.code ? [this.mapCode(encounter.code) as CodeableConcept] : undefined,
      subject: createReference(this.patient as Patient),
      period: this.mapEffectiveTimeToPeriod(encounter.effectiveTime?.[0]),
    };

    // Service delivery locations (participant typeCode LOC)
    const locations = (encounter.participant ?? EMPTY)
      .filter((participant) => participant['@_typeCode'] === 'LOC' && participant.participantRole)
      .map((participant) => ({ location: this.mapLocationToReference(participant.participantRole as CcdaParticipantRole) }));
    if (locations.length > 0) {
      result.location = locations;
    }

    // Add participant information
    if (encounter.performer) {
      result.participant = encounter.performer.map((performer) => ({
        type: [
          {
            coding: [
              {
                system: PARTICIPATION_CODE_SYSTEM,
                code: performer['@_typeCode'] ?? 'PPRF',
                display: 'Primary Performer',
              },
            ],
          },
        ],
        individual: this.mapAssignedEntityToReference(performer.assignedEntity),
      }));
    }

    // Add diagnoses from entryRelationships
    if (encounter.entryRelationship) {
      const diagnoses = encounter.entryRelationship
        .filter((rel) => rel['@_typeCode'] === 'RSON')
        .map((rel) => {
          const observation = rel.observation?.[0];
          if (!observation) {
            return undefined;
          }

          // Create Condition resource
          const condition: Condition = {
            resourceType: 'Condition',
            id: this.mapId(observation.id),
            identifier: this.mapIdentifiers(observation.id),
            clinicalStatus: {
              coding: [
                {
                  system: CLINICAL_CONDITION_CODE_SYSTEM,
                  code: 'active',
                },
              ],
            },
            verificationStatus: {
              coding: [
                {
                  system: CONDITION_VER_STATUS_CODE_SYSTEM,
                  code: 'confirmed',
                },
              ],
            },
            code: this.mapCode(observation.value as CcdaCode),
            subject: createReference(this.patient as Patient),
            onsetDateTime: mapCcdaToFhirDateTime(observation.effectiveTime?.[0]?.low?.['@_value']),
          };

          // Add condition to resources array
          this.resources.push(condition);

          return {
            condition: createReference(condition),
            use: {
              coding: [
                {
                  system: DIAGNOSIS_ROLE_CODE_SYSTEM,
                  code: 'AD',
                  display: 'Admission diagnosis',
                },
              ],
            },
          };
        })
        .filter(Boolean) as EncounterDiagnosis[];

      if (diagnoses.length > 0) {
        result.diagnosis = diagnoses;
      }
    }

    // Encounter Diagnosis acts (Epic links them with SUBJ, the IG with REFR): each problem observation is a visit diagnosis
    for (const rel of encounter.entryRelationship ?? EMPTY) {
      for (const act of rel.act ?? EMPTY) {
        if (getTemplateIds(act).some((id) => id === OID_ENCOUNTER_DIAGNOSIS || id === OID_ENCOUNTER_DIAGNOSIS_V2)) {
          for (const condition of this.processConditionAct(act, ENCOUNTER_DIAGNOSIS)) {
            condition.encounter = createReference(result);
            this.resources.push(condition);
          }
        }
      }
    }

    result.extension = this.mapTextReference(encounter.text);

    return result;
  }

  private processProcedure(section: CcdaSection, procedure: CcdaProcedure): Procedure {
    const result: Procedure = {
      resourceType: 'Procedure',
      id: this.mapId(procedure.id),
      identifier: this.mapIdentifiers(procedure.id),
      status: PROCEDURE_STATUS_MAPPER.mapCcdaToFhirWithDefault(
        procedure.statusCode?.['@_code'],
        'completed'
      ) as Procedure['status'],
      code: this.mapCode(procedure.code),
      subject: createReference(this.patient as Patient),
      performedPeriod: this.mapEffectiveTimeToPeriod(procedure.effectiveTime?.[0]),
      bodySite: procedure.targetSiteCode ? [this.mapCode(procedure.targetSiteCode) as CodeableConcept] : undefined,
      extension: this.mapTextReference(procedure.text),
    };

    return result;
  }

  private mapTextReference(text: string | CcdaText | undefined): Extension[] | undefined {
    if (!text || typeof text !== 'object') {
      return undefined;
    }

    if (!text?.reference?.['@_value']) {
      return undefined;
    }

    return [
      {
        url: CCDA_NARRATIVE_REFERENCE_URL,
        valueString: text.reference?.['@_value'],
      },
    ];
  }
}

/**
 * Returns the roots of a node's templateIds, in document order.
 * A section may list several templates in any order (Epic lists the entries-optional one first), so match any of them.
 * @param node - The C-CDA node (section, entry, observation, ...).
 * @returns The templateId roots, or an empty array.
 */
function getTemplateIds(node: { templateId?: CcdaTemplateId[] }): string[] {
  return node.templateId?.map((templateId) => templateId['@_root']) ?? [];
}

function nodeToString(node: CcdaText | string | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (typeof node === 'string') {
    return node;
  }
  if (typeof node === 'object' && '#text' in node) {
    return node['#text'];
  }
  return undefined;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Returns the plain text of a title: its raw inner XML (a parser stop node, so markup such as `<content>` stays in
 * order) without tags, entities decoded, whitespace collapsed.
 * @param node - The parsed title: a string, or an object with `#text` when the title has attributes.
 * @returns The plain text, or undefined when there is none.
 */
// What makes an observation value say something (anything else is its nullFlavor, stripped by sanitizeNullFlavors)
export const OBSERVATION_VALUE_CONTENT = ['@_value', '@_code', '@_displayName', '#text', 'reference', 'originalText', 'translation'];
const DATA_ABSENT_REASON_CODE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/data-absent-reason';
// FHIR R4 dateTime
const FHIR_DATE_TIME =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?)?)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)?)?)?$/;

/**
 * A TS or BL observation value: `valueDateTime` or `valueBoolean` (true/false in any case); data-absent when the value has
 * none (a nullFlavor); nothing when it does not parse, so a caller can tell an unread value apart.
 * @param value - The observation value.
 * @returns The Observation value fields.
 */
export function mapTimestampOrBooleanValue(
  value: CcdaTimestampOrBoolean
): Pick<Observation, 'valueDateTime' | 'valueBoolean' | 'dataAbsentReason'> {
  const raw = value['@_value']?.trim();
  if (!raw) {
    return { dataAbsentReason: { coding: [{ system: DATA_ABSENT_REASON_CODE_SYSTEM, code: 'unknown' }] } };
  }
  if (value['@_xsi:type'] === 'BL') {
    const bool = raw.toLowerCase();
    return bool === 'true' || bool === 'false' ? { valueBoolean: bool === 'true' } : {};
  }
  const dateTime = /^\d{4,14}(\.\d+)?([+-]\d{4})?$/.test(raw) ? mapCcdaToFhirDateTime(raw) : undefined;
  return dateTime && FHIR_DATE_TIME.test(dateTime) ? { valueDateTime: dateTime } : {};
}

export function nodeToPlainText(node: unknown): string | undefined {
  const raw = node && typeof node === 'object' ? (node as Record<string, unknown>)['#text'] : node;
  if (typeof raw !== 'string') {
    return undefined;
  }
  return (
    raw
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, dec, hex, name) => {
        const code = dec ? +dec : hex ? parseInt(hex, 16) : undefined;
        if (code === undefined) {
          return XML_ENTITIES[name] ?? m;
        }
        return code <= 0x10ffff ? String.fromCodePoint(code) : m;
      })
      .replace(/\s+/g, ' ')
      .trim() || undefined
  );
}

/**
 * Indexes the text of every section narrative element that has an ID, so that references such as `#Med0Name` resolve.
 * CDA IDs are unique within a document (xs:ID), so one index serves every section.
 * An ID that appears more than once is ambiguous, and maps to undefined.
 * @param ccda - The C-CDA document.
 * @returns The narrative text by ID.
 */
function indexNarrativeTexts(ccda: Ccda): Map<string, string | undefined> {
  const texts = new Map<string, string | undefined>();
  for (const component of ccda.component?.structuredBody?.component ?? EMPTY) {
    for (const section of component.section ?? EMPTY) {
      indexNarrativeText(section.text, texts);
    }
  }
  return texts;
}

/**
 * Returns the text of a parsed narrative node, and adds each element in it that has an ID to the index.
 * The parsed narrative does not keep the order of mixed content, so text around child elements may be reordered.
 * @param node - The parsed narrative node.
 * @param texts - The narrative text by ID.
 * @returns The text of the node and its descendants.
 */
function indexNarrativeText(node: unknown, texts: Map<string, string | undefined>): string {
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => indexNarrativeText(child, texts)).join(' ');
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const text = Object.entries(node)
    .filter(([key]) => !key.startsWith('@_'))
    .map(([, child]) => indexNarrativeText(child, texts))
    .join(' ');
  const id = (node as Record<string, unknown>)['@_ID'];
  if (typeof id === 'string') {
    texts.set(id, texts.has(id) ? undefined : text.replace(/\s+/g, ' ').trim() || undefined);
  }
  return text;
}
