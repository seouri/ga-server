// The tool loop shared by share questions and text messages: any OpenAI-compatible Chat Completions API, tool calls run by the caller.
import OpenAI from 'openai';
import { GaError } from './config.ts';

type Any = Record<string, any>;
export const SORRY = 'Sorry, that question needs more than I can look up here.';
const MAX_TOOL_TURNS = 8;
const MAX_RESULT = 50_000;
const MAX_TOTAL = 200_000; // tool-result characters per question, across all turns
export const BUDGET_USED = 'tool budget for this question used up; answer with what you have';

// The slice of the OpenAI SDK used; tests pass a scripted fake.
export type Llm = { chat: { completions: { create: (p: any) => Promise<any> } } };

export async function chatLoop(deps: { llm: Llm; model: string; onTime?: (kind: 'llm' | 'tool', ms: number) => void }, messages: Any[], tools: Any[], run: (name: string, input: Any) => Promise<unknown>): Promise<string> {
  let used = 0;

  for (let turn = 0; ; turn++) {
    let msg: Any, finish: string | undefined;
    try {
      const t0 = performance.now();
      const res = await deps.llm.chat.completions.create({ model: deps.model, max_completion_tokens: 4000, tools, messages }).finally(() => deps.onTime?.('llm', performance.now() - t0));
      ({ message: msg, finish_reason: finish } = res.choices?.[0] ?? {});
    } catch (e) {
      // Status and error code only: bodies can echo record content.
      if (e instanceof OpenAI.APIError) throw new GaError(`LLM API error: ${e.status ?? 'connection'} ${e.code ?? e.type ?? ''}`.trim());
      throw e;
    }
    // Some servers send tool calls with finish_reason 'stop': branch on the calls themselves.
    const calls: Any[] = (msg?.tool_calls ?? []).filter((c: Any) => c?.function?.name);
    if (!calls.length) {
      const text = typeof msg?.content === 'string' ? msg.content.trim() : '';
      if (!text) return SORRY;
      return finish === 'length' ? `${text}\n(answer cut short)` : text;
    }
    if (turn >= MAX_TOOL_TURNS) return SORRY;
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const c of calls) {
      let content: string;
      if (used >= MAX_TOTAL) content = BUDGET_USED;
      else {
        let v: unknown;
        const t0 = performance.now();
        try {
          // Arguments are model output: malformed JSON becomes an error result, not a crash.
          v = await run(c.function.name, (JSON.parse(c.function.arguments || '{}') ?? {}) as Any);
        } catch (e) {
          v = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
        deps.onTime?.('tool', performance.now() - t0);
        const json = JSON.stringify(v) ?? 'null';
        content = json.length > MAX_RESULT ? `${json.slice(0, MAX_RESULT)} [truncated]` : json;
        used += content.length;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
}
