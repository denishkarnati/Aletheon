// Hostile-input limits: a datasheet, SVD or zip chosen by an attacker (or steered by prompt injection) must be refused or bounded,
// never exhaust memory or time. Also: serial ports are device names only, and a malformed JSON-RPC line cannot kill the MCP server.
// Run: npm run test:hardening   (builds dist/mcp.js first)
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { childEnv, run } from '../src/core/proc';
import { classifyTrust, weakestTrust } from '../src/core/provenance';
import { inRoot, resolveSource } from '../src/core/tools/context';
import { callTool, validateArgs } from '../src/core/tools';
import { registerTools } from '../src/core/tools/registers';
import { workspaceTools } from '../src/core/tools/workspace';
import { deflateRawSync } from 'node:zlib';
import { stripHtml } from '../src/core/docs';
import { parseSvd, readZipEntries } from '../src/core/svd';
import { hardwareTools } from '../src/core/tools/hardware';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const throws = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
};
const ms = (fn: () => void): number => {
  const t = Date.now();
  fn();
  return Date.now() - t;
};

// ---- HTML text extraction stays linear -------------------------------------------------------------------------------------
check(
  'stripHtml: tags, script and style are removed, text is kept',
  stripHtml('<p>Hello <b>world</b></p><script>var x="<b>";</script><style>p{}</style>tail') === 'Hello world tail',
);
check('stripHtml: a stray "<" with no ">" keeps the text', stripHtml('a < b') === 'a < b');
check('stripHtml: an unterminated <script> drops the rest instead of hanging', stripHtml('before<script>alert(1)') === 'before');
check('stripHtml: 200,000 "<" characters finish quickly (was ~38 s)', ms(() => stripHtml('<'.repeat(200_000))) < 1000);
check('stripHtml: 40,000 unterminated <script tags finish quickly (was ~3 s)', ms(() => stripHtml('<script '.repeat(40_000))) < 1000);

// ---- SVD expansion is bounded ---------------------------------------------------------------------------------------------
const svd = (regs: string, periph = ''): string =>
  `<device><name>D</name><peripherals><peripheral><name>P</name>${periph}<baseAddress>0x40000000</baseAddress><registers>${regs}</registers></peripheral></peripherals></device>`;
const reg = (name: string, extra = ''): string => `<register><name>${name}</name><addressOffset>0x0</addressOffset><size>32</size>${extra}</register>`;
check(
  'svd: a normal dim array still expands',
  parseSvd('t', svd(reg('R%s', '<dim>4</dim><dimIncrement>4</dimIncrement>'))).peripherals[0].registers.length === 4,
);
check(
  'svd: <dim>100000000</dim> is refused',
  throws(() => parseSvd('t', svd(reg('R%s', '<dim>100000000</dim><dimIncrement>4</dimIncrement>'))), /dim/),
);
check(
  'svd: a huge dimIndex range is refused',
  throws(() => parseSvd('t', svd(reg('R%s', '<dim>4</dim><dimIncrement>4</dimIncrement><dimIndex>0-99999999</dimIndex>'))), /dimIndex|dim/),
);
const bomb = Array.from({ length: 4000 }, (_, i) =>
  reg(`R${i}`, '<fields><field><name>F%s</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><dim>4096</dim><dimIncrement>0</dimIncrement></field></fields>'),
).join('');
check(
  'svd: nested arrays that multiply (4000 registers x 4096 fields) hit the total budget',
  throws(() => parseSvd('t', svd(bomb)), /more than/),
);

// ---- zip bomb ---------------------------------------------------------------------------------------------------------------
function zipOf(name: string, data: Buffer): Buffer {
  const raw = deflateRawSync(data);
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(raw.length, 20);
  central.writeUInt16LE(nm.length, 28);
  const cdOffset = local.length + nm.length + raw.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nm.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nm, raw, central, nm, eocd]);
}
check(
  'zip: a normal deflated entry is read',
  readZipEntries(zipOf('a.svd', Buffer.from('hello')))[0]
    .data()
    .toString() === 'hello',
);
const zb = zipOf('bomb.svd', Buffer.alloc(80 * 1024 * 1024));
check(
  `zip: an ${(zb.length / 1024).toFixed(0)} KB archive that inflates to 80 MB is refused (limit 64 MB)`,
  throws(() => readZipEntries(zb)[0].data(), /larger|too large|maxOutputLength|Cannot create/i),
);

