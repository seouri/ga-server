import type { ImagingStudy, ImagingStudySeries } from '@medplum/fhirtypes';
import type { DicomHeader } from './read.ts';

const DCM = 'http://dicom.nema.org/resources/ontology/DCM';
const byNumber = <T extends { number?: number }>(a: T, b: T) => (a.number ?? Infinity) - (b.number ?? Infinity);

// One ImagingStudy per study UID, with its series and instances. Headers without a study or series UID have no place in one and are left out.
// subject: the Patient the study belongs to; the importer passes the GA patient.
export function toImagingStudies(headers: DicomHeader[], subject = 'Patient/dicom-patient'): ImagingStudy[] {
  const studies = new Map<string, Map<string, DicomHeader[]>>();
  for (const h of headers) {
    if (!h.studyUid || !h.seriesUid) continue;
    const series = studies.get(h.studyUid) ?? new Map<string, DicomHeader[]>();
    const list = series.get(h.seriesUid) ?? [];
    if (!list.some((x) => x.sopInstance === h.sopInstance)) list.push(h);
    series.set(h.seriesUid, list);
    studies.set(h.studyUid, series);
  }
  return [...studies].map(([uid, seriesMap]) => {
    const all = [...seriesMap.values()].flat();
    const first = all.find((h) => h.studyDate) ?? all[0];
    const base = all.find((h) => h.studyDescription)?.studyDescription;
    const time = all.find((h) => h.studyTime)?.studyTime;
    const description = time ? `${base ?? 'Study'} (study time ${time})` : base;
    const series: ImagingStudySeries[] = [...seriesMap].map(([suid, list]) => {
      const f = list[0];
      return {
        uid: suid, ...(f.seriesNumber !== undefined && { number: f.seriesNumber }), modality: { system: DCM, code: f.modality ?? 'OT' },
        ...(f.seriesDescription && { description: f.seriesDescription }), numberOfInstances: list.length,
        ...(f.bodyPart && { bodySite: { system: DCM, code: f.bodyPart } }),
        instance: list.map((h) => ({ uid: h.sopInstance, sopClass: { system: 'urn:ietf:rfc:3986', code: `urn:oid:${h.sopClass}` }, ...(h.instanceNumber !== undefined && { number: h.instanceNumber }) })).sort(byNumber),
      };
    }).sort(byNumber);
    const modalities = [...new Set(series.map((s) => s.modality.code as string))];
    return {
      resourceType: 'ImagingStudy', identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${uid}` }], status: 'available', subject: { reference: subject },
      ...(first.studyDate && { started: first.studyDate }), ...(description && { description }), modality: modalities.map((code) => ({ system: DCM, code })),
      numberOfSeries: series.length, numberOfInstances: all.length, series,
    } satisfies ImagingStudy;
  });
}
