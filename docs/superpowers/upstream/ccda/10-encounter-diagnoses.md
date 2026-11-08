# 10. Encounter Diagnosis acts → Conditions linked to their Encounter

No existing issue or PR. Builds on draft 9 (`processConditionAct` returns one Condition per SUBJ observation). Nothing filed.

## Issue: @medplum/ccda: visit diagnoses (Encounter Diagnosis act, 2.16.840.1.113883.10.20.22.4.80) are dropped

`processEncounter` reads only `entryRelationship[@typeCode='RSON']/observation` as diagnoses. C-CDA records a visit's diagnoses as an Encounter Diagnosis act (`22.4.80`, V2 `22.4.80.2`) wrapping one or more Problem Observations (`22.4.4`). The IG links that act with `typeCode="REFR"`, and Epic uses `typeCode="SUBJ"`. Either way the act is skipped, so every visit diagnosis in an Epic document is lost. In one real Epic export that was 106 of 138 Conditions.

Reproduction (synthetic):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <text>Office visit</text>
  <entry>
    <encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="2.16.840.1.113883.19.5" extension="ENC-1"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <effectiveTime><low value="20240210093000-0500"/></effectiveTime>
      <entryRelationship typeCode="SUBJ">
        <act classCode="ACT" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.80" extension="2015-08-01"/>
          <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
          <statusCode code="completed"/>
          <entryRelationship typeCode="SUBJ">
            <observation classCode="OBS" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
              <id root="2.16.840.1.113883.19.5" extension="VISITDX-1"/>
              <code code="282291009" codeSystem="2.16.840.1.113883.6.96" displayName="Diagnosis"/>
              <statusCode code="completed"/>
              <effectiveTime><low value="20240210"/></effectiveTime>
              <value xsi:type="CD" code="36971009" codeSystem="2.16.840.1.113883.6.96"/>
            </observation>
          </entryRelationship>
        </act>
      </entryRelationship>
      <entryRelationship typeCode="REFR">
        <act classCode="ACT" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.80" extension="2015-08-01"/>
          <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
          <statusCode code="completed"/>
          <entryRelationship typeCode="SUBJ">
            <observation classCode="OBS" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
              <id root="2.16.840.1.113883.19.5" extension="VISITDX-2"/>
              <code code="282291009" codeSystem="2.16.840.1.113883.6.96" displayName="Diagnosis"/>
              <statusCode code="completed"/>
              <effectiveTime><low value="20240210"/></effectiveTime>
              <value xsi:type="CD" code="195662009" codeSystem="2.16.840.1.113883.6.96"/>
            </observation>
          </entryRelationship>
        </act>
      </entryRelationship>
    </encounter>
  </entry>
</section>
```

Expected FHIR (today: an Encounter and no Condition):

```json
[
  {
    "resourceType": "Condition",
    "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "VISITDX-1" }],
    "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/condition-category", "code": "encounter-diagnosis", "display": "Encounter Diagnosis" }] }],
    "code": { "coding": [{ "system": "http://snomed.info/sct", "code": "36971009" }] },
    "onsetDateTime": "2024-02-10",
    "encounter": { "reference": "Encounter/<the encounter's id>" }
  },
  {
    "resourceType": "Condition",
    "identifier": [{ "system": "urn:oid:2.16.840.1.113883.19.5", "value": "VISITDX-2" }],
    "category": [{ "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/condition-category", "code": "encounter-diagnosis", "display": "Encounter Diagnosis" }] }],
    "code": { "coding": [{ "system": "http://snomed.info/sct", "code": "195662009" }] },
    "onsetDateTime": "2024-02-10",
    "encounter": { "reference": "Encounter/<the encounter's id>" }
  }
]
```

## PR: feat(ccda): convert Encounter Diagnosis acts to Conditions

- `processEncounter`: for each `entryRelationship` act that has an Encounter Diagnosis template, whatever its typeCode, `processConditionAct(act, ENCOUNTER_DIAGNOSIS)` returns one Condition per SUBJ problem observation. That is the same builder as the Problems section (onset, abatement, recorder, text reference, US Core profile). The only differences are category `encounter-diagnosis` and `encounter` set to the Encounter.
- The link runs from Condition to Encounter, which is the US Core direction. The Encounter is left unchanged. A two-way link would make a reference cycle for consumers that write resources in dependency order.
- `processConditionAct` gains a category parameter, `problem-list-item` by default.
- The existing RSON path is unchanged.
- Test: `encounter-diagnoses.test.ts`.