// ---- serial ports are device names, not URLs ----------------------------------------------------------------------------------
const tool = (n: string) => hardwareTools.find((t) => t.name === n)!;
const refuse = async (n: string, port: unknown): Promise<boolean> => /^Refused/.test(String(await tool(n).run({ port } as never, {} as never)));
async function serialChecks(): Promise<void> {
  for (const p of [
    'socket://10.0.0.5:6379',
    'rfc2217://host:2217',
    'loop://',
    'hwgrep://x',
    '--upload-port',
    'COM5; calc',
    '/dev/../etc/passwd',
    'COM',
    '',
    'file:///etc/passwd',
  ])
    check(`serial_capture refuses port "${p}"`, await refuse('serial_capture', p));
  check('flash refuses a URL-style port before any prompt', await refuse('flash', 'socket://10.0.0.5:6379'));
}

// ---- MCP server survives malformed JSON-RPC ------------------------------------------------------------------------------------
const server = path.resolve(__dirname, 'mcp.js');
const input = ['null', '42', '[]', '"x"', '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}'].join('\n') + '\n';
const r = spawnSync(process.execPath, [server], { input, encoding: 'utf8', timeout: 20_000 });
const replies = r.stdout
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
check(
  'mcp: null, number, array and string lines get an Invalid Request error each',
  replies.filter((x) => x.error?.code === -32600).length === 4,
  r.stdout.slice(0, 300) + r.stderr.slice(0, 300),
);
check(
  'mcp: the server is still alive and answers the next real request',
  replies.some((x) => x.id === 7 && x.result?.protocolVersion),
  r.stdout.slice(0, 300),
);

// ---- file tools: confinement, links, credentials, protected paths, approval prompt ---------------------------------------------
async function fileChecks(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheon-files-'));
  const root = path.join(base, 'project');
  const outsideDir = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET');
  fs.writeFileSync(path.join(root, 'src', 'main.c'), 'int main(void){return 0;}\n');
  fs.writeFileSync(path.join(root, '..foo'), 'dots');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(50_000));
  const prompts: string[] = [];
  let answer = true;
  const ctx = { host: { root, storeDir: path.join(root, '.aletheon'), confirm: async (m: string) => (prompts.push(m), answer) } } as never;
  const tool = (n: string) => workspaceTools.find((t) => t.name === n)!;
  const fails = async (p: Promise<unknown>, re: RegExp): Promise<boolean> =>
    p.then(
      () => false,
      (e: Error) => re.test(e.message),
    );

  check(
    'inRoot: a normal file and a file literally named "..foo" are allowed',
    inRoot(ctx, 'src/main.c').endsWith('main.c') && inRoot(ctx, '..foo').endsWith('..foo'),
  );
  check(
    'inRoot: ../ and absolute paths outside are refused',
    throwsSync(() => inRoot(ctx, '../outside/secret.txt'), /escapes/) && throwsSync(() => inRoot(ctx, path.join(outsideDir, 'secret.txt')), /escapes/),
  );

  const link = path.join(root, 'link');
  fs.symlinkSync(outsideDir, link, 'junction');
  check(
    'link: reading through a symlink/junction that leads outside is refused',
    await fails(tool('read_file').run({ path: 'link/secret.txt' }, ctx), /through a link/),
  );
  check(
    'link: creating a new file under such a link is refused',
    throwsSync(() => inRoot(ctx, 'link/new.txt'), /through a link/),
  );
  check('link: listing the linked directory is refused', await fails(tool('list_dir').run({ path: 'link' }, ctx), /through a link/));
  fs.rmSync(outsideDir, { recursive: true, force: true });
  check(
    'link: a link that points nowhere is refused (not followed on write)',
    throwsSync(() => inRoot(ctx, 'link/new.txt'), /nowhere|through a link/),
  );
  fs.rmSync(link, { force: true, recursive: true });

  check('read_file: a normal file is read', (await tool('read_file').run({ path: 'src/main.c' }, ctx)).includes('int main'));
  const big = await tool('read_file').run({ path: 'big.txt' }, ctx);
  check('read_file: a 50 KB file is cut at 20 KB with a marker', big.startsWith('x'.repeat(100)) && big.length < 20_100 && big.includes('truncated'));
  check('read_file: a directory is not a regular file', await fails(tool('read_file').run({ path: 'src' }, ctx), /not a regular file/));
  for (const p of ['.env', '.env.production', 'cfg/id_rsa', '.git/config', 'keys/server.pem', '.npmrc', 'a/.aws/credentials', 'x.key']) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), 'k');
    check(`read_file refuses ${p}`, await fails(tool('read_file').run({ path: p }, ctx), /credentials file/));
  }
  check(
    'indexing a local .env as a datasheet source is refused',
    throwsSync(() => resolveSource(ctx, '.env'), /credentials file/),
  );
  check('a URL source passes through to the network guard', resolveSource(ctx, 'https://example.com/x.pdf') === 'https://example.com/x.pdf');

  for (const p of ['.aletheon/ledger.jsonl', '.aletheon/docs/x.json', '.git/hooks/pre-commit', 'sub/.git/config', '.env'])
    check(
      `write_file refuses ${p} without even asking`,
      (await fails(tool('write_file').run({ path: p, content: 'x' }, ctx), /refused/)) && prompts.length === 0,
    );
  const out = await tool('write_file').run({ path: 'src/./gen/../out.c', content: 'int a;‮\u0007\n' }, ctx);
  check(
    'write_file: the prompt shows the normalised path, size and the content',
    out.replace(/\\/g, '/') === 'Wrote src/out.c' && /Write src[\\/]out\.c \(\d+ bytes\)\?/.test(prompts[0]) && prompts[0].includes('int a;'),
    prompts[0],
  );
  check('write_file: control characters are stripped from the preview', !prompts[0].includes('\u0007'));
  check('write_file: an ordinary source file carries no code-execution warning', !prompts[0].includes('⚠'));
  await tool('write_file').run({ path: 'platformio.ini', content: '[env]\nextra_scripts = pre:evil.py\n' }, ctx);
  check('write_file: platformio.ini (runs code at build) is flagged', prompts[1].includes('⚠') && prompts[1].includes('extra_scripts'), prompts[1]);
  answer = false;
  check(
    'write_file: declining writes nothing',
    (await tool('write_file').run({ path: 'declined.c', content: 'x' }, ctx)).includes('declined') && !fs.existsSync(path.join(root, 'declined.c')),
  );
  check(
    'write_file: non-string arguments are rejected before any prompt',
    (await fails(tool('write_file').run({ path: 'a.c', content: 5 }, ctx), /string/)) && prompts.length === 3,
  );
  fs.rmSync(base, { recursive: true, force: true });
}
const throwsSync = (fn: () => unknown, re: RegExp): boolean => throws(fn, re);

