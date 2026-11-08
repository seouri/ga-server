// GA test helper: a minimal ClinicalDocument around the given section components, converted to FHIR.
import type { Bundle, Resource } from '@medplum/fhirtypes';
import { convertCcdaToFhir, type CcdaToFhirOptions } from '../ccda-to-fhir.ts';
import { convertXmlToCcda } from '../xml.ts';

export function convertSections(sectionsXml: string, options?: CcdaToFhirOptions): Bundle {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <recordTarget><patientRole><patient><name use="L"><given>Test</given><family>Patient</family></name></patient></patientRole></recordTarget>
  <component><structuredBody>${sectionsXml}</structuredBody></component>
</ClinicalDocument>`;
  return convertCcdaToFhir(convertXmlToCcda(xml), options);
}

export function resourcesOf<T extends Resource>(bundle: Bundle, resourceType: T['resourceType']): T[] {
  return (bundle.entry ?? []).map((e) => e.resource).filter((r): r is T => r?.resourceType === resourceType);
}
