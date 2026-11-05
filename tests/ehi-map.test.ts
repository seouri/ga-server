import { join } from 'node:path';
import type { Condition, DiagnosticReport, Encounter, Observation, Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { mapConditions } from '../src/ehi/conditions.ts';
import { ehiDate } from '../src/ehi/dates.ts';
import { mapEncounters } from '../src/ehi/encounters.ts';
import { type EhiCtx, PATIENT_REF } from '../src/ehi/ids.ts';
import { mapLabs } from '../src/ehi/labs.ts';
import { EhiTables } from '../src/ehi/read.ts';

const t = () => new EhiTables(join(import.meta.dirname, 'fixtures/ehi'));
const ctx: EhiCtx = { org: 'synthetic-health', date: '2026-01-17T08:30:00-05:00', epicOrgNumber: '99' };
const SYS = 'urn:ga-server:id:ehi:synthetic-health';
const of = <T extends Resource>(rs: Resource[], type: string) => rs.filter((r) => r.resourceType === type) as T[];

describe('EHI mappers', () => {
  it('ehiDate normalizes the export\'s date formats', () => {
    expect(ehiDate('1/16/2026 12:00:00 AM', ctx)).toBe('2026-01-16');
    expect(ehiDate('1/15/2026 8:05:00 AM', ctx)).toBe('2026-01-15T08:05:00-05:00');
    expect(ehiDate('12/3/2025 12:30:00 PM', ctx)).toBe('2025-12-03T12:30:00-05:00');
    expect(ehiDate('1/5/2026 12:15:00 AM', ctx)).toBe('2026-01-05T00:15:00-05:00');
    expect(ehiDate('1/5/2026 11:59:59 PM', { ...ctx, date: '2026-01-17T08:30:00Z' })).toBe('2026-01-05T23:59:59Z');
    expect(ehiDate('', ctx)).toBeUndefined();
    expect(() => ehiDate('2026-01-05', ctx)).toThrow();
  });

  it('mapLabs makes one report per order and one observation per result line', () => {
    const rs = mapLabs(t(), ctx);
    const [dr, ...more] = of<DiagnosticReport>(rs, 'DiagnosticReport');
    expect(more).toHaveLength(0);
    const obs = of<Observation>(rs, 'Observation');
    expect(obs).toHaveLength(2);
    // GA identifier first, then the order link identifier; Observations carry no link identifier (R7).
    expect(dr.identifier).toEqual([
      { system: SYS, value: 'ORDER_PROC|9000001' },
      { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.798268', value: '9000001' },
    ]);
    expect(obs.map((o) => o.identifier)).toEqual([[{ system: SYS, value: 'ORDER_RESULTS|9000001-1' }], [{ system: SYS, value: 'ORDER_RESULTS|9000001-2' }]]);
    expect(dr.result).toEqual(obs.map((o) => ({ reference: `Observation/${o.id}` })));
    expect(dr.encounter).toEqual({ reference: 'Encounter/PAT_ENC-8000001' });
    expect(dr.subject).toEqual(PATIENT_REF);
    const [ldl] = obs;
    expect(ldl).toMatchObject({
      status: 'final',
      effectiveDateTime: '2026-01-15T08:05:00-05:00', // specimen time, not the result date
      valueQuantity: { value: 111, unit: 'mg/dL' },
      referenceRange: [{ high: { value: 100, unit: 'mg/dL' } }],
      encounter: { reference: 'Encounter/PAT_ENC-8000001' },
      subject: PATIENT_REF,
    });
  });

  it('mapLabs uses LOINC when present, else code.text', () => {
    const [ldl, hdl] = of<Observation>(mapLabs(t(), ctx), 'Observation');
    // The export has LOINC long names, never codes: name kept, no code invented.
    expect(ldl.code).toEqual({ text: 'LDL CALCULATED', coding: [{ display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation' }] });
    expect(hdl.code).toEqual({ text: 'HDL' });
  });

  it('no Epic org number: no link identifiers', () => {
    const [dr] = of<DiagnosticReport>(mapLabs(t(), { ...ctx, epicOrgNumber: undefined }), 'DiagnosticReport');
    expect(dr.identifier).toEqual([{ system: SYS, value: 'ORDER_PROC|9000001' }]);
  });

  it('mapEncounters keys on the CSN and links it', () => {
    const [e] = mapEncounters(t(), ctx) as Encounter[];
    expect(e).toMatchObject({
      id: 'PAT_ENC-8000001',
      identifier: [
        { system: SYS, value: 'PAT_ENC|8000001' },
        { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.3.698084.8', value: '8000001' },
      ],
      period: { start: '2026-01-15' },
      subject: PATIENT_REF,
    });
  });

  it('mapConditions sets category and resolved status', () => {
    const cs = mapConditions(t(), ctx) as Condition[];
    const cat = (c: Condition) => c.category?.[0]?.coding?.[0]?.code;
    const status = (c: Condition) => c.clinicalStatus?.coding?.[0]?.code;
    const dx = cs.filter((c) => cat(c) === 'encounter-diagnosis');
    const pl = cs.filter((c) => cat(c) === 'problem-list-item');
    expect(dx).toHaveLength(1);
    expect(dx[0].identifier).toEqual([{ system: SYS, value: 'PAT_ENC_DX|8000001-1' }]);
    expect(dx[0].encounter).toEqual({ reference: 'Encounter/PAT_ENC-8000001' });
    expect(dx[0].code).toEqual({ text: 'Test problem' }); // named via DX_LINK_PROB_ID
    expect(pl.map((c) => [c.code?.text, status(c), c.abatementDateTime])).toEqual([
      ['Test problem', 'active', undefined],
      ['Test resolved problem', 'resolved', '2021-06-01'],
    ]);
    expect(pl[1].identifier).toEqual([
      { system: SYS, value: 'PROBLEM_LIST|6000002' },
      { system: 'urn:oid:1.2.840.114350.1.13.99.2.7.2.768076', value: '6000002' },
    ]);
    expect(pl[1].onsetDateTime).toBe('2020-03-02');
  });
});
