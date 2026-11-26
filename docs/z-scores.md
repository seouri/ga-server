# Growth z-scores

A note on the two z-score lanes of the chronology page (`ga ui`): how the numbers are computed, and how readings that are probably errors are kept out of them.

Back to [clinical methods](clinical-methods.md).

## What is shown

For a person under 20 whose sex and birth date are in the record, the Measurements section has a "Weight z-score" lane and a "Height z-score" lane: one point for each clinic weight and each clinic height. A z-score says how far a reading is from the median for children of that age and sex, in standard deviations.

The z-scores are GA's own computation. They are worked out when the page is drawn and are not stored in the record. Hovering a point says so; clicking it opens the reading it was computed from.

## How a z-score is computed

- **References**, as the CDC recommends for the United States: the WHO Child Growth Standards from birth to 24 months, the CDC 2000 growth charts from 2 to 20 years. No z-score is given past 240 months, without the person's sex and birth date, or for a sex other than male or female (the references have only those two).
- **Method**: the LMS method. z = ((x / M)^L - 1) / (L x S), or ln(x / M) / S when L is within 0.01 of zero. WHO: the parameters of the exact day of age; for weight, a z beyond 3 or -3 is measured in units of the distance between the 2nd and 3rd standard deviations, as WHO specifies. CDC: the parameters interpolated linearly between the charts' half-month ages; age in months is days / 30.4375.
- **Age** is counted in whole days from the birth date to the date of the reading as written.
- **Height under 2 years** is taken as recorded. The WHO standard under 24 months is for recumbent length; a standing height recorded for a child under 2 is not adjusted (WHO adds 0.7 cm), because the record does not say how it was measured.

Code: `growthZ` in `src/growth.ts`. Reference parameters: `config/growth-reference.json`.

## Screening out probable errors

A hospital record contains mistakes: a weight typed with the decimal point in the wrong place, pounds entered as kilograms, one child's reading filed under another. A z-score makes such a mistake obvious, and one such point distorts the picture of a child's growth. So before the z-scores are drawn they are screened, and a point that fails is not drawn as a value.

**These rules are heuristics. They are expected to change as more records are seen. There will always be some rule of this kind; this section is where the rule in force is written down.**

The rules in force:

1. **More than 4 standard deviations.** A z-score above 4 or below -4 is set aside.
2. **A jump of 2 standard deviations within a year.** Going through the readings oldest first, a z-score that differs by 2 or more from the last accepted z-score is set aside, when that accepted reading is no more than 365 days older. The comparison is always with the last reading that passed, never with one that was set aside, so the reading after an error is judged against the last good one.

**What happens to a point that is set aside:**

- It is not drawn as a value. A small red question mark is drawn in its place, at mid-lane (its height on the lane means nothing).
- Hovering the mark gives the reason, with the numbers. Clicking it opens the reading.
- It does not take part in the lane's scale or in the screening of later points.
- Nothing is removed from the record. The reading itself stays where it was, including in its own Weight or Height lane, where a value far outside the others is drawn at the lane's edge.

Code: `screenZ` and its thresholds `Z_SCREEN` in `src/growth.ts`. To change a rule, change it there, update this section and the tests in `tests/growth.test.ts`.

## What the screening does not do

- It does not correct anything, and it does not guess what the reading should have been.
- It cannot tell an error from a real, rapid change. A child who truly loses or gains 2 standard deviations in a year (severe illness, or recovery from it) will have that reading set aside. The question mark means "look at this reading", not "this reading is wrong".
- The first reading of a series has nothing before it to be compared with, so only the 4 standard deviation rule applies to it. If the first reading is the wrong one and is within 4, the readings after it are judged against it.
- It applies to the two z-score lanes only. Weight, height and the other lanes show every reading as recorded.

## Sources and validation

- **Parameters and validation cases**: the CDC's `CDCAnthro` R package (github.com/CDC-DNPAO/CDCAnthro, version 0.6.1), whose tables come from cdc.gov/growthcharts (percentile data files) and the WHO standards. Only the published parameters were taken, not the package's code.
- **Validation of the computation**: against that package's test files, GA gives the CDC SAS program's weight-for-age and height-for-age z to four decimals on 10,000 cases each, and WHO Anthro's length-for-age z (two decimals) on 6,708 cases; its WHO weight-for-age z differs from WHO Anthro's rounded value by at most 0.007. `tests/growth.test.ts` keeps a sample of those cases and the cases for the screening rules.
