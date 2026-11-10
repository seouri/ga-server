import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, ImagingStudy } from '@medplum/fhirtypes';
import { archiveFolder, archiveTmp } from '../archive.ts';
import type { GaConfig } from '../config.ts';
import { storeDocument } from '../document.ts';
import { addReport, importResources, type ImportReport } from '../engine.ts';
import { withImportLock } from '../lock.ts';
import { toImagingStudies } from './map.ts';
import { type DicomHeader, encapsulatedPdf, readHeader } from './read.ts';

export type DicomReport = ImportReport & { studies: number; series: number; instances: number; documents: number; skipped: number; unsupported: number; archive: 'stored' | 'already-present' };

const PDF_CLASS = '1.2.840.10008.5.1.4.1.1.104.1';

// Reads every file under dir: DICOM headers become ImagingStudy resources, encapsulated PDFs become documents linked to their study,
// the whole folder is archived (never shared). Files that are not DICOM (DICOMDIR, previews, .DS_Store) are counted as skipped.
export async function importDicom(client: MedplumClient, cfg: GaConfig, dir: string, patientId = cfg.patientId): Promise<DicomReport> {
  void cfg; // part of the importer signature shared with the other kinds; DICOM needs nothing from it
  const headers: DicomHeader[] = [];
  const pdfs: { file: string; header: DicomHeader }[] = [];
  let skipped = 0;
  let unsupported = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    const h = readHeader(file);
    if (h === 'not-dicom') skipped++;
    else if (h === 'unsupported') unsupported++;
    else {
      if (!h.studyUid || !h.seriesUid) skipped++; // no place in a study
      headers.push(h);
      if (h.sopClass === PDF_CLASS) pdfs.push({ file, header: h });
    }
  }
  const studies = toImagingStudies(headers, `Patient/${patientId}`);
  const started = studies.map((s) => s.started).filter((d): d is string => !!d).sort().pop();
  const report: ImportReport = { created: 0, updated: 0, skipped: 0, merged: 0, conflicts: 0, possibleDuplicates: 0, invalid: 0, unmapped: [] };
  if (studies.length) {
    addReport(report, await withImportLock(() =>
      importResources(client, studies, { kind: 'dicom', file: resolve(dir), date: started ?? new Date().toISOString().slice(0, 10), writer: 'importer' }, patientId, '')));
  }

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
  return { ...report, studies: studies.length, series: studies.reduce((n, s) => n + (s.numberOfSeries ?? 0), 0), instances, documents, skipped, unsupported, archive };
}
