# Clinical methods

Back to the [README](../README.md).

This page describes how GA computes its risk scores, its screening and vaccine status, and its medication label checks, and where each method comes from. It is written for a clinician or a technically minded user who wants to check the work. It describes the code as it is; each section names its source files.

GA is a personal health record, not a medical device. Nothing here is medical advice.

The AI agent never computes a score itself. GA's instructions (AGENTS.md and the MCP server instructions) tell the agent to gather the inputs from the record, call the tool, and relay what it returns. The tools are `cardiovascular_risk_10yr`, `liver_fibrosis_risk`, `health_maintenance`, `vaccine_gaps` and `whats_new`. Screening and vaccine items carry their guideline citation, and `liver_fibrosis_risk` returns its references. `cardiovascular_risk_10yr` returns the PREVENT model used, notes, and a `citations` list (PREVENT, PCE, preventr), worded as references 1, 3 and 4 below.

## Cardiovascular risk: PREVENT and Pooled Cohort Equations

Code: `src/cardiovascular-risk.ts`. Tool: `cardiovascular_risk_10yr`.

### What it estimates

- **PREVENT** (AHA Predicting Risk of CVD Events): risk of total CVD, ASCVD and heart failure over 10 years and over 30 years, in adults without known CVD. Sex-specific, race-free, adjusted for the competing risk of non-CVD death.
- **Pooled Cohort Equations (PCE)**, 2013 ACC/AHA: 10-year risk of a first hard ASCVD event.

Results are probabilities from 0 to 1.

### Inputs and units

| Input | Unit | Used by |
|---|---|---|
| Age, sex | years | both |
| Total cholesterol, HDL cholesterol | mg/dL | both |
| Systolic blood pressure | mmHg | both |
| On blood pressure treatment, diabetes, current smoker | yes/no | both |
| On a statin | yes/no | PREVENT (PCE ignores it, with a note) |
| eGFR | mL/min/1.73 m² | PREVENT |
| BMI | kg/m² | PREVENT heart failure only (optional) |
| HbA1c | % | PREVENT HbA1c and full models (optional) |
| UACR | mg/g | PREVENT UACR and full models (optional) |
| Race (`black` or `other`) | | PCE only (optional) |

Social deprivation index is not supported; the full model runs with SDI coded as missing.

### How GA computes it

- **Model choice.** HbA1c and UACR both given: full model. HbA1c only: HbA1c model. UACR only: UACR model. Neither: base model. The result names the model used.
- **Validity ranges.** Out of range gives `null` with a note, never an extrapolation:

  | Input | PREVENT | PCE |
  |---|---|---|
  | Age | 30-79 | 40-79 |
  | Total cholesterol | 130-320 | 130-320 |
  | HDL | 20-100 | 20-100 |
  | SBP | 90-180 | 90-180 |
  | eGFR | 15-140 | not used |
  | BMI (when given) | 18.5-39.9 | not used |

- **PCE and the SBP range.** preventr's `pce_model` applies the same SBP range as PREVENT (90-180 mmHg); only the age range differs (40-79 for PCE). GA follows preventr. A wider PCE range was not adopted because the 2013 guideline text did not confirm one.
- A BMI outside 18.5-39.9 nulls every PREVENT result, including ASCVD and total CVD, which do not use BMI. This follows preventr.
- An HbA1c outside 4.5-15 % or a UACR outside 0.1-25,000 mg/g is dropped with a note, and the model is chosen from what is left (preventr does the same).
- **Heart failure** needs BMI. Without it, both heart failure results are `null` with a note; ASCVD and total CVD are unchanged.
- **30-year risk** is given only for ages 30-59. Over 59 it is `null`, with preventr's note that a 30-year estimate past 59 is questionable.
- **PCE race.** `black` uses the African American equations. `other` or no race uses the white equations; with no race given, a note says so.
- **PCE and statins.** PCE assumes no statin; with `statin: true` a note says the PCE result ignores it.

### Validation in GA

PREVENT and PCE coefficients, term definitions, model choice and validity ranges are copied from the MIT-licensed R package preventr (version 0.12.2). `tests/cardiovascular-risk.test.ts` checks GA against values generated with preventr for synthetic patients:

