// PDF export of a share's summary, using pdfmake's bundled Roboto fonts: no network, no local files.
import { createRequire } from 'node:module';
import type { Content } from 'pdfmake';
import type { Item, Row, Summary } from './summary.ts';

export { recordRows, summarize, toBundle } from './summary.ts';

const require = createRequire(import.meta.url);
const pdfmake = require('pdfmake');
const vfs = require('pdfmake/build/vfs_fonts.js');
for (const [name, b64] of Object.entries(vfs as Record<string, string>)) pdfmake.virtualfs.writeFileSync(name, Buffer.from(b64, 'base64'));
pdfmake.setFonts({ Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' } });
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => false);

const ROW_CAP = 200; // shortcut: the PDF lists at most 200 rows per group, the FHIR file has everything.

const table = (items: Item[]): Content =>
  items.length
    ? { table: { widths: ['*', 'auto', 'auto'], body: items.map((i) => [
        { text: [{ text: i.label }, ...(i.note ? [{ text: `  (${i.note})`, italics: true }] : [])] },
        { text: i.value ?? '' },
        { text: i.date ?? '' },
      ]) }, layout: 'lightHorizontalLines', fontSize: 9 }
    : { text: 'None recorded.', italics: true, fontSize: 9 };

export async function toPdf(summary: Summary, rows: Row[], cover: { label: string; created: string; scope: string }): Promise<Buffer> {
  const sections: [string, Item[]][] = [
    ['Problems', summary.problems], ['Medications', summary.medications], ['Allergies', summary.allergies],
    ['Latest labs', summary.labs], ['Latest vitals', summary.vitals], ['Immunizations', summary.immunizations],
    ['Apple Health (one line per type)', summary.apple],
  ];
  const content: Content[] = [
    { text: cover.label, style: 'h1' },
    { text: `${summary.patient.name}  ${summary.patient.birthDate ?? ''}  ${summary.patient.gender ?? ''}`.trim() },
    { text: `Created ${cover.created}. Shared: ${cover.scope}`, fontSize: 9, margin: [0, 0, 0, 8] },
    ...sections.flatMap(([t, items]): Content[] => [{ text: t, style: 'h2' }, table(items)]),
    { text: 'All records', style: 'h1', pageBreak: 'before' },
    ...rows.flatMap((r): Content[] => [
      { text: r.group, style: 'h2' },
      table(r.items.slice(0, ROW_CAP)),
      ...(r.items.length > ROW_CAP ? [{ text: `and ${r.items.length - ROW_CAP} more: see the FHIR file`, italics: true, fontSize: 9 }] : []),
    ]),
  ];
  const def = { content, defaultStyle: { font: 'Roboto', fontSize: 10 }, styles: { h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 6] }, h2: { fontSize: 12, bold: true, margin: [0, 10, 0, 4] } } };
  return pdfmake.createPdf(def).getBuffer();
}
