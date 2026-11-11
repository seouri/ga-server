// A minimal DICOM header reader (node:fs only): the tags GA needs from the first 256 KB, and an encapsulated PDF's bytes.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

export type DicomHeader = {
  sopClass: string; sopInstance: string; transferSyntax: string; studyUid?: string; seriesUid?: string; studyDate?: string; studyTime?: string;
  modality?: string; studyDescription?: string; seriesDescription?: string; seriesNumber?: number; instanceNumber?: number; bodyPart?: string;
};

const HEAD_BYTES = 256 * 1024;
export const PDF_CLASS = '1.2.840.10008.5.1.4.1.1.104.1';
const IMPLICIT = '1.2.840.10008.1.2';
const BIG_ENDIAN = '1.2.840.10008.1.2.2';
const DEFLATED = '1.2.840.10008.1.2.1.99';
const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'OD', 'OL', 'UC', 'UR', 'OV', 'SV', 'UV']);
const UNDEFINED = 0xffffffff;
const key = (g: number, e: number): number => g * 0x10000 + e;
const FIELD: Record<number, keyof DicomHeader | 'transfer' | undefined> = {
  [key(2, 0x10)]: 'transfer', [key(8, 0x16)]: 'sopClass', [key(8, 0x18)]: 'sopInstance', [key(8, 0x20)]: 'studyDate', [key(8, 0x30)]: 'studyTime',
  [key(8, 0x60)]: 'modality', [key(8, 0x1030)]: 'studyDescription', [key(8, 0x103e)]: 'seriesDescription', [key(0x18, 0x15)]: 'bodyPart',
  [key(0x20, 0x0d)]: 'studyUid', [key(0x20, 0x0e)]: 'seriesUid', [key(0x20, 0x11)]: 'seriesNumber', [key(0x20, 0x13)]: 'instanceNumber',
};

type Elem = { tag: number; start: number; length: number; next: number }; // start: first value byte; length may be UNDEFINED

// One data element at pos; undefined if it does not fit in the buffer. Item and delimiter tags (group FFFE) never carry a VR.
function element(b: Buffer, pos: number, implicit: boolean): Elem | undefined {
  if (pos + 8 > b.length) return undefined;
  const g = b.readUInt16LE(pos);
  const tag = key(g, b.readUInt16LE(pos + 2));
  if (implicit || g === 0xfffe) return { tag, start: pos + 8, length: b.readUInt32LE(pos + 4), next: 0 };
  const vr = b.toString('latin1', pos + 4, pos + 6);
  if (LONG_VR.has(vr)) return pos + 12 > b.length ? undefined : { tag, start: pos + 12, length: b.readUInt32LE(pos + 8), next: 0 };
  return { tag, start: pos + 8, length: b.readUInt16LE(pos + 6), next: 0 };
}

// End of the value of e: its length, or for an undefined length the byte after the matching sequence delimitation item.
const MAX_DEPTH = 64;
function valueEnd(b: Buffer, e: Elem, implicit: boolean, depth = 0): number | undefined {
  if (e.length !== UNDEFINED) return e.start + e.length;
  if (depth > MAX_DEPTH) return undefined;
  let pos = e.start;
  for (;;) {
    const it = element(b, pos, implicit);
    if (!it) return undefined;
    if (it.tag === key(0xfffe, 0xe0dd)) return pos + 8;
    if (it.tag !== key(0xfffe, 0xe000)) return undefined; // malformed
    if (it.length !== UNDEFINED) { pos = it.start + it.length; continue; }
    pos = it.start; // an undefined-length item: its elements up to the item delimitation
    for (;;) {
      const x = element(b, pos, implicit);
      if (!x) return undefined;
      if (x.tag === key(0xfffe, 0xe00d)) { pos = x.start; break; }
      const end = valueEnd(b, x, implicit, depth + 1);
      if (end === undefined) return undefined;
      pos = end;
    }
  }
}

const text = (v: Buffer): string => v.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');

