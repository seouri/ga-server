import { expect, test } from 'vitest';
import type { Observation } from '@medplum/fhirtypes';
import { fill, toPanels } from '../.claude/skills/ga-lipids/build.ts';

const obs = (d: string, code: string | null, value: number, extra: Partial<Observation> = {}): Observation => ({
  resourceType: 'Observation', status: 'final', effectiveDateTime: d,
  code: code ? { coding: [{ system: 'http://loinc.org', code }] } : { text: 'LDL cholesterol' },
  valueQuantity: { value, unit: 'mg/dL' }, meta: { source: '/x/y/doc.xml' }, ...extra,
});

test('groups by day, prefers direct LDL, keeps missing tests null', () => {
  const { panels } = toPanels([
    obs('2024-01-01T08:00:00Z', '13457-7', 150),
    obs('2024-01-01T09:00:00Z', '18262-6', 160),
    obs('2024-01-01', '2093-3', 240),
    obs('2025-01-01', '2085-9', 60),
  ]);
  expect(panels).toHaveLength(2);
  expect(panels[0]).toMatchObject({ d: '2024-01-01', ldl: 160, ldlKind: 'direct', tc: 240, hdl: null, tg: null, src: 'doc.xml' });
  expect(panels[1]).toMatchObject({ d: '2025-01-01', hdl: 60, ldl: null });
});

test('text-only LDL is used only when no coded LDL exists, and flags AI extraction', () => {
  const llm = { meta: { source: '/a/report.pdf', tag: [{ system: 'urn:ga-server:tag', code: 'extracted-by-llm' }] } };
  const { panels } = toPanels([obs('2024-07-26', null, 186, llm), obs('2026-11-03', '13457-7', 189), obs('2026-11-03', null, 999)]);
  expect(panels[0]).toMatchObject({ ldl: 186, ldlKind: 'text', llm: true, src: 'report.pdf' });
  expect(panels[1]).toMatchObject({ ldl: 189, ldlKind: 'calculated', llm: false });
});

test('non-mg/dL results are skipped and counted, not charted', () => {
  const { panels, otherUnits } = toPanels([obs('2024-01-01', '2093-3', 6.2, { valueQuantity: { value: 6.2, unit: 'mmol/L', code: 'mmol/L' } })]);
  expect(panels).toHaveLength(0);
  expect(otherUnits).toBe(1);
});

test('fill escapes < so data cannot close the script tag', () => {
  const tpl = '<script id="ga-data" type="application/json">{}</script>';
  const out = fill(tpl, { panels: [{ src: '</script><b>x' }] });
  expect(out).not.toContain('</script><b>');
  expect(JSON.parse(out.slice(tpl.indexOf('>') + 1, out.lastIndexOf('</script>')))).toEqual({ panels: [{ src: '</script><b>x' }] });
  expect(() => fill('<html></html>', {})).toThrow('ga-data');
});
