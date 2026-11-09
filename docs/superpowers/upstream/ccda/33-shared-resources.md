# 33. One Practitioner, Organization and Location per identifier

> Post only the 'Issue' and 'PR' sections; everything else is GA-internal and never posted.

No existing issue or PR. Builds on draft 32 (Location). Nothing filed.

## Issue: @medplum/ccda: a practitioner is emitted once per occurrence

`mapAuthorToReference` and `mapAssignedEntityToReference` create a new Practitioner (and Organization, PractitionerRole) every time an author or performer appears, each with a fresh generated id, even when the C-CDA id is the same. A typical Epic summary repeats the same clinician on dozens of entries, so a bundle holds dozens of copies of one person; when the copies differ (one occurrence carries a phone number) a server or importer keyed by identifier sees conflicting records. A performer with no `representedOrganization` also produces an empty `{ resourceType: 'Organization', id }`.

Reproduction (synthetic): two allergy concern acts whose `author/assignedAuthor` share `<id root="2.16.840.1.113883.4.6" extension="1111111111"/>`, the second with `<telecom use="WP" value="tel:+1-555-555-0101"/>`; two encounters with the same Service Delivery Location id and the same performer (no organization).

Expected: one Practitioner `1111111111` (with the telecom), both AllergyIntolerance `recorder`s pointing at it; one Location; one PractitionerRole without `organization`; no Organization. Actual: two Practitioners, two Locations, two PractitionerRoles, two empty Organizations.

## PR: fix(ccda): merge practitioners, organizations and locations by identifier

- `ccda-to-fhir.ts`: `mergeSharedResources(composition)` after conversion: per identifier the first resource is kept and filled with fields only later copies have, and array fields take every distinct element of every copy (a single-valued field both hold differently keeps the first); then PractitionerRoles by practitioner + organization; references repointed across the bundle. `mapAssignedEntityToReference` creates an Organization only for a `representedOrganization`.
- Test `shared-resources.test.ts`.
- Not merged: resources with no identifier (nothing says two nameless copies are one).

# GA-internal (do not post)

## Filing metadata

- PATCHES rows: 33 (`vendor/medplum-ccda/PATCHES.md`)
- Vendored commit(s): 596c79e, 1d7ec27 (`git log --oneline -- vendor/medplum-ccda`)
- Existing external work: none
- Depends on / builds on: drafts 32
- Status: issue-first. Nothing filed (the README has the approval process).