// ---- child processes, trust, header includes, argument validation ----------------------------------------------------------------
async function processChecks(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheon-proc-'));
  const win = process.platform === 'win32';
  const env = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'sk-ant-1',
    OPENAI_API_KEY: 'sk-2',
    ALETHEON_EMBED_KEY: 'k3',
    GITHUB_TOKEN: 'ghp_x',
    SUPABASE_SERVICE_ROLE_KEY: 's',
    MY_PASSWORD: 'p',
    PLATFORMIO_CORE_DIR: '/pio',
    HOME: '/h',
    LANG: 'C',
    RANDOM_APP_VAR: 'v',
  } as NodeJS.ProcessEnv;
  const e = childEnv(env, false);
  check(
    'childEnv: toolchain variables are kept (PATH, HOME, LANG, PLATFORMIO_*)',
    e.PATH === '/bin' && e.HOME === '/h' && e.LANG === 'C' && e.PLATFORMIO_CORE_DIR === '/pio',
  );
  check('childEnv: API keys, tokens and passwords are never passed', !Object.keys(e).some((k) => /KEY|TOKEN|PASSWORD/i.test(k)), Object.keys(e).join());
  check('childEnv: unrelated variables are dropped by default', !('RANDOM_APP_VAR' in e));
  check(
    'childEnv: a variable can be passed on purpose with ALETHEON_PASS_ENV',
    childEnv({ ...env, ALETHEON_PASS_ENV: 'random_app_var' }, false).RANDOM_APP_VAR === 'v',
  );
  check(
    'childEnv: on Windows the current directory is removed from the executable search',
    childEnv(env, true).NoDefaultCurrentDirectoryInExePath === '1' && childEnv(env, false).NoDefaultCurrentDirectoryInExePath === undefined,
  );

  const script = path.join(base, 'printenv.js');
  fs.writeFileSync(script, 'console.log(JSON.stringify(Object.keys(process.env)))');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENAI_API_KEY = 'sk-test';
  const r = await run('node', [script]);
  const keys: string[] = JSON.parse(r.out.trim().split('\n').pop() ?? '[]');
  check(
    'a real child process cannot see the API keys held by this process',
    r.code === 0 && keys.length > 0 && !keys.some((k) => /ANTHROPIC|OPENAI|KEY|TOKEN|SECRET/i.test(k)),
    r.out.slice(0, 200),
  );
  check(
    'a real child process still finds PATH',
    keys.some((k) => k.toUpperCase() === 'PATH'),
  );
  if (win) {
    fs.writeFileSync(path.join(base, 'plantedtool.cmd'), '@echo PLANTED_EXECUTED\r\n');
    const unguarded = { ...process.env };
    delete unguarded.NoDefaultCurrentDirectoryInExePath;
    const attack = spawnSync('plantedtool', { cwd: base, shell: true, env: unguarded, encoding: 'utf8' });
    check(
      'Windows (control): without the guard, cmd.exe really does run a tool planted in the working directory',
      attack.stdout.includes('PLANTED_EXECUTED'),
      attack.stdout + attack.stderr,
    );
    const p = await run('plantedtool', [], { cwd: base, timeoutMs: 10_000 });
    check('Windows: run() does not execute a tool planted in the working directory', !p.out.includes('PLANTED_EXECUTED') && p.code !== 0, p.out.slice(0, 200));
  }
  fs.rmSync(base, { recursive: true, force: true });

  check('trust: the vendor site is vendor-official', classifyTrust('https://www.st.com/resource/en/datasheet/stm32f401re.pdf') === 'vendor-official');
  for (const u of [
    'https://community.st.com/t5/x/y.pdf',
    'https://e2e.ti.com/cfs-file/x.pdf',
    'https://devzone.nordicsemi.com/attachment/x.pdf',
    'https://forum.arduino.cc/uploads/x.pdf',
    'https://github.com/espressif/esp-idf/files/123/x.pdf',
    'https://github.com/raspberrypi/pico-sdk/assets/1/x',
    'https://user-images.githubusercontent.com/1/x.png',
  ])
    check(`trust: ${u} is not vendor-official (anyone can post there)`, classifyTrust(u) === 'community-mirror');
  check(
    'trust: a redirect from a vendor URL to a community host ends up as the weaker class',
    weakestTrust(classifyTrust('https://www.ti.com/x.pdf'), classifyTrust('https://e2e.ti.com/x.pdf')) === 'community-mirror' &&
      weakestTrust('vendor-official', 'measured') === 'vendor-official',
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheon-hdr-'));
  fs.mkdirSync(path.join(root, 'inc'));
  const ctx = { host: { root, storeDir: path.join(root, '.aletheon'), getBoard: () => undefined }, ledger: { add: () => ({ id: 'E1' }) } } as never;
  const ch = registerTools.find((t) => t.name === 'check_header')!;
  for (const inc of [
    '#include "/etc/passwd"',
    '#include </etc/shadow>',
    '#include "C:\\\\Windows\\\\win.ini"',
    '#include "../../.ssh/id_rsa"',
    '  #  include_next "../x.h"',
    '#import "../../secret"',
  ]) {
    fs.writeFileSync(path.join(root, 'bad.h'), `int a;\n${inc}\n`);
    check(`check_header refuses ${JSON.stringify(inc)}`, /^Refused/.test(await ch.run({ path: 'bad.h' }, ctx)));
  }
  fs.writeFileSync(path.join(root, 'ok.h'), '#include <stdint.h>\n#include "inc/local.h"\n');
  check("check_header does not refuse system headers or files below the header's folder", !/^Refused/.test(await ch.run({ path: 'ok.h' }, ctx)));
  fs.rmSync(root, { recursive: true, force: true });

  const schema = { type: 'object', properties: { port: { type: 'string' }, baud: { type: 'number' }, list: { type: 'array' } }, required: ['port'] };
  check(
    'validateArgs: valid arguments pass; numbers sent as strings are accepted',
    validateArgs(schema, { port: 'COM5', baud: 115200 }) === undefined && validateArgs(schema, { port: 'COM5', baud: '115200' }) === undefined,
  );
  check(
    'validateArgs: missing, wrong-typed and non-object arguments are described',
    /missing required argument "port"/.test(validateArgs(schema, {}) ?? '') &&
      /"port" must be a string/.test(validateArgs(schema, { port: 5 }) ?? '') &&
      /"baud" must be a number/.test(validateArgs(schema, { port: 'a', baud: 'fast' }) ?? '') &&
      /must be an object/.test(validateArgs(schema, null) ?? '') &&
      /"list" must be a array/.test(validateArgs(schema, { port: 'a', list: 'x' }) ?? ''),
  );
  const ctx2 = { host: { root: os.tmpdir(), confirm: async () => (prompted++, true) } } as never;
  let prompted = 0;
  const res = await callTool('write_file', { path: 'a.c', content: 42 }, ctx2);
  check('callTool: bad arguments are refused before any approval prompt', /^Error: invalid arguments for write_file/.test(res) && prompted === 0, res);
}

fileChecks()
  .then(processChecks)
  .then(serialChecks)
  .then(() => {
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
    process.exit(failed ? 1 : 0);
  });
