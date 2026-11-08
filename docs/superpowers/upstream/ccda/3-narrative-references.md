# 3. Narrative references and ED values (existing PR)

Nothing new to file. GA carries the open external PR **medplum#11242** ("fix(ccda): resolve narrative references in codes and ED values", fixes #11202 and #10659) unchanged, applied from its head commit c1e81639. Drop row 3 of `vendor/medplum-ccda/PATCHES.md` when a Medplum release contains it.

GA needs it before its own section fixes (drafts 5 and 6): note, instruction and referral entries carry their text as `<text><reference value="#id"/></text>`, and the index this PR adds (`resolveNarrativeReference`) is how those resources get their text.

If the PR changes in review, re-apply its final diff and rerun `npx vitest run vendor`.
