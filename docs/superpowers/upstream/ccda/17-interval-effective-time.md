# 17. Interval effectiveTime on observations and organizers (existing PR)

Nothing new to file. GA carries the open external PR **medplum#11244** ("fix(ccda): map interval effectiveTime on observations and organizers", fixes #11203) unchanged, applied from its head commit f6b042b9. Drop row 17 of `vendor/medplum-ccda/PATCHES.md` when a Medplum release contains it.

What it changes: `processVitalsObservation` and `processVitalsOrganizer` read only `effectiveTime/@value`. An interval was dropped and the Observation had no date. One helper, `mapObservationEffectiveTime`, now maps:

- `@value` → `effectiveDateTime` (unchanged);
- `low` only, or `low` equal to `high` → `effectiveDateTime` from `low`;
- `low` and a different `high` → `effectivePeriod { start, end }`;
- `high` only → `effectivePeriod { end }`;
- a nullFlavor (element, `low` or `high`) → nothing.

Reproduction (synthetic, the PR's own):

```xml
<organizer classCode="BATTERY" moodCode="EVN">
  <templateId root="2.16.840.1.113883.10.20.22.4.1" extension="2015-08-01"/>
  <code code="58410-2" codeSystem="2.16.840.1.113883.6.1" displayName="CBC panel - Blood by Automated count"/>
  <effectiveTime>
    <low value="20260101150700+0000"/>
    <high value="20260101150700+0000"/>
  </effectiveTime>
  <component>
    <observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
      <code code="718-7" codeSystem="2.16.840.1.113883.6.1" displayName="Hemoglobin [Mass/volume] in Blood"/>
      <effectiveTime>
        <low value="20260101150700+0000"/>
        <high value="20260101163000+0000"/>
      </effectiveTime>
      <value xsi:type="PQ" value="13.5" unit="g/dL"/>
    </observation>
  </component>
</organizer>
```

Expected: Hemoglobin `"effectivePeriod": { "start": "2026-01-01T15:07:00Z", "end": "2026-01-01T16:30:00Z" }`; CBC panel `"effectiveDateTime": "2026-01-01T15:07:00Z"`.

Why GA needs it: Epic writes every Result Organizer's time as `<low>`/`<high>` and many Social History observations as `<low>` only. On the owner's documents the spike found 43 of 44 lab panels with no date, and 17 social-history and 3 lab results it could only find on the Microsoft path. The spike matched records on the same day and code, so a record with no date counted as missing: these are the likely cause.

How GA applied it: `git apply -p4 --directory=vendor/medplum-ccda` of the PR diff (offsets only). The PR's test is `test/observation-effective-time.test.ts`, ported to vitest. GA row 19 (Result Organizer → DiagnosticReport) reuses the same helper for the report's `effective[x]`.

If the PR changes in review, re-apply its final diff and rerun `npx vitest run vendor`.
