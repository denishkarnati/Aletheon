// Minimal MCP stdio server: exposes Aletheon's grounded firmware tools to any MCP-capable IDE or agent
// (Claude Code, Cursor, Codex, Gemini CLI, ...). Env: ALETHEON_ROOT, ALETHEON_BOARD, ALETHEON_ALLOW_WRITE=1.
import * as path from 'node:path';
import * as readline from 'node:readline';
import pkg from '../../package.json';
import { findBoard } from '../core/boards';
import { Embedder, resolveEmbedder } from '../core/embeddings';
import { auditClaims } from '../core/audit';
import { TOOLS, ToolCtx, callTool, createToolCtx } from '../core/tools';

const root = path.resolve(process.env.ALETHEON_ROOT ?? process.cwd());
const allowWrite = process.env.ALETHEON_ALLOW_WRITE === '1';

let embedder: Promise<Embedder | undefined> | undefined;

const ctx: ToolCtx = createToolCtx({
  root,
  storeDir: path.join(root, '.aletheon'),
  getBoard: () => findBoard(process.env.ALETHEON_BOARD),
  getToolchain: () => 'auto',
  getEmbedder: async () => {
    // ALETHEON_EMBED = auto (default) | off | ollama | openai-compatible | local ; _MODEL, _URL, _KEY optional
    embedder ??= resolveEmbedder({
      provider: (process.env.ALETHEON_EMBED as any) || 'auto',
      model: process.env.ALETHEON_EMBED_MODEL,
      baseUrl: process.env.ALETHEON_EMBED_URL,
      apiKey: process.env.ALETHEON_EMBED_KEY ?? process.env.OPENAI_API_KEY,
    });
    return embedder;
  },
  confirm: async () => allowWrite,
  log: (l) => process.stderr.write(l + '\n'),
});

const extra = [
  {
    name: 'ground_check',
    description: 'Check a draft answer: flags hardware claims with no [E#] citation and citations that are not in the evidence ledger.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'show_ledger',
    description: 'Return the evidence ledger (all [E#] entries).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Protocol versions this server implements (tools + ping over stdio). A client asking for one of them gets it back; any other
// request gets our newest, and the client decides whether it can continue, as the MCP lifecycle spec prescribes.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const negotiateVersion = (requested: unknown): string =>
  typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];

const send = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + '\n');
};
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m: any): Promise<void> {
  if (m.id === undefined) return; // notification
  switch (m.method) {
    case 'initialize':
      return reply(m.id, {
        protocolVersion: negotiateVersion(m.params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: 'aletheon', version: pkg.version },
      });
    case 'ping':
      return reply(m.id, {});
    case 'tools/list':
      return reply(m.id, {
        tools: [...TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })), ...extra],
      });
    case 'tools/call': {
      const { name, arguments: args } = m.params ?? {};
      let text: string;
      if (name === 'ground_check') text = JSON.stringify(auditClaims(String(args?.text ?? ''), ctx.ledger), null, 2);
      else if (name === 'show_ledger') text = JSON.stringify(ctx.ledger.items, null, 2);
      else text = await callTool(name, args, ctx);
      return reply(m.id, { content: [{ type: 'text', text }], isError: text.startsWith('Error:') });
    }
    default:
      return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return fail(null, -32600, 'Invalid Request');
  handle(m).catch((e) => fail(m?.id ?? null, -32603, String(e)));
});
