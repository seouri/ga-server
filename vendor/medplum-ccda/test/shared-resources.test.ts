import type { AllergyIntolerance, Encounter, Location, Organization, Practitioner, PractitionerRole } from '@medplum/fhirtypes';
import { expect, test } from 'vitest';
import { convertSections, resourcesOf } from './convert-sections.ts';

const author = (extra = '') => `<author><time value="20240210"/><assignedAuthor><id root="2.16.840.1.113883.4.6" extension="1111111111"/>
  <assignedPerson><name><given>Example</given><family>Author</family></name></assignedPerson>${extra}</assignedAuthor></author>`;
const allergy = (id: string, authorXml: string) => `<entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.30"/>
  <id root="2.16.840.1.113883.19.5" extension="${id}"/><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>${authorXml}
  <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.7"/>
    <id root="2.16.840.1.113883.19.5" extension="${id}-OBS"/><code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/>
    <value xsi:type="CD" code="416098002" codeSystem="2.16.840.1.113883.6.96"/></observation></entryRelationship></act></entry>`;
const location = `<participant typeCode="LOC"><participantRole classCode="SDLOC"><id root="2.16.840.1.113883.19.5.9" extension="DEPT-1"/>
  <playingEntity classCode="PLC"><name>Example Clinic</name></playingEntity></participantRole></participant>`;
const encounter = (id: string) => `<entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/>
  <id root="2.16.840.1.113883.19.5" extension="${id}"/><effectiveTime value="20240210"/>${location}
  <performer><assignedEntity><id root="2.16.840.1.113883.4.6" extension="2222222222"/></assignedEntity></performer></encounter></entry>`;

test('one Practitioner, Organization and Location per identifier: the first keeps what later copies add; references point at it', () => {
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
      <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/><title>Allergies</title><text>x</text>
      ${allergy('A1', author())}${allergy('A2', author('<telecom use="WP" value="tel:+1-555-555-0101"/>'))}
    </section></component>
    <component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>${encounter('E1')}${encounter('E2')}
    </section></component>`);
  const practitioners = resourcesOf<Practitioner>(bundle, 'Practitioner');
  const author1 = practitioners.filter((p) => p.identifier?.[0].value === '1111111111');
  expect(author1).toHaveLength(1);
  expect(author1[0].telecom?.[0].system).toBe('phone'); // the second copy's telecom is kept
  const allergies = resourcesOf<AllergyIntolerance>(bundle, 'AllergyIntolerance');
  expect(allergies.map((a) => a.recorder?.reference)).toEqual([`Practitioner/${author1[0].id}`, `Practitioner/${author1[0].id}`]);
  expect(practitioners.filter((p) => p.identifier?.[0].value === '2222222222')).toHaveLength(1);
  const [loc, ...more] = resourcesOf<Location>(bundle, 'Location');
  expect(more).toEqual([]);
  const encounters = resourcesOf<Encounter>(bundle, 'Encounter');
  expect(encounters.map((e) => e.location?.[0].location.reference)).toEqual([`Location/${loc.id}`, `Location/${loc.id}`]);
  // A performer with no organization has none (no empty Organization); the two encounters share one role.
  expect(resourcesOf<Organization>(bundle, 'Organization')).toEqual([]);
  const roles = resourcesOf<PractitionerRole>(bundle, 'PractitionerRole');
  expect(roles).toHaveLength(1);
  expect(roles[0].organization).toBeUndefined();
  expect(encounters.map((e) => e.participant?.[0].individual?.reference)).toEqual([`PractitionerRole/${roles[0].id}`, `PractitionerRole/${roles[0].id}`]);
});

test('copies sharing an identifier: array fields are unioned (equal elements once); a single-valued field keeps the first copy\'s', () => {
  const tel = (v: string) => `<telecom use="WP" value="tel:${v}"/>`;
  const org = (name: string) => `<representedOrganization><id root="2.16.840.1.113883.19.5" extension="ORG-9"/><name>${name}</name></representedOrganization>`;
  const bundle = convertSections(`<component><section><templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
      <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/><title>Allergies</title><text>x</text>
      ${allergy('A1', author(tel('+1-555-555-0101')))}${allergy('A2', author(tel('+1-555-555-0102') + tel('+1-555-555-0101')))}
    </section></component>
    <component><section><templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/><title>Encounters</title><text>x</text>
      <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="2.16.840.1.113883.19.5" extension="E1"/>
        <performer><assignedEntity><id root="2.16.840.1.113883.4.6" extension="3333333333"/>${org('First Name')}</assignedEntity></performer></encounter></entry>
      <entry><encounter classCode="ENC" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.22.4.49"/><id root="2.16.840.1.113883.19.5" extension="E2"/>
        <performer><assignedEntity><id root="2.16.840.1.113883.4.6" extension="3333333333"/>${org('Second Name')}</assignedEntity></performer></encounter></entry>
    </section></component>`);
  const [p] = resourcesOf<Practitioner>(bundle, 'Practitioner').filter((x) => x.identifier?.[0].value === '1111111111');
  expect(p.telecom?.map((t) => t.value)).toEqual(['+1-555-555-0101', '+1-555-555-0102']);
  const orgs = resourcesOf<Organization>(bundle, 'Organization');
  expect(orgs.map((o) => o.name)).toEqual(['First Name']);
});
