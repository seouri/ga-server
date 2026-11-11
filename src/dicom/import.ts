import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, ImagingStudy } from '@medplum/fhirtypes';
import { archiveFolder, archiveTmp } from '../archive.ts';
import type { GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { importResources, type ImportReport } from '../engine.ts';
import { withImportLock } from '../lock.ts';
import { toImagingStudies } from './map.ts';
import { type DicomHeader, encapsulatedPdf, PDF_CLASS, readHeader } from './read.ts';

export type DicomReport = ImportReport & { studies: number; series: number; instances: number; documents: number; notDicom: number; unsupported: number; archive: 'stored' | 'already-present' };

// Reads every file under dir: DICOM headers become ImagingStudy resources, encapsulated PDFs become documents linked to their study,
// the whole folder is archived (never shared). Files that are not DICOM (DICOMDIR, previews, .DS_Store) are counted as notDicom
// (the engine's own `skipped` stays in the report).
export async function importDicom(client: MedplumClient, cfg: GaConfig, dir: string, patientId = cfg.patientId): Promise<DicomReport> {
  void cfg; // part of the importer signature shared with the other kinds; DICOM needs nothing from it
  const headers: DicomHeader[] = [];
  const pdfs: { file: string; header: DicomHeader }[] = [];
  let notDicom = 0;
  let unsupported = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    const h = readHeader(file);
    if (h === 'not-dicom') notDicom++;
    else if (h === 'unsupported') unsupported++;
    else {
      if (!h.studyUid || !h.seriesUid) notDicom++; // no place in a study
      headers.push(h);
      if (h.sopClass === PDF_CLASS) pdfs.push({ file, header: h });
    }
  }
  const studies = toImagingStudies(headers, `Patient/${patientId}`);
  const started = studies.map((s) => s.started).filter((d): d is string => !!d).sort().pop();
  const report: ImportReport = studies.length
    ? await withImportLock(() =>
        importResources(client, studies, { kind: 'dicom', file: resolve(dir), date: started ?? new Date().toISOString().slice(0, 10), writer: 'importer' }, patientId, ''))
    : { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] };

  let documents = 0;
  const tmp = `${archiveTmp(dir)}-pdf`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    for (const { file, header } of pdfs) {
      const bytes = encapsulatedPdf(file);
      if (!bytes) continue;
      const out = join(tmp, `${header.sopInstance}.pdf`);
      writeFileSync(out, bytes, { mode: 0o600 });
      const { docRef, created } = await storeDocument(client, out, patientId, 'application/pdf', [{ system: 'urn:dicom:uid', value: `urn:oid:${header.sopInstance}` }]);
      if (created) documents++;
      const study = header.studyUid && (await client.searchOne('ImagingStudy', { identifier: `urn:dicom:uid|urn:oid:${header.studyUid}`, subject: `Patient/${patientId}` }, { cache: 'no-cache' }));
      if (study && !docRef.context?.related?.length) await client.updateResource<DocumentReference>({ ...docRef, context: { ...docRef.context, related: [{ reference: `ImagingStudy/${(study as ImagingStudy).id}` }] } });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const archive = await archiveFolder(client, dir, patientId, 'urn:ga-server:id:dicom-archive');
  const instances = studies.reduce((n, s) => n + (s.numberOfInstances ?? 0), 0);
  return { ...report, studies: studies.length, series: studies.reduce((n, s) => n + (s.numberOfSeries ?? 0), 0), instances, documents, notDicom, unsupported, archive };
}