// Walks the top-level elements in tag order up to and including `last`; calls on(tag, valueBytes) for each. Returns false when the file is not DICOM.
function walk(b: Buffer, last: number, on: (tag: number, value: Buffer) => void): boolean | 'unsupported' {
  if (b.length < 136 || b.toString('latin1', 128, 132) !== 'DICM') return false;
  let pos = 132;
  let implicit = false;
  let syntaxKnown = false;
  for (;;) {
    let e = element(b, pos, !syntaxKnown ? false : implicit);
    if (!e) return true;
    const group = Math.floor(e.tag / 0x10000);
    if (group !== 2 && !syntaxKnown) { // the meta group is over: the rest follows its transfer syntax
      syntaxKnown = true;
      if (implicit) e = element(b, pos, true);
      if (!e) return true;
    }
    if (e.tag > last) return true;
    const end = valueEnd(b, e, implicit && group !== 2);
    if (end === undefined || end > b.length) return true;
    on(e.tag, b.subarray(e.start, e.length === UNDEFINED ? end : e.start + e.length));
    if (e.tag === key(2, 0x10)) {
      const ts = text(b.subarray(e.start, end));
      if (ts === BIG_ENDIAN || ts === DEFLATED) return 'unsupported';
      implicit = ts === IMPLICIT;
    }
    pos = end;
  }
}

const dashed = (d: string): string | undefined => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : undefined);
const clock = (t: string): string | undefined => (/^\d{4}/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : undefined);

export function readHeader(file: string): DicomHeader | 'not-dicom' | 'unsupported' {
  let buf: Buffer;
  try {
    const fd = openSync(file, 'r');
    try {
      buf = Buffer.alloc(HEAD_BYTES);
      buf = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally { closeSync(fd); }
  } catch { return 'not-dicom'; }
  const raw: Partial<Record<string, string>> = {};
  let status: boolean | 'unsupported';
  try { status = walk(buf, key(0x20, 0x13), (tag, v) => { const f = FIELD[tag]; if (f) raw[f] = text(v); }); } catch { return 'not-dicom'; }
  if (status === false) return 'not-dicom';
  if (status === 'unsupported') return 'unsupported';
  if (!raw.sopClass || !raw.sopInstance) return 'not-dicom';
  const num = (s?: string) => (s && /^\s*\d+\s*$/.test(s) ? Number(s) : undefined);
  const h: DicomHeader = { sopClass: raw.sopClass, sopInstance: raw.sopInstance, transferSyntax: raw.transfer ?? '1.2.840.10008.1.2.1' };
  const set = <K extends keyof DicomHeader>(k: K, v: DicomHeader[K]) => { if (v !== undefined && v !== '') h[k] = v; };
  set('studyUid', raw.studyUid); set('seriesUid', raw.seriesUid);
  set('studyDate', dashed(raw.studyDate ?? '')); set('studyTime', clock(raw.studyTime ?? ''));
  set('modality', raw.modality); set('studyDescription', raw.studyDescription); set('seriesDescription', raw.seriesDescription);
  set('seriesNumber', num(raw.seriesNumber)); set('instanceNumber', num(raw.instanceNumber)); set('bodyPart', raw.bodyPart);
  return h;
}

// The PDF in (0042,0011) of an Encapsulated PDF object, else undefined (also for a file this reader cannot parse).
export function encapsulatedPdf(file: string): Buffer | undefined {
  let b: Buffer;
  try { b = readFileSync(file); } catch { return undefined; }
  let sop = '';
  let pdf: Buffer | undefined;
  let status: boolean | 'unsupported';
  try {
    status = walk(b, key(0x42, 0x11), (tag, v) => {
      if (tag === key(8, 0x16)) sop = text(v);
      if (tag === key(0x42, 0x11)) pdf = v;
    });
  } catch { return undefined; }
  if (status !== true || sop !== PDF_CLASS || !pdf) return undefined;
  return pdf[pdf.length - 1] === 0 ? pdf.subarray(0, pdf.length - 1) : pdf; // the odd-length pad byte
}