- 6 cases for the 10-year base PREVENT ASCVD and total CVD (3 decimals) and PCE (6 decimals), across both sexes, both PCE race groups, and one age (38) where PCE is out of range.
- 9 cases for heart failure, 30-year results and the HbA1c, UACR and full models (3 decimals), including an age over 59 and an out-of-range HbA1c that falls back to the UACR model.
- The null-with-note behavior for out-of-range age, missing BMI and out-of-range BMI.

### Limits

- PREVENT was derived and validated in US adults aged 30-79 without known CVD (Khan 2024). It is not for people who already have CVD.
- PCE has equations for non-Hispanic white and African American adults aged 40-79. For other groups the guideline says the white equations "may be considered" (Goff 2013); the equations themselves do not establish how well they are calibrated in those groups.
- PREVENT and PCE estimate different things (PREVENT includes heart failure in total CVD and adjusts for competing risk). The two numbers are not interchangeable.
- GA does not choose a treatment threshold or interpret the result.

### References

1. Khan SS, Matsushita K, Sang Y, et al. Development and validation of the American Heart Association's PREVENT equations. *Circulation*. 2024;149(6):430-449. doi:[10.1161/CIRCULATIONAHA.123.067626](https://doi.org/10.1161/CIRCULATIONAHA.123.067626). PMID 37947085.
2. Khan SS, Coresh J, Pencina MJ, et al. Novel prediction equations for absolute risk assessment of total cardiovascular disease incorporating cardiovascular-kidney-metabolic health: a scientific statement from the American Heart Association. *Circulation*. 2023;148(24):1982-2004. doi:[10.1161/CIR.0000000000001191](https://doi.org/10.1161/CIR.0000000000001191). PMID 37947094.
3. Goff DC, Lloyd-Jones DM, Bennett G, et al. 2013 ACC/AHA guideline on the assessment of cardiovascular risk: a report of the American College of Cardiology/American Heart Association Task Force on Practice Guidelines. *Circulation*. 2014;129(25 Suppl 2):S49-S73. doi:[10.1161/01.cir.0000437741.48606.98](https://doi.org/10.1161/01.cir.0000437741.48606.98). PMID 24222018.
4. Mayer M. preventr: an implementation of the PREVENT and Pooled Cohort Equations. R package version 0.12.2, MIT license. <https://cran.r-project.org/package=preventr>.

## Liver fibrosis: FIB-4 and NAFLD Fibrosis Score

Code: `src/liver-fibrosis.ts`. Tool: `liver_fibrosis_risk`.

### What it estimates

Two non-invasive scores that sort a person into low, indeterminate or high likelihood of advanced liver fibrosis (stage F3-F4). Neither is a diagnosis.

### Inputs and units

| Input | Unit | Used by |
|---|---|---|
| Age | years | both |
| AST, ALT | U/L | both |
| Platelets | 10⁹/L | both |
| BMI | kg/m² | NFS |
| Albumin | g/dL | NFS |
| Impaired fasting glucose or diabetes | yes/no | NFS |

### How GA computes it

- **FIB-4** = (age × AST) / (platelets × √ALT).
- **NFS** = −1.675 + 0.037 × age + 0.094 × BMI + 1.13 × (IFG or diabetes) + 0.99 × (AST/ALT) − 0.013 × platelets − 0.66 × albumin.
- NFS is `null` with a note when BMI, albumin or the diabetes flag is missing. FIB-4 is always computed.
- **Bands.** Low if below the low cut-off, high if above the high cut-off, otherwise indeterminate. A value exactly at a cut-off is indeterminate.

  | Score | Low cut-off (under 65) | Low cut-off (65 and over) | High cut-off |
  |---|---|---|---|
  | FIB-4 | 1.3 | 2.0 | 2.67 |
  | NFS | −1.455 | 0.12 | 0.676 |

  The FIB-4 cut-offs 1.3 and 2.67 are the AASLD 2023 bands; Sterling's original paper used 1.45 and 3.25. The NFS cut-offs are Angulo's. The age-65 low cut-offs are McPherson's ("aged 65 years or over"). AASLD 2023 gives the FIB-4 2.0 cut-off for patients "older than age 65" and lists 2.67 itself as "likely" advanced fibrosis; GA calls exactly 2.67 indeterminate.
- **Age 35 or under.** Both scores are returned with a note that they are not validated at that age.
- **Unit guard.** Any input that is zero or negative is refused. Albumin over 10 is refused as probably g/L, and platelets over 2000 as probably per µL, because a wrong unit would give a falsely reassuring "low".

### Validation in GA

`tests/liver-fibrosis.test.ts` uses synthetic, hand-computed cases: FIB-4 values on each side of and exactly at each cut-off, the age-65 switch, NFS bands at its cut-offs (including the 0.12 low cut-off at 65), NFS missing an input, the age-35 note, and the refused values. There is no external reference implementation.

### Limits

- FIB-4 was derived in people with HIV/HCV coinfection (Sterling 2006); NFS in people with biopsy-proven NAFLD (Angulo 2007). Their use in MASLD rests on later validation, as summarized in the AASLD guidance.
- The scores were mostly developed and validated between ages 35 and 65. They performed poorly at 35 or under, and specificity fell at 65 and over (McPherson 2017).
- AASLD 2023 advises a secondary assessment (elastography or ELF) for FIB-4 of 1.3 or more, and says FIB-4 has low accuracy under age 35. GA reports the band only and does not suggest a next test.

### References

5. Sterling RK, Lissen E, Clumeck N, et al. Development of a simple noninvasive index to predict significant fibrosis in patients with HIV/HCV coinfection. *Hepatology*. 2006;43(6):1317-1325. doi:[10.1002/hep.21178](https://doi.org/10.1002/hep.21178). PMID 16729309.
6. Angulo P, Hui JM, Marchesini G, et al. The NAFLD fibrosis score: a noninvasive system that identifies liver fibrosis in patients with NAFLD. *Hepatology*. 2007;45(4):846-854. doi:[10.1002/hep.21496](https://doi.org/10.1002/hep.21496). PMID 17393509.
7. McPherson S, Hardy T, Dufour JF, et al. Age as a confounding factor for the accurate non-invasive diagnosis of advanced NAFLD fibrosis. *Am J Gastroenterol*. 2017;112(5):740-751. doi:[10.1038/ajg.2016.453](https://doi.org/10.1038/ajg.2016.453). PMID 27725647.
8. Rinella ME, Neuschwander-Tetri BA, Siddiqui MS, et al. AASLD Practice Guidance on the clinical assessment and management of nonalcoholic fatty liver disease. *Hepatology*. 2023;77(5):1797-1835. doi:[10.1097/HEP.0000000000000323](https://doi.org/10.1097/HEP.0000000000000323). PMID 36727674.

## Screenings: USPSTF recommendations

Code: `src/screenings.ts`, rules in `src/schedules/uspstf-screening.json`. Tool: `health_maintenance` (screening items).

### What it estimates

For each shipped USPSTF grade A, B or C recommendation: whether it applies to the person's age and sex, and whether the record shows a qualifying test recent enough. The rule file edition is "USPSTF screening recommendations, as of 2026-11-07". Every `why` and `cost` text is quoted from the statement page.

### Inputs and units

Birth date and sex from the Patient record, and the person's Procedures, DiagnosticReports, Conditions and lab or vital-sign Observations. No numeric values are read: a test counts by its code or name and date.

### Topics

| Topic | Grade | Ages | Sex | Counts as done (interval) | Statement date |
|---|---|---|---|---|---|
| Colorectal cancer | A | 50-75 | any | colonoscopy (10 y), FIT or gFOBT (1 y), stool DNA-FIT (3 y), CT colonography (5 y), flexible sigmoidoscopy (5 y) | 2021-05-18 |
| Colorectal cancer | B | 45-49 | any | same as above | 2021-05-18 |
| Cervical cancer | A | 21-65 | female | cytology (3 y); high-risk HPV test (5 y, counted only if done at 30 or older) | 2018-08-21 |
| Breast cancer | B | 40-74 | female | screening mammogram (2 y) | 2024-04-30 |
| Lung cancer | B | 50-80 | any; risk-based | low-dose chest CT (1 y) | 2021-03-09 |
| Prostate cancer (PSA) | C | 55-69 | male | PSA test | 2018-05-08 |
| Abdominal aortic aneurysm | B | 65-75 | male; risk-based | aortic ultrasound (once) | 2019-12-10 |
| Hepatitis C | B | 18-79 | any | HCV antibody (once) | 2020-03-02 |
| HIV | A | 15-65 | any | HIV test (once) | 2019-06-11 |
| Prediabetes and type 2 diabetes | B | 35-70 | any; risk-based | A1c or fasting glucose (3 y) | 2021-08-24 |
| High blood pressure | A | 18-39 | any | clinic BP reading (3 y) | 2021-04-27 |
| High blood pressure | A | 40 and over | any | clinic BP reading (1 y) | 2021-04-27 |

Risk factors as quoted in the rule file: lung, "20 pack-year smoking history and currently smoke or have quit within the past 15 years"; AAA, "ever smoked"; diabetes, "overweight or obesity".

### How GA computes it

- **Which records count.** Procedures, diagnostic reports, conditions, and lab or vital-sign observations from clinic sources, dated on or before the as-of date. Apple Health readings never count. A record does not count if it is not done, stopped, cancelled, refuted or entered in error, or if it has a data-absent reason. A date before birth is treated as a placeholder.
- **Matching.** A record matches a method by an exact standard code (LOINC, SNOMED CT, CPT, HCPCS, ICD-10-CM). It can also match by a text phrase whose every word appears as a whole word in the record's name; a trailing `*` matches a prefix, and `FIT` must be in capitals. A text match is rejected when the name contains a word from the method's not-list (for example "virtual" or "ct" for colonoscopy, "diagnostic" for mammogram). It is also rejected when the name contains a word from GA's list of order, refusal and conversation words ("ordered", "declined", "referral", "risk assessment", "due" and similar).
- **Interval.** Each record counts by its shortest matching interval; the record that keeps the person covered longest wins. A once-only test never falls due again.
- **History exclusions.** A hysterectomy (not supracervical) for cervical screening, or a bilateral mastectomy for breast screening, turns the item into "discuss": GA does not decide that the screening no longer applies.
- **Statuses.** Outside the age range or the wrong sex: "not for you". Sex-specific topic and no male/female sex in the record: "discuss". No qualifying record: "due". Due date passed: "overdue". Due within 90 days: "due soon". Otherwise "done".
- **Grade C** (PSA) is always "discuss", worded "worth discussing with your doctor".
- **Risk-based topics** are "discuss" unless a current screening is on record ("done" or "due soon"), because GA cannot check the risk factor.

### How the doctor's plan is combined

Code: `src/maintenance.ts`. Epic health maintenance from an Epic EHI export is the doctor's plan as of the export date, not a live status. A follow-up recorded with `record_followup` (a clinician's own words from a note, message or report) is also a plan.

- A plan is joined to a guideline item by topic name; a plan for a topic that is "not for you" or that matches no topic becomes a follow-up item of its own.
- Several plans for one topic: the earliest is kept. An undated Epic "Overdue" counts as earliest; an undated "Due" counts as today.
- The due date shown is the earlier of the guideline date and the plan date. The earlier date drives the status.
- An undated Epic "Overdue" or "Due" means only that Epic has no completion on file. If GA holds a dated record that keeps the guideline current, the guideline status wins.
- A plan's "Overdue" or "due soon" can raise a "discuss" item; an Epic "Due" does not settle an eligibility question.
- Epic's "Not Due" with a date on or before the export date, and any date on or before birth, are placeholders and are ignored. Epic "Aged Out" changes nothing.
- When the person tells GA a topic is done, plans dated on or before that day stop driving the status (they stay visible). "Done" for a screening becomes a synthetic record that the rule's own matching and interval read.
- A follow-up recorded without a date is due on the day it was recorded and stays listed until done.

**Importance and when items come back.** Screenings are high importance, grade C low. Vaccines are high when overdue with earlier doses on record, medium when due or overdue, otherwise low. Follow-ups are high when overdue, otherwise medium. After "not now", an item comes back after 14 days (high), 60 days (medium) or 365 days (low). "Postpone until" holds it until that date. "Dismiss" works only for low-importance items and stops it for good.

### Validation in GA

`tests/screenings.test.ts` covers code and text matching (other spellings, names that must not match, orders and refusals), the longest-covering record, due soon and overdue, age and sex, the HPV age-30 rule, history exclusions, grade C and risk-based wording, and the blood pressure intervals. `tests/maintenance.test.ts` covers Epic placeholders, earliest-plan and undated Overdue/Due handling, follow-ups without a date, done reminders, postpone, not now and dismiss. The codes in the rule file were checked against NLM Clinical Tables (LOINC, HCPCS) and tx.fhir.org (SNOMED CT), as the file's `_source` note records.

### Limits

- Only the topics above are shipped. Many USPSTF recommendations (counseling, pregnancy, children, and others) are not evaluated.
- GA cannot see family history, symptoms or prior abnormal results that change the interval, so it shows the average-risk interval.
- Text matching can miss a test with an unusual name, or rarely count the wrong one. The matched record and its date are shown as evidence so the person can check.
- A newer USPSTF statement replaces these only when the rule file is updated.

### References

9. U.S. Preventive Services Task Force. Final recommendation statements, at the URLs below (dates as recorded in the rule file):

| Statement | Date | URL |
|---|---|---|
| Colorectal cancer screening | 2021-05-18 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening> |
| Cervical cancer screening | 2018-08-21 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/cervical-cancer-screening> |
| Breast cancer screening | 2024-04-30 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/breast-cancer-screening> |
| Lung cancer screening | 2021-03-09 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lung-cancer-screening> |
| Prostate cancer screening | 2018-05-08 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/prostate-cancer-screening> |
| Abdominal aortic aneurysm screening | 2019-12-10 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/abdominal-aortic-aneurysm-screening> |
| Hepatitis C screening | 2020-03-02 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/hepatitis-c-screening> |
| HIV screening | 2019-06-11 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/human-immunodeficiency-virus-hiv-infection-screening> |
| Prediabetes and type 2 diabetes screening | 2021-08-24 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/screening-for-prediabetes-and-type-2-diabetes> |
| Hypertension screening | 2021-04-27 | <https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/hypertension-in-adults-screening> |

## Vaccines: CDC adult immunization schedule

Code: `src/vaccines.ts`, schedule in `src/schedules/cdc-adult-immunization-2025.json` (the newest file by year is used). Tools: `vaccine_gaps`, and vaccine items in `health_maintenance`.

### What it estimates

For each vaccine on the schedule: complete, immune, due, overdue, not recommended, or not evaluated ("discuss" in `health_maintenance`). Edition: "CDC Adult Immunization Schedule, Ages 19 Years or Older, United States, 2025 (Addendum updated July 2, 2025)".

### Inputs and units

Birth date and sex from the Patient record, completed Immunization records (CVX code, name, date), and qualitative lab results for immunity.

### How GA computes it

- **Doses.** Completed Immunization records dated on or before the as-of date. A dose matches a vaccine by CVX code (a combination code counts for each of its vaccines), or by name only when the name points to exactly one vaccine. Undated or unmatched doses are listed as unmatched. Doses under 28 days after the previous counted dose are treated as copies of one dose.
- **Immunity.** A qualitative lab result that starts with a positive word (positive, reactive, immune) counts as evidence of immunity for MMR, varicella, hepatitis A and hepatitis B. IgM results never count; numeric titers are not interpreted.
- **Evaluated by age and birth year:** influenza (one dose per August-July season), Tdap/Td (one Tdap ever, then a booster every 10 years), MMR (born 1957 or later: 1 dose; earlier: not recommended), varicella (born 1980 or later: 2 doses), recombinant zoster (50 and over: 2 doses; overdue 6 months after an unfinished first dose), RSV (75 and over: 1 dose), hepatitis B (19-59: 3 doses, or 2 if all Heplisav-B), pneumococcal (50 and over: complete with any PCV20 or PCV21; due with no dose at all).
- **Not evaluated, with the schedule's words**, unless the full series is already on record (then "complete"):
  - RSV 50-74: risk-based; 1 dose completes.
  - HPV 19-26: with no dose on record, due; 1-2 doses are not judged, because a 2- or 3-dose series depends on age at the first dose; 3 doses complete. HPV 27-45: shared clinical decision-making; 3 doses complete.
  - Varicella, born before 1980: depends on US birth, which GA does not record; 2 doses complete.
  - Hepatitis B, 60 and over: risk factors; 3 doses, or 2 of Heplisav-B, complete.
  - Hepatitis A: risk-based or on request; 2 doses complete.
  - Polio: childhood history; 3 doses complete.
  - Pneumococcal after doses other than PCV20/PCV21.
- **Always not evaluated:** COVID-19 (the notes depend on product and prior doses, and the 2024-25 formula no longer matches the current season) and meningococcal (indication-based).
- **Never evaluated:** the medical-condition table and special-situation notes (pregnancy, immunocompromise, chronic disease and others), occupational, travel and exposure indications, Hib and Mpox, contraindications, and minimum-interval validation.

### Validation in GA

`tests/vaccines.test.ts` covers loading the newest schedule, CVX and name matching (unmatched names are listed, not guessed), undated doses, the 28-day copy rule, records after the as-of date, seasonal influenza, Td/Tdap boosters, the zoster series, age limits, immunity evidence (leading positive word, no negation, all three antibodies for MMR), and COVID-19 and pneumococcal history left unjudged. There is no external reference implementation.

### Limits

- The shipped schedule is the 2025 edition. A newer CDC schedule is used only once its file is added.
- Doses given abroad or never entered in a record GA can read are invisible to it.
- Shared clinical decision-making and risk-based recommendations are left to the person and their clinician.

### References

10. Centers for Disease Control and Prevention. Adult Immunization Schedule by Age, Ages 19 Years or Older, United States, 2025 (addendum updated July 2, 2025). <https://www.cdc.gov/vaccines/hcp/imz-schedules/adult-age.html>.

## Medication label check (whats_new)

Code: `src/drug-labels.ts`, `src/whats-new.ts`. Tool: `whats_new` (`medicationCheck`).

### What it does

For each new medication with an RxNorm code, GA shows sections of its FDA drug label from openFDA, so the person can read the warnings. It is not an interaction check.

### Inputs and units

The RxNorm code of each medication that arrived since the person last looked.

### How GA computes it

- **Lookup.** GA asks openFDA for labels carrying the RxNorm code that have a drug interactions section, newest first. If there are none, it asks RxNav for related single-drug clinical and branded products (up to 20) and tries those codes.
- **Single substance only.** Kit and combination-product labels (several substances, or a generic name listing several drugs) are skipped, so a combination product's label is never shown for one of its ingredients.
- **Sections shown:** boxed warning, contraindications, warnings and precautions, warnings, drug interactions, use in specific populations. Each is cut at 4000 characters. The label's set id and effective date are returned.
- **What leaves the machine:** only the RxNorm code, sent to openFDA and RxNav. No names, values or dates. Results are cached locally for 30 days; a failed lookup is reported as "unavailable" and not cached.
- **Wording.** The result carries: "From the FDA label; not a full interaction screen. Ask your pharmacist." Agents are told to report only what the sections say, quoting the section and the label date.

### Validation in GA

`tests/drug-labels.test.ts` covers the product-code lookup, the RxNav fallback, skipping combination and kit labels, caching, network failure, and that only the code is sent.

### Limits

- The label is the manufacturer's text for the product, not an assessment of this person's medications together.
- A medication with no RxNorm code, or no single-substance label with an interactions section, gets no label.
- openFDA asks users not to rely on it for decisions about medical care.

### References

11. U.S. Food and Drug Administration. openFDA drug product labeling API. <https://open.fda.gov/apis/drug/label/>.
12. National Library of Medicine. RxNav RxNorm API. <https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html>.

## General limits

- GA works only from what is in the record. Missing, late or wrongly coded records change the result. Every item shows the records it used so they can be checked.
- Scores and statuses are as of a date. Epic health maintenance is as of its export date.
- GA computes; it does not recommend. The scores' cut-offs and the guideline statuses are inputs for a conversation with a clinician, not decisions.
- The shipped rule files (USPSTF topics, CDC schedule) are versioned snapshots. They do not update themselves when a guideline changes.
