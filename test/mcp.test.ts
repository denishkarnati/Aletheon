// Drives the built MCP server (dist/mcp.js) over stdio the way an MCP client does: initialize (version negotiation),
// tools/list, tools/call, ground_check, show_ledger, write denial, unknown methods and malformed input. Offline.
// Run: npm run build && npm run test:mcp
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import pkg from '../package.json';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

async function main(): Promise<void> {
  const server = path.resolve(__dirname, 'mcp.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-mcp-'));
  const p = spawn(process.execPath, [server], {
    env: { ...process.env, ALETHEON_ROOT: root, ALETHEON_BOARD: 'rpi-pico', ALETHEON_EMBED: 'off', ALETHEON_ALLOW_WRITE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<unknown, (m: any) => void>();
  const unmatched: any[] = [];
  readline.createInterface({ input: p.stdout! }).on('line', (l) => {
    const m = JSON.parse(l);
    const r = pending.get(m.id);
    if (r) {
      pending.delete(m.id);
      r(m);
    } else unmatched.push(m);
  });
  let next = 1;
  const rpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name: string, args: unknown): Promise<string> => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;

  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('initialize: supported version echoed', init.result.protocolVersion === '2025-03-26');
  check('initialize: version from package.json', init.result.serverInfo.version === pkg.version, init.result.serverInfo.version);
  check('initialize: tools capability', !!init.result.capabilities.tools);
  const future = await rpc('initialize', { protocolVersion: '2099-01-01' });
  check('initialize: unknown version gets our newest, not an echo', future.result.protocolVersion === '2025-06-18', future.result.protocolVersion);
  p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list');
  const names: string[] = list.result.tools.map((t: any) => t.name);
  check(
    'tools/list: core tools plus ground_check and show_ledger',
    ['lookup_register', 'audit_claims', 'generate_regs_header', 'ground_check', 'show_ledger'].every((n) => names.includes(n)),
    names.join(','),
  );
  check(
    'tools/list: every tool has an object inputSchema',
    list.result.tools.every((t: any) => t.inputSchema?.type === 'object'),
  );

  check(
    'tools/list: the part-number tools are offered to MCP clients (Codex and others)',
    ['find_datasheet', 'device_model', 'simulate_i2c'].every((n) => names.includes(n)),
    names.join(','),
  );
  const dm = await call('device_model', { part: 'TMP117' });
  check(
    'tools/call device_model over MCP: address, strap and a page-cited quote come back with evidence ids',
    /\[E\d+\]/.test(dm) && dm.includes('0x48 (ADD0 to GND)') && /datasheet p\.\d+/.test(dm),
  );
  const sim = await call('simulate_i2c', {
    part: 'TMP117',
    ops: [
      { op: 'write', addr: 0x49, bytes: [0x0f] },
      { op: 'write', addr: 0x48, bytes: [0x0f] },
      { op: 'read', addr: 0x48, n: 2 },
    ],
  });
  check(
    'tools/call simulate_i2c over MCP: the wrong address NACKs and Device_ID reads 0x0117 at the right one',
    sim.includes('NACK: nothing answers at 0x49') && sim.includes('-> [0x01 0x17]'),
  );
  const ledgerText = await call('show_ledger', {});
  check(
    'the simulation and the model are in the evidence ledger an MCP client can read back',
    /simulate_i2c TMP117/.test(ledgerText) && /SNOSD82D|tmp117/i.test(ledgerText),
  );

  const boards = await call('list_boards', {});
  check('tools/call list_boards: selected board marked', boards.includes('rpi-pico (selected)'));
  const gc = JSON.parse(await call('ground_check', { text: 'UARTFR is at 0x40034018 [E99].' }));
  check('ground_check: invented citation flagged', gc.counts['unknown-citation'] === 1 && gc.ok === false);
  const denied = await call('write_file', { path: 'x.c', content: 'int x;' });
  check('write_file denied without ALETHEON_ALLOW_WRITE', denied.includes('declined') && !fs.existsSync(path.join(root, 'x.c')));
  const escape = await rpc('tools/call', { name: 'read_file', arguments: { path: '../../etc/passwd' } });
  check(
    'read_file outside the workspace is an error result',
    escape.result.isError === true && escape.result.content[0].text.includes('escapes the workspace'),
  );
  const ledger = JSON.parse(await call('show_ledger', {}));
  check('show_ledger returns an array', Array.isArray(ledger));

  const unknown = await rpc('resources/list');
  check('unknown method: JSON-RPC -32601', unknown.error?.code === -32601);
  p.stdin!.write('{not json\n');
  await new Promise((r) => setTimeout(r, 300));
  check(
    'malformed line: parse error -32700, server keeps running',
    unmatched.some((m) => m.error?.code === -32700) && (await rpc('ping')).result !== undefined,
  );

  p.stdin!.end();
  await new Promise((r) => p.on('close', r));
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main();
