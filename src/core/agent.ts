import { auditClaims, formatAudit } from './audit';
import { ProviderConfig, Turn, Usage, addUsage, complete, emptyUsage } from './providers';
import { TOOLS, ToolCtx, callTool } from './tools';

export type AgentEvent =
  | { type: 'delta'; text: string } // streamed text of the current step
  | { type: 'text'; text: string; streamed: boolean } // the step's complete text (already shown as deltas when streamed)
  | { type: 'tool'; name: string; args: unknown; result: string }
  | { type: 'warn'; text: string }
  | { type: 'usage'; usage: Usage; steps: number }; // provider-reported tokens for the whole answer

const MAX_STEPS = 14;
const KEEP_CHARS = 400;

// Tool results from earlier answers are cut to their first line plus every [E#] they produced. The full text stays in the
// evidence ledger (the model can re-run a lookup), so history stops growing by kilobytes per tool call. The current answer's
// results are never touched: they are what the model is reasoning over, and leaving them intact keeps the prompt cache valid.
export function compactHistory(history: Turn[]): void {
  for (const t of history) {
    if (t.role !== 'tool') continue;
    for (const r of t.results) {
      if (r.content.length <= KEEP_CHARS) continue;
      const ids = [...new Set(r.content.match(/\[E\d+\]/g) ?? [])];
      const head = r.content.split('\n')[0].slice(0, 200);
      r.content = `${head}\n[compacted earlier result: ${r.content.length} chars; evidence ${ids.join(' ') || 'none'} is in the ledger]`;
    }
  }
}

function systemPrompt(ctx: ToolCtx): string {
  const b = ctx.host.getBoard();
  return `You are Aletheon, an embedded firmware engineer working inside the user's IDE.

GROUNDING RULES (non-negotiable):
1. Never state a register address, bit field, pin mapping, voltage, current, clock rate or timing from memory. Register addresses, offsets, reset values and bit positions come from lookup_register (index_svd first); electrical values, pin functions and timing come from search_datasheets (index_datasheet first). Cite the evidence id, e.g. [E7]. If the SVD and the datasheet disagree, report the conflict instead of picking one.
2. Claims about behaviour on real hardware must come from build, flash or serial_capture output, cited the same way. Do not say code "works" until a build succeeded, and do not say it runs correctly until serial or other real output shows it.
3. If the evidence is missing or contradicts itself, say UNVERIFIED and say exactly what evidence would resolve it. Asking the user is better than guessing.
4. Evidence ids [E#] only exist if a tool returned them in this conversation. Never invent one.
5. Prefer small, reviewable changes. write_file and flash require user approval; explain what you will do first.
6. DRIVER WORKFLOW (when asked to write/bring up a peripheral driver): (a) index_svd, then search_datasheets for the init sequence, clock/reset/pin-mux requirements and errata; (b) generate_regs_header for the peripheral; (c) check_header; (d) write the driver .c/.h with write_file using ONLY macros from the generated header (never hard-code addresses or bit positions), citing the datasheet evidence for each init step in comments; (e) build and fix real compiler errors; (f) only if the user approves, flash and serial_capture to confirm behaviour. Report which of those steps were actually done and which were not.
7. Before giving your final answer, call cross_check_register for any register address you will state when both an SVD and a datasheet are indexed, and audit_claims on your draft; fix anything flagged or mark it UNVERIFIED. Prefer evidence marked vendor-official or measured over community-mirror sources and say when a claim rests only on a community mirror.
8. For reverse-engineering questions about binaries, firmware images, captures, use rea_run and cite its output.

Target board: ${b ? `${b.name} (${b.mcu}, ${b.arch}); registry datasheets: ${b.docs.map((d) => d.url).join(', ')}; SVD: ${b.svd ?? 'none known (ask the user for a CMSIS pack/SVD)'}` : 'none selected; ask or use list_boards/detect_boards'}.
Workspace: ${ctx.host.root}. Indexed docs: ${
    ctx.docs
      .list()
      .map((d) => `${d.source} (${d.pages}p, ${d.embedded ? 'semantic' : 'keyword-only'})`)
      .join('; ') || 'none'
  }. Indexed SVDs: ${
    ctx.svd
      .list()
      .map((d) => d.name)
      .join(', ') || 'none'
  }.`;
}

export async function runAgent(opts: {
  cfg: ProviderConfig;
  ctx: ToolCtx;
  history: Turn[];
  userText: string;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { cfg, ctx, history, onEvent, signal } = opts;
  compactHistory(history);
  history.push({ role: 'user', text: opts.userText });
  const specs = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  let usage = emptyUsage();
  let steps = 0;
  const finish = (text: string): string => {
    onEvent({ type: 'usage', usage, steps });
    return text;
  };
  for (let step = 0; step < MAX_STEPS; step++) {
    let streamed = false;
    const out = await complete(cfg, systemPrompt(ctx), history, specs, {
      signal,
      onText: (d) => {
        streamed = true;
        onEvent({ type: 'delta', text: d });
      },
    });
    usage = addUsage(usage, out.usage);
    steps++;
    history.push({ role: 'assistant', text: out.text, calls: out.calls });
    if (out.text) onEvent({ type: 'text', text: out.text, streamed });
    if (!out.calls.length) {
      const g = auditClaims(out.text, ctx.ledger);
      if (!g.ok || g.weak) onEvent({ type: 'warn', text: `Claim audit:\n${formatAudit(g)}` });
      return finish(out.text);
    }
    const results = [];
    for (const c of out.calls) {
      const content = await callTool(c.name, c.args, ctx);
      onEvent({ type: 'tool', name: c.name, args: c.args, result: content.slice(0, 600) });
      results.push({ id: c.id, name: c.name, content });
    }
    history.push({ role: 'tool', results });
  }
  const msg = `Stopped after ${MAX_STEPS} tool steps without a final answer.`;
  onEvent({ type: 'warn', text: msg });
  return finish(msg);
}
