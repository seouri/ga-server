// Writes the synthetic DICOM files next to this script: `node tests/fixtures/dicom/make.ts`. Nothing here is real patient data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = import.meta.dirname;
const LONG = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'OD', 'OL', 'UC', 'UR', 'OV', 'SV', 'UV']);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const tag = (g: number, e: number) => Buffer.concat([u16(g), u16(e)]);
const even = (v: Buffer, pad: number) => (v.length % 2 ? Buffer.concat([v, Buffer.from([pad])]) : v);
const str = (s: string) => even(Buffer.from(s, 'latin1'), /^\d+(\.\d+)+$/.test(s) ? 0 : 0x20);

function el(g: number, e: number, vr: string, value: Buffer, implicit = false): Buffer {
  if (implicit) return Buffer.concat([tag(g, e), u32(value.length), value]);
  return LONG.has(vr)
    ? Buffer.concat([tag(g, e), Buffer.from(vr), u16(0), u32(value.length), value])
    : Buffer.concat([tag(g, e), Buffer.from(vr), u16(value.length), value]);
}

type Opts = { implicit?: boolean; transfer?: string; sop?: string; instance: string; series: string; seriesNumber?: number; number: number; modality: string; pre?: (impl: boolean) => Buffer; extra?: Buffer };

function file(o: Opts): Buffer {
  const impl = !!o.implicit;
  const ts = o.transfer ?? (impl ? '1.2.840.10008.1.2' : '1.2.840.10008.1.2.1');
  const sop = o.sop ?? '1.2.840.10008.5.1.4.1.1.2';
  const meta = [el(2, 0x10, 'UI', str(ts))];
  const metaBytes = Buffer.concat([el(2, 0, 'UL', u32(Buffer.concat(meta).length)), ...meta]);
  const d = (g: number, e: number, vr: string, s: string) => el(g, e, vr, str(s), impl);
  const body = Buffer.concat([
    d(8, 0x16, 'UI', sop), d(8, 0x18, 'UI', o.instance), d(8, 0x20, 'DA', '20240115'), d(8, 0x30, 'TM', '093000'),
    d(8, 0x60, 'CS', o.modality), d(8, 0x1030, 'LO', 'CT CHEST'), ...(o.pre ? [o.pre(impl)] : []), d(8, 0x103e, 'LO', 'AXIAL'),
    d(0x18, 0x15, 'CS', 'CHEST'), d(0x20, 0x0d, 'UI', '1.2.3'), d(0x20, 0x0e, 'UI', o.series),
    d(0x20, 0x11, 'IS', String(o.seriesNumber ?? 2)), d(0x20, 0x13, 'IS', String(o.number)),
    o.extra ?? el(0x7fe0, 0x10, 'OW', Buffer.from([1, 2, 3, 4]), impl),
  ]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), metaBytes, body]);
}

// An undefined-length sequence holding an undefined-length item (with a nested undefined-length sequence), as real files do.
const seqBefore = (): Buffer => {
  const inner = Buffer.concat([tag(0x8, 0x100), Buffer.from('SH'), u16(2), Buffer.from('X ')]);
  const nested = Buffer.concat([tag(0x40, 0xa730), Buffer.from('SQ'), u16(0), u32(0xffffffff), tag(0xfffe, 0xe000), u32(0xffffffff), inner, tag(0xfffe, 0xe00d), u32(0), tag(0xfffe, 0xe0dd), u32(0)]);
  return Buffer.concat([tag(0x8, 0x1032), Buffer.from('SQ'), u16(0), u32(0xffffffff), tag(0xfffe, 0xe000), u32(0xffffffff), inner, nested, tag(0xfffe, 0xe00d), u32(0), tag(0xfffe, 0xe0dd), u32(0)]);
};

const put = (name: string, b: Buffer) => { mkdirSync(join(OUT, name, '..'), { recursive: true }); writeFileSync(join(OUT, name), b); };

put('ct/1', file({ instance: '1.2.3.4.1', series: '1.2.3.4', number: 1, modality: 'CT' }));
put('ct/2', file({ instance: '1.2.3.4.2', series: '1.2.3.4', number: 2, modality: 'CT' }));
put('implicit/1', file({ implicit: true, instance: '1.2.3.5.1', series: '1.2.3.5', seriesNumber: 3, number: 1, modality: 'MR' }));
put('seq/1', file({ instance: '1.2.3.9.1', series: '1.2.3.9', seriesNumber: 4, number: 1, modality: 'CT', pre: seqBefore }));
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
put('pdf/1', file({ sop: '1.2.840.10008.5.1.4.1.1.104.1', instance: '1.2.3.8.1', series: '1.2.3.8', seriesNumber: 5, number: 1, modality: 'DOC', extra: el(0x42, 0x11, 'OB', even(pdf, 0)) }));
put('big/1', file({ transfer: '1.2.840.10008.1.2.2', instance: '1.2.3.7.1', series: '1.2.3.7', number: 1, modality: 'CT' }));
put('Preview.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
