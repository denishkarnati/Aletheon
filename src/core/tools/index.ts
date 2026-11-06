// The tool layer shared by the VS Code extension and the MCP server. Each domain lives in its own module; this file
// fixes the order the tools are offered in, so models and MCP clients see the same list as before the split.
import { errorMessage } from '../util';
import { auditTools } from './audit';
import { Tool, ToolCtx } from './context';
import { deviceTools } from './devices';
import { docTools } from './docs';
import { hardwareTools } from './hardware';
import { reaTools } from './rea';
import { registerTools } from './registers';
import { workspaceTools } from './workspace';

export type { Host, Tool, ToolCtx } from './context';
export { createToolCtx } from './context';

const ORDER = [
  'list_boards',
  'detect_boards',
  'index_datasheet',
  'search_datasheets',
  'find_datasheet',
  'device_model',
  'simulate_i2c',
  'index_svd',
  'lookup_register',
  'generate_regs_header',
  'check_header',
  'cross_check_register',
  'audit_claims',
  'list_dir',
  'read_file',
  'write_file',
  'build',
  'flash',
  'serial_capture',
  'rea_run',
];
const ALL = [...hardwareTools, ...docTools, ...deviceTools, ...registerTools, ...auditTools, ...workspaceTools, ...reaTools];
export const TOOLS: Tool[] = ORDER.map((n) => {
  const t = ALL.find((x) => x.name === n);
  if (!t) throw new Error(`tool ${n} missing from the registry`);
  return t;
});
if (ALL.length !== ORDER.length) throw new Error('a tool module exports a tool that is not listed in ORDER');

// Checks model-supplied arguments against the tool's declared input_schema before anything runs (and before any approval prompt is shown).
export function validateArgs(schema: Record<string, unknown>, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const a = args as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const k of (schema.required ?? []) as string[]) if (a[k] === undefined) return `missing required argument "${k}"`;
  for (const [k, def] of Object.entries(props)) {
    const v = a[k];
    if (v === undefined || !def.type) continue;
    const numeric = typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)); // models often send numbers as strings
    const ok = def.type === 'number' || def.type === 'integer' ? numeric : def.type === 'array' ? Array.isArray(v) : typeof v === def.type;
    if (!ok) return `argument "${k}" must be a ${def.type}`;
  }
  return undefined;
}

export async function callTool(name: string, args: unknown, ctx: ToolCtx): Promise<string> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return `Unknown tool ${name}`;
  const invalid = validateArgs(t.input_schema, args ?? {});
  if (invalid) return `Error: invalid arguments for ${name}: ${invalid}`;
  try {
    return await t.run(args ?? {}, ctx);
  } catch (e) {
    return `Error: ${errorMessage(e)}`;
  }
}
