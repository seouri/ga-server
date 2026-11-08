import type { DocumentReference } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const section = (templates: string[], code: string, title: string, narrative: string, entry: string) =>
  `<component><section>${templates.map((t) => `<templateId root="${t}"/>`).join('')}<code code="${code}" codeSystem="2.16.840.1.113883.6.1"/>
  <title>${title}</title><text>${narrative}</text><entry>${entry}</entry></section></component>`;
const noteAct = (id: string, ref: string) => `<act classCode="ACT" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.202" extension="2016-11-01"/><id root="2.16.840.1.113883.19.5" extension="${id}"/>
  <code code="34109-9" codeSystem="2.16.840.1.113883.6.1" displayName="Note"><translation code="11506-3" codeSystem="2.16.840.1.113883.6.1" displayName="Progress note"/></code>
  <text><reference value="#${ref}"/></text><statusCode code="completed"/><effectiveTime value="20240210"/></act>`;
const text = (d: DocumentReference) => (d.content[0].attachment.data ? Buffer.from(d.content[0].attachment.data, 'base64').toString('utf8') : undefined);

test('Instructions, History of Present Illness and Notes (progress notes) entries become text DocumentReferences', () => {
  const bundle = convertSections(
    section(['2.16.840.1.113883.10.20.22.2.45', '2.16.840.1.113883.10.20.22.2.45'], '69730-0', 'Patient Instructions', '<paragraph ID="i1">Drink plenty of fluids.</paragraph>',
      `<act classCode="ACT" moodCode="INT"><templateId root="2.16.840.1.113883.10.20.22.4.20"/><id root="2.16.840.1.113883.19.5" extension="INSTR-1"/>
       <code code="311401005" codeSystem="2.16.840.1.113883.6.96" displayName="Patient education"/><text><reference value="#i1"/></text><statusCode code="completed"/></act>`) +
    section(['1.3.6.1.4.1.19376.1.5.3.1.3.4'], '10164-2', 'History of Present Illness', '<paragraph ID="h1">Three days of nasal congestion.</paragraph>', noteAct('HPI-1', 'h1')) +
    section(['2.16.840.1.113883.10.20.22.2.65', '2.16.840.1.113883.10.20.22.2.65'], '11506-3', 'Progress Notes', '<paragraph ID="n1">Seen today, improving.</paragraph>', noteAct('NOTE-1', 'n1'))
  );
  const docs = resourcesOf<DocumentReference>(bundle, 'DocumentReference');
  expect(docs.map((d) => [d.identifier?.[0].value, d.category?.[0].coding?.[0].code, d.content[0].attachment.title, text(d)])).toEqual([
    ['INSTR-1', '69730-0', 'Patient Instructions', 'Drink plenty of fluids.'],
    ['HPI-1', '10164-2', 'History of Present Illness', 'Three days of nasal congestion.'],
    ['NOTE-1', '11506-3', 'Progress Notes', 'Seen today, improving.'],
  ]);
  expect(docs[1].type?.coding?.map((c) => c.code)).toEqual(['34109-9', '11506-3']);
  expect(docs[1].context?.period?.start).toBe('2024-02-10');
  expect(docs.every((d) => d.status === 'current' && d.subject?.reference && d.content[0].attachment.contentType === 'text/plain')).toBe(true);
});

test('a Note Activity in any other section becomes a DocumentReference', () => {
  const bundle = convertSections(section(['2.16.840.1.113883.10.20.22.2.3.1'], '30954-2', 'Results', '<paragraph ID="r1">Result comment.</paragraph>', noteAct('NOTE-2', 'r1')));
  expect(resourcesOf<DocumentReference>(bundle, 'DocumentReference').map(text)).toEqual(['Result comment.']);
});
