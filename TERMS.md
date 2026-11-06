# GA Terms and Conditions

GA ("Guardian Angel") is open-source software that a person runs on their own computer to keep a copy of their own health records. These terms apply to anyone who connects GA to a health system, including through Epic (MyChart) with SMART on FHIR.

## Who runs GA

There is no GA service and no GA company. Each copy of GA is installed and run by the patient it serves (or their caregiver) on hardware they control. Nobody else operates it, hosts it or receives data from it. "You" below means that person.

## What GA does with your data

- **Read only.** GA asks your health system for read-only access to your own records. It never creates, changes or deletes anything in your health system's records.
- **Stored on your computer.** Records GA fetches are stored only in the database on the computer where you run GA. The access tokens your health system issues are encrypted on that computer.
- **No third parties.** GA does not sell, rent or share your data, and has no advertising, analytics or tracking.
- **Network traffic.** GA connects only to:
  - your own health systems, to fetch your records;
  - your own AI provider, only if you turn that on (for example for answering questions or reading a PDF), using your own account;
  - people you choose to share with, only if you create a share link. Each link covers only the records you select, can expire, and you can revoke it at any time.
- **Your control.** You can disconnect a health system at any time (`ga disconnect`). This deletes GA's tokens; you can also revoke GA's access in MyChart. Deleting GA's data directory and database deletes everything GA stored.

## No medical advice

GA shows you your records and can help you read them. It is not a medical device and does not give medical advice, diagnosis or treatment. Talk to your clinician about any health decision. Records may be incomplete, out of date or duplicated; your health system's records are the authoritative source.

## No warranty

GA is provided "as is", without warranty of any kind, express or implied, including fitness for a particular purpose. To the extent the law allows, the authors are not liable for any loss or damage arising from its use. You are responsible for securing the computer GA runs on, its backups, and any links you share.

## Changes

These terms may be updated in this repository. The current version is always at `TERMS.md` in the main branch, and its history shows every change.

## Contact

Open an issue in this repository.
