// Instructions for chat apps (remote MCP), generated from the /ga skill (steps 0-9; step 10, sharing, is replaced by tools) and ga-import/extract.md.
import { readFileSync } from 'node:fs';
import { APPLE } from './share/ask.ts';

const read = (p: string): string => readFileSync(new URL(`../.claude/skills/${p}`, import.meta.url), 'utf8');

const STEP0 =
  'Read tools add `portalWarning` to their result when a connected hospital source is stale; `hospital_status` gives the details. A source is stale if its status is `off` or `error`, or its last success is missing or older than 48 hours. ' +
  'If any is stale, start the answer with one line naming it, its last success and the fix: `hospital_connect` when `off` (the user finishes the login in the link it returns); ' +
  '`hospital_sync` when `error`. Error `disconnected` means the user disconnected it on purpose: say so. Error `not_enabled` means no record types are enabled yet, so GA holds nothing from it: ' +
  'use `hospital_sync` with `enable` after checking the dry-run counts. No sources: say nothing.';

export function chatInstructions(): string {
  const skill = read('ga/SKILL.md');
  const bold = (l: string): string => /^\d+\. \*\*[^*]+\*\*/.exec(l)?.[0] ?? '';
  const steps = skill
    .slice(skill.search(/^0\. /m), skill.search(/^10\. /m))
    .split('\n')
    .map((l) => (/^0\. /.test(l) ? `${bold(l)} ${STEP0}` : /^6\. /.test(l) ? `${bold(l)} ${APPLE}` : l))
    .join('\n')
    .trim();
  const extract = read('ga-import/extract.md')
    .split('\n')
    .map((l) => {
      if (/^1\. /.test(l)) return '1. To import a PDF or image the user shares, call `upload_link` first: the user uploads the file there and you get a `fileId`. Read the file content from the chat.';
      if (/^6\. /.test(l))
        return l
          .replace('sourceFile: "<absolute path>"', 'fileId: "<the `fileId` from `upload_link`>"')
          .replace('refused with `already imported: <file>`', 'refused as already imported');
      if (/^10\. /.test(l)) return '10. Medication status: a medication dropped from a newer list is not marked stopped. Apply the currency rule from step 4 of the answering rules above.';
      return l;
    })
    .join('\n')
    .trim();
  return `${steps}\n\nImporting a document:\n${extract}\n\nCreating a share, enabling hospital record types or recording a follow-up (\`record_followup\`) returns a preview: show it to the user and call again with its \`confirm\` code only after the user says yes.`;
}
