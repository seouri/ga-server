# Registering GA with Epic

Do this once, before connecting any hospital (see [Hospital portals](../README.md#hospital-portals-smart) in the README). It creates GA's signing key, publishes its public half, and registers GA as a patient app on Epic's developer site.

**a. Make GA's key and publish its public half.** Epic's form takes only *JWK Set URLs*, one for non-production and a different one for production, so the public key must sit at two public HTTPS addresses. It is a public key, never health data; one public GitHub Gist holding the same key under two file names works:

```sh
ga keys                                                          # creates .ga/smart/ key (mode 0600), prints the public JWKS
cp .ga/smart/public.jwks.json .ga/smart/non-production.jwks.json   # same public key,
cp .ga/smart/public.jwks.json .ga/smart/production.jwks.json       # one name per Epic environment
gh gist create --public -d "GA public key" .ga/smart/non-production.jwks.json .ga/smart/production.jwks.json
```

No `gh`? Either install it and sign in once (`brew install gh && gh auth login`, see https://cli.github.com), or skip it: run `cat .ga/smart/public.jwks.json | pbcopy`, open https://gist.github.com, paste into the file box and name it `non-production.jwks.json`; choose **Add file**, paste again and name it `production.jwks.json`; then choose **Create public gist**.

The gist's page is `https://gist.github.com/<user>/<gist id>` (`gh` prints it). Your two JWK Set URLs are then:

```text
https://gist.githubusercontent.com/<user>/<gist id>/raw/non-production.jwks.json
https://gist.githubusercontent.com/<user>/<gist id>/raw/production.jwks.json
```

Check them: `curl -s <URL>` prints the same JSON as `ga keys` for both. `ga keys` never replaces an existing key, so the URLs stay valid.

**b. Create the app.** Sign in at https://fhir.epic.com, choose **Build Apps**, then **Create**, and fill the form:

| Field | Value |
|---|---|
| Application Name | `GA` |
| Application Audience | **Patients** |
| Automatic Client Distribution | **USCDI v3** (Epic offers the app to every Epic organization on its own; with **None** each hospital must enable it by hand) |
| Public Documentation URL | leave empty |
| Incoming APIs | see below |
| Endpoint URI | `http` + `localhost:8765/callback` (sandbox), then **Add Another URI**: `https` + `<machine>.<tailnet>.ts.net/callback` (production; see [https callback](#https-callback)) |
| Can Register Dynamic Clients | off |
| Is Confidential Client | **on** |
| Requires Persistent Access | **on** |
| Uses Rolling Refresh Tokens | **on** (GA saves each new refresh token) |
| Can Have Indefinite Access | leave as is (greyed out for new apps; access then lasts as long as the duration you pick at the MyChart login, so pick the longest) |
| Non-Production JWK Set URL | `https` + `gist.githubusercontent.com/<user>/<gist id>/raw/non-production.jwks.json` |
| Production JWK Set URL | `https` + `gist.githubusercontent.com/<user>/<gist id>/raw/production.jwks.json` (Epic requires a different URL from non-production) |
| Sandbox Client Secret | leave empty (GA signs with its key instead of a secret) |

**Incoming APIs.** Select only **R4** APIs whose name has `.Read` or `.Search`; never `.Create`, `.Update`, `(Premium Billing)`, `(DSTU2)` or `(STU3)`. Type each name below into **Search available service list** and move every matching `.Read (R4)` and `.Search (… ) (R4)` entry to **Selected** with `>>`:

```text
AllergyIntolerance
Binary
CarePlan
CareTeam
Condition
Device
DiagnosticReport
DocumentReference
Encounter
Goal
Immunization
Location
Medication
MedicationRequest
Observation
Organization
Patient
Practitioner
PractitionerRole
Procedure
Provenance
ServiceRequest
```

GA asks each hospital which of these it supports and fetches only those, so extra ones are harmless and missing ones are just skipped.

**c. Save.** Epic then shows the **Client ID** (production) and the **Non-Production Client ID** (sandbox), and more fields:

| Field | Value |
|---|---|
| SMART on FHIR Version | **R4** |
| SMART Scope Version | **SMART v1** (GA requests `patient/<Type>.read` for each API listed above, v1 syntax; Epic does not grant `patient/*.read`) |
| FHIR ID Generation Scheme | **Use Unconstrained FHIR IDs**. Never change it later: GA links portal records by Epic's IDs, so new IDs would duplicate every record |
| Summary | `Personal health record: keeps a read-only copy of my own records on my own computer.` |
| Description | `GA is a self-hosted personal health record for one patient. It reads the patient's own records with read-only SMART on FHIR access, stores them only on the patient's computer, and never writes back to the EHR or shares data with third parties.` |
| Intended Purposes | **Individuals' Access to their EHI** |
| Intended Users | **Individual/Caregiver** |
| Thumbnail, Screenshots | optional |
| Terms and Conditions Secure URL | `https://github.com/<user>/ga-server/blob/main/TERMS.md` (this repo's [TERMS.md](../TERMS.md); the repo must be public) |
| Additional Disclosure Information URL | leave empty |
| Data Use Questionnaire | see [Data Use Questionnaire](#data-use-questionnaire) below |

**d. Sandbox first, production last.** Click **Save & Ready for Sandbox** and test against Epic's sandbox with the **Non-Production Client ID**. Marking it ready for production freezes the app (Epic: "the app cannot be edited") and, with USCDI v3, Epic sends it to every qualifying Epic customer. So before **Save & Ready for Production**, all of these must be done:

- **An `https` Endpoint URI**, added and tested as in [https callback](#https-callback).
- The required fields above (Summary, Intended Purposes, Intended Users, Terms URL), both questionnaires, and the open.epic terms-of-use checkbox.

Other customers receiving the app cannot use it: only your Mac holds GA's private key.

**Sandbox test.** Run it against a throwaway test patient so the sandbox's fictional records never touch yours (`GA_PATIENT_ID` is for tests only):

```sh
GA_PATIENT_ID=<test patient id> ga connect https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4 --client-id <Non-Production Client ID> --name "Epic sandbox"
```

Log in as Epic's sandbox patient `fhircamila` / `epicepic1` and choose the longest access (1 year). Then `ga disconnect fhir-epic-com`, delete the test patient, and remove the sandbox entry from `.ga/smart/sources.json` so the daily sync doesn't report it.

Verified in the sandbox (2026-11-06): the `http://localhost:8765/callback` redirect works, and so does the https Funnel callback (a newly added Endpoint URI took a few hours to reach the sandbox; until then Epic answers "The request is invalid"); Epic issues a refresh token without `openid`; access duration up to 1 year; Epic grants no `patient/*.read` wildcard, so GA names each type; the dry run fetched 308 records across 13 types. Types Epic refused (403: not among the selected APIs; FamilyMemberHistory is not even offered for this app, so family history keeps coming from EHI exports) or rejected (400: CarePlan, Media, Specimen need parameters GA doesn't send) are skipped and listed.

## https callback

Production Epic accepts only `https` redirects, so GA receives the login callback through Tailscale Funnel (the same Funnel that serves share links, see [Sharing](../README.md#sharing)). Only the `/callback` path is added, and GA listens behind it only while `ga connect` waits for your login; any other time it answers nothing.

1. Your Funnel address is `https://<machine>.<tailnet>.ts.net`: `tailscale status --json | grep DNSName` (drop the trailing dot), or the Tailscale app's machine name. With the Mac App Store app, `tailscale` is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
2. Route `/callback` to GA's login listener (once; it stays across restarts):

   ```sh
   tailscale funnel --bg --set-path /callback 8765
   tailscale funnel status          # shows /callback proxying to 127.0.0.1:8765, beside / for share links if set
   ```

3. In the Epic app, **Add Another URI**: `https` + `<machine>.<tailnet>.ts.net/callback`. Keep the `http://localhost:8765/callback` one for the sandbox.
4. Connect with it once; GA remembers it (in `.ga/smart/app.json`) for later `ga connect` runs:

   ```sh
   ga connect <hospital FHIR base URL> --client-id <Client ID> --redirect-uri https://<machine>.<tailnet>.ts.net/callback
   ```

A login that never returns usually means Funnel is off or `/callback` isn't routed: check `tailscale funnel status`. Anyone can reach that URL while GA waits, but GA accepts only the one callback carrying the login's random `state`, and the code is useless without GA's private key and PKCE verifier.


Open it with **Open Data Use Questionnaire** on the app page. Epic shows some answers to patients when they log in, and **they cannot be changed after the app is marked ready for production**. Answers must be truthful: they describe GA as it is today (see [TERMS.md](../TERMS.md)). Save after each answer.

### Questionnaire from 5/28/2021

| Question | Answer |
|---|---|
| Which option best describes the company offering the app? | **An individual or independent developer.** |
| How is this app funded? | **This app is produced by volunteers or is available in the open source community.** (only this one) |
| Where does this app store user data? | **This app can store user data locally on the user's device.** and **This app offers users an option to store data in locations outside of the user's control.** (questions and PDF reading send record text to your AI provider, if you turn them on) |
| For how long does this app store user data? | **This app stores your data indefinitely.** |
| Does this app allow users to delete all of the data that have been stored about them? | **Yes, this app allows users to delete all of the data that have been stored about them.** |
| Other than the user, who has access to user data? | **People and groups users authorize.** (share links) and **Apps that users authorize.** (your AI agents over MCP, and Claude answering share-link questions) |
| For each entity that can access user data, will the user approve sharing data with that specific entity? | **Yes, users specifically approve for each entity.** (one approval per share link, not per access) |
| Will the user be notified by default of each access to user's data? | **No.** (GA logs share access; it does not notify) |
| Does the app developer allow users to obtain a complete record of the data that have been collected about them? | **Yes, the app developer allows users to obtain a complete record of the data that have been stored about them.** |
| Does the app developer use data about a user for reasons other than providing direct services to the user? | **No, the app developer doesn't use data about users beyond providing direct services.** |
| What other individuals from the user's health record does the app use data about beyond providing direct services? | **No one.** (only this one) |
| How does the app use data about other individuals in the user's health record? | tick nothing |
| Does this app allow users to obtain a complete record of who has accessed data about them? | **No, this app allows users to obtain only a partial record of who has accessed data about them.** (`ga share log` covers share links, not your own agents' reads) |
| Is user data retained after a user deletes the app and closes their account? | **No.** |

### Questionnaire from 12/27/2018

Answer this tab too: hospitals on older Epic versions show it, and an unanswered one warns patients at login. Keep it consistent with the 2021 answers above.

| Question | Answer |
|---|---|
| Which option best describes the company offering the app to users/patients? | **An individual or independent developer.** |
| Do you have a business associate agreement with each covered entity your app will connect to? | **No.** |
| How is this app funded? | **This app is produced by volunteers or is available in the open source community.** (only this one) |
| Where can this app store user data? | **Locally on the user's device.**, **The app can perform core services without storing data on servers, and the app stores user data on servers in the US only if the user opts in.** and **…on servers outside the US only if the user opts in.** (GA runs on your own machine by default; if you choose to host it on a cloud server, in any country, or turn on questions or PDF reading, which send record text to your AI provider, that is your opt-in. Do not tick the plain "On servers in/outside the United States": GA never requires a server) |
| Other than the user, who has access to user data? | **People and groups users authorize.** and **Apps that users authorize.** |
| Will the user specifically approve and be notified of each access, or is their authorization general and information is shared without notification? | **Users authorize access and sharing of their information generally and are not notified.** (you approve each share link once; its accesses are logged, not notified) |
| Do you allow users to obtain a record of the data that have been collected about them? | **We allow users to obtain a complete record of the data that have been collected about them.** |
| Does this app allow users to delete the data that have been stored about them? | **This app allows users to delete all of the data that we have stored about them.** |
| Do you retain user data after a user deletes the app and closes their account? | **No.** |
| Other than providing direct service to the user, how do you use data about the user? | **We don't use data about users beyond providing direct services.** (only this one) |
| For how long does this app store user data? | **This app stores user data indefinitely.** |
| Does this app allow users to obtain a record of who has accessed data about them? | **This app allows users to obtain a partial record of who has accessed data about them.** (same as 2021: `ga share log` covers share links, not your own agents' reads) |
