// postpone and record_followup (both transports): the person's reminders and the doctor's plan an agent found in a note, as GA-written Basic records
// that healthMaintenance reads. Each write carries Provenance with the client's name, as map_concept does.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Basic, Communication, DiagnosticReport, DocumentReference, Extension, Provenance } from '@medplum/fhirtypes';
import { z } from 'zod';
import { GaError } from '../config.ts';
import { validDay } from '../labs.ts';
import { CONFIRM_ON_PAGE, preview, previewLink, takeConfirmed } from '../confirm.ts';
import { DAYS, fullDay, healthMaintenance, REMINDER } from '../maintenance.ts';
import { loadRules } from '../screenings.ts';
import { fail, text, type ToolDeps } from '../mcp.ts';
import { messageText, noteText } from '../notes.ts';

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDay, 'not a calendar date');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function registerMaintenanceTools(server: McpServer, deps: ToolDeps): void {
  const { client, patientId, remote } = deps;
  const subject = { reference: `Patient/${patientId}` };

  async function write(code: string, topic: string, ext: Extension[], reason: string, source?: string) {
    const who = remote?.clientName ?? server.server.getClientVersion()?.name ?? 'Claude Code'; // the client is known only after initialize
    const basic = await client.createResource<Basic>({
      resourceType: 'Basic', subject, created: new Date().toLocaleDateString('en-CA'), code: { coding: [{ system: REMINDER, code }] }, // Basic.created is a FHIR date, not a dateTime
      extension: [{ url: 'urn:ga-server:ext:topic', valueString: topic }, ...ext],
    });
    await client.createResource<Provenance>({
      resourceType: 'Provenance', target: [{ reference: `Basic/${basic.id}` }], recorded: new Date().toISOString(),
      activity: { coding: [{ system: 'urn:ga-server:activity', code }] }, agent: [{ who: { display: who } }], reason: [{ text: reason }],
      ...(source && { entity: [{ role: 'source' as const, what: { reference: source } }] }),
    });
    return basic;
  }
  // The engine's own spelling of the topic; a topic it does not list is refused.
  const known = async (topic: string) => {
    const hit = (await healthMaintenance(client, patientId)).items.find((i) => i.topic.toLowerCase() === topic.toLowerCase());
    if (!hit) throw new GaError(`unknown topic "${topic}": use a topic from health_maintenance`);
    return hit;
  };

  server.registerTool(
    'postpone',
    {
      description:
        'Record that the person does not want a health_maintenance item raised now. topic: the item\'s topic exactly as health_maintenance lists it. ' +
        'until (YYYY-MM-DD): hold it until that date; dismiss: true: never mention a low-importance item again (refused for medium or high importance: use not now or a date); neither: "not now", ' +
        `it comes back after ${DAYS.high} days (high importance), ${DAYS.medium} (medium) or ${DAYS.low} (low). Use it when the person says so; no confirmation step. reason: their words, optional. ` +
        'done: the person says they already had it (give at least the year it was done (YYYY, YYYY-MM or YYYY-MM-DD, in the past); method one of the screening\'s options); not with until or dismiss; not for vaccines.',
      inputSchema: { topic: z.string().min(1), until: DAY.optional(), dismiss: z.boolean().optional(),
        done: z.object({ date: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/), method: z.string().max(100).optional(), where: z.string().max(100).optional() }).optional(), reason: z.string().max(300).optional() },
      annotations: { destructiveHint: false },
    },
    async ({ topic, until, dismiss, done, reason }) => {
      try {
        if (until && dismiss) throw new GaError('give until or dismiss, not both');
        const { topic: t, importance, kind } = await known(topic);
        if (dismiss && importance !== 'low') throw new GaError(`"${t}" is ${importance} importance and cannot be dismissed: use not now, or until a date`);
        if (done) {
          if (until || dismiss) throw new GaError('done goes alone: not with until or dismiss');
          if (!validDay(fullDay(done.date)) || fullDay(done.date) > new Date().toLocaleDateString('en-CA')) throw new GaError('done.date must be a past calendar date: YYYY, YYYY-MM or YYYY-MM-DD');
          // shortcut: vaccines need an Immunization record, add a typed completion when owners ask
          if (kind === 'vaccine') throw new GaError('vaccines: import the vaccination record instead');
          const options = loadRules().topics.find((x) => x.id === t)?.doneBy.map((d) => d.name);
          const method = options?.find((m) => m.toLowerCase() === done.method?.trim().toLowerCase());
          if (kind === 'screening' ? !method : options && !method) throw new GaError(`method must be one of: ${options?.join(', ')}`);
          const m = method ?? done.method;
          await write('done', t, [{ url: 'urn:ga-server:ext:done-date', valueString: done.date }, ...(m ? [{ url: 'urn:ga-server:ext:method', valueString: m }] : []),
            ...(done.where ? [{ url: 'urn:ga-server:ext:where', valueString: done.where }] : [])], `done "${t}" ${done.date}${m ? ` ${m}` : ''}${done.where ? ` at ${done.where}` : ''}${reason ? `: ${reason}` : ''}`);
          return text({ topic: t, recorded: 'done', date: done.date });
        }
        const code = until ? 'postpone' : dismiss ? 'dismiss' : 'not-now';
        await write(code, t, until ? [{ url: 'urn:ga-server:ext:until', valueDate: until }] : [], `${code} "${t}"${until ? ` until ${until}` : ''}${reason ? `: ${reason}` : ''}`);
        return text({ topic: t, recorded: code, ...(until && { until }) });
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    'record_followup',
    {
      description:
        "Record a follow-up the clinician planned, found in a clinical note, a MyChart message or a report's conclusion in GA (never inferred by you): topic (a health_maintenance topic, or a new name), " +
        'due (YYYY-MM-DD): the date the clinician gave, counted from the note\'s date; omit when no date or interval was given (never infer one): it is then due now and stays listed until done. quote (its own words, which must appear in it), ' +
        'documentRef (DocumentReference/<id> of the note or Communication/<id> of the message, DiagnosticReport/<id> of the report; its conclusion is checked). ' +
        (remote
          ? `${CONFIRM_ON_PAGE} `
          : 'Two steps: call without confirm to get a preview and a confirm code; show it to the user, and only after they agree call again with the same arguments plus confirm. ') +
        'It then shows in health_maintenance as the doctor\'s plan, dated today.',
      inputSchema: { topic: z.string().min(1).max(100), due: DAY.optional(), quote: z.string().min(1).max(500), documentRef: z.string().regex(/^(DocumentReference|Communication|DiagnosticReport)\/[\w.-]+$/), ...(!remote && { confirm: z.string().optional() }) },
      annotations: { destructiveHint: true },
    },
    async ({ confirm, ...a }) => {
      const due = a.due ?? new Date().toLocaleDateString('en-CA');
      const record = () =>
        write('followup', a.topic, [{ url: 'urn:ga-server:ext:due', valueDate: due }, ...(a.due ? [] : [{ url: 'urn:ga-server:ext:due-stated', valueBoolean: false }]), { url: 'urn:ga-server:ext:quote', valueString: a.quote }], `follow-up "${a.topic}" due ${due}${a.due ? '' : ' (no date given)'}, quoting ${a.documentRef}`, a.documentRef);
      try {
        if (confirm) {
          const prev = takeConfirmed<typeof a>('followup', confirm);
          if (JSON.stringify(prev) !== JSON.stringify(a)) throw new GaError('arguments changed since the preview; ask for a new preview');
          await record();
          return text({ recorded: 'followup', topic: a.topic, due });
        }
        const [type, id] = a.documentRef.split('/') as ['DocumentReference' | 'Communication' | 'DiagnosticReport', string];
        const doc = await client.readResource(type, id, { cache: 'no-cache' }).catch(() => undefined) as DocumentReference | Communication | DiagnosticReport | undefined;
        if (doc?.subject?.reference !== subject.reference) throw new GaError(`${a.documentRef} is not a document of this patient`);
        const body = doc.resourceType === 'Communication' ? messageText(doc) : doc.resourceType === 'DiagnosticReport' ? doc.conclusion : noteText(doc); // shortcut: report presentedForm text is not read
        if (!body) throw new GaError(`${a.documentRef} has no note text to check the quote against`);
        if (!norm(body).includes(norm(a.quote))) throw new GaError('the quote does not appear in that document');
        const view = { topic: a.topic, due: a.due ?? 'now (no date given)', quote: a.quote, documentRef: a.documentRef };
        if (!remote) return text({ ...view, ...preview('followup', a) });
        const run = async () => (await record(), { done: `Follow-up "${a.topic}" due ${due} recorded.` });
        return text({ ...view, ...previewLink(remote.publicUrl, { title: 'Record a follow-up from a note or message', view, run }) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
