# 19. Family History organizers → FamilyMemberHistory (existing PR, applied with one GA change)

Nothing new to file. GA carries the open external PR **medplum#11243** ("fix(ccda): map Family History organizers to FamilyMemberHistory", fixes #11200), head commit 6af85aab, as row 19 of `vendor/medplum-ccda/PATCHES.md`. Drop the row when a Medplum release contains it, after checking the routing point below.

What it changes: every organizer outside the Care Teams section went through `processVitalsOrganizer`, so a Family History Organizer became the patient's own Observations ("Disease" = Hypertension, "Age at onset" 60 a, and an uncoded organizer Observation), with the relationship lost. Now a Family History Organizer (`2.16.840.1.113883.10.20.22.4.45`) becomes one `FamilyMemberHistory`: relationship, sex, one `condition` per Family History Observation with `onsetAge` and `contributedToDeath`; a negated observation gives no condition.

Reproduction (synthetic, the PR's own):

```xml
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.15" extension="2015-08-01"/>
  <code code="10157-6" codeSystem="2.16.840.1.113883.6.1" displayName="History of family member diseases"/>
  <title>Family History</title>
  <text>Father: Hypertension, onset at age 60.</text>
  <entry typeCode="DRIV">
    <organizer moodCode="EVN" classCode="CLUSTER">
      <templateId root="2.16.840.1.113883.10.20.22.4.45" extension="2015-08-01"/>
      <id root="2.16.840.1.113883.19.5" extension="FH-1"/>
      <statusCode code="completed"/>
      <subject>
        <relatedSubject classCode="PRS">
          <code code="FTH" codeSystem="2.16.840.1.113883.5.111" displayName="father"/>
          <subject><administrativeGenderCode code="M" codeSystem="2.16.840.1.113883.5.1"/></subject>
        </relatedSubject>
      </subject>
      <component>
        <observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.46" extension="2015-08-01"/>
          <id root="2.16.840.1.113883.19.5" extension="FH-1-1"/>
          <code code="64572001" codeSystem="2.16.840.1.113883.6.96" displayName="Disease"/>
          <statusCode code="completed"/>
          <value xsi:type="CD" code="38341003" codeSystem="2.16.840.1.113883.6.96" displayName="Hypertension"/>
          <entryRelationship typeCode="SUBJ" inversionInd="true">
            <observation classCode="OBS" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.22.4.31"/>
              <code code="445518008" codeSystem="2.16.840.1.113883.6.96" displayName="Age at onset of clinical finding"/>
              <statusCode code="completed"/>
              <value xsi:type="PQ" value="60" unit="a"/>
            </observation>
          </entryRelationship>
        </observation>
      </component>
    </organizer>
  </entry>
</section>
```

Expected: one `FamilyMemberHistory` of the patient, `relationship` `v3-RoleCode#FTH`, `sex` male, one `condition` SNOMED 38341003 with `onsetAge` 60 a.

How GA applied it, and the one change:

- **By hand.** Rows 1 and 4 changed `processOrganizer` (section templates via `getTemplateIds`), so the hunk does not apply as-is. The family history builder (`processFamilyHistoryOrganizer`, `processFamilyHistoryObservation`) and the `CcdaOrganizer.subject` types are the PR's, unchanged.
- **Routing of other organizers.** The PR keeps only Vital Signs, Result and Functional Status organizers (root templates) and skips (or, without `ignoreUnsupportedSections`, throws on) any other. GA keeps today's fallback instead: any other organizer stays a panel Observation. Skipping would drop a Cognitive Status Result Organizer's results, the V2 Vital Signs organizer (`...4.26.2`) and the V2 Result Organizer (`...4.1.2`), and any vendor organizer, with all their results. Worth raising in the PR review: keep the fallback, or list the V2 and cognitive status roots.
- **GA additions on top of the PR** (worth proposing in its review): `bornDate` from the relative's `birthTime` (the Microsoft path keeps it as `bornString`); `deceasedDate` from `sdtc:deceasedTime`, else `deceasedBoolean` from `sdtc:deceasedInd`; and a condition's `onsetPeriod` from the Family History Observation's own effectiveTime when it has no Age Observation (FamilyMemberHistory.condition.onset[x] has no dateTime, and holds one value, so the age wins). Tests in `describe('family member details')`.
- **Test.** `test/family-history.test.ts` ported to vitest; its "skips an unknown organizer" case is replaced by "keeps an organizer of another template as Observations".
- **GA accounting** (`src/ccda.ts`) names a negated or uncoded family history observation, and a related observation other than age at onset or death, in `notImported`.

The Microsoft path produced a FamilyMemberHistory from the same section (checked with the local converter on the synthetic fragment above). On the owner's 8 documents the spike listed no FamilyMemberHistory on either path, so this may not occur there.
