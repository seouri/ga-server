// GA's one list of resource types, for its store (store-serve.ts) and ga setup's Medplum access policy (setup.ts). A module of
// its own: setup.ts is loaded by every ga command, which then gets the list without the store's modules (~7 MB RSS).
import { PATIENT_COMPARTMENT_PARAMS } from './store/definitions.ts';

// The types GA stores: every Patient compartment type (GA searches all of them, e.g. for the newest import and sharing;
// src/share/scope.ts), plus the shared and GA-internal types GA writes. Trimming the definitions to these saves memory
// (Linux, node 26: RSS added by opening a store with all 147 R4 resource types ~64 MB, with these ~54 MB; heap after load 24 vs 19 MB;
// both peak under 80 MB of heap while loading, inside ga-store's 192 MB; docs/superpowers/spikes/2026-11-08-store-memory.md).
// Every GA process that opens the store or loads its definitions passes this list (one type set per process).
export const GA_STORE_TYPES: readonly string[] = [...new Set([
  ...Object.keys(PATIENT_COMPARTMENT_PARAMS),
  'Patient', 'Medication', 'Endpoint', 'Basic', 'ConceptMap', 'Provenance', 'AuditEvent', 'DocumentReference', 'Binary', 'Practitioner',
  'PractitionerRole', 'Organization', 'Location', 'Device', 'Communication', 'QuestionnaireResponse', 'FamilyMemberHistory', 'Composition',
])];
