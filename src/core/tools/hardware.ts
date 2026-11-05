// Boards, toolchains and the physical board: list/detect boards, build, flash, serial capture.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BOARDS, Board, Toolchain } from '../boards';
import { run, tail } from '../proc';
import { Tool, ToolCtx, obj, str, writeFile } from './context';

const requireBoard = (ctx: ToolCtx): Board => {
  const b = ctx.host.getBoard();
  if (!b) throw new Error('No target board selected. Ask the user to select one (Aletheon: Select Target Board) or use list_boards.');
  return b;
};

function pickToolchain(ctx: ToolCtx, b: Board): Toolchain {
  const want = ctx.host.getToolchain();
  if (want !== 'auto') {
    if (!b.toolchains.includes(want)) throw new Error(`${b.name} has no ${want} mapping in the registry (has: ${b.toolchains.join(', ')})`);
    return want;
  }
  if (fs.existsSync(path.join(ctx.host.root, 'platformio.ini')) && b.toolchains.includes('platformio')) return 'platformio';
  if (fs.existsSync(path.join(ctx.host.root, 'CMakeLists.txt')) && b.toolchains.includes('esp-idf')) return 'esp-idf';
  return b.toolchains[0];
}

function toolchainCmds(tc: Toolchain, b: Board, root: string, port?: string): { build: [string, string[]]; flash: [string, string[]] } {
  switch (tc) {
    case 'platformio':
      return {
        build: ['pio', ['run', '-d', root]],
        flash: ['pio', ['run', '-d', root, '-t', 'upload', ...(port ? ['--upload-port', port] : [])]],
      };
    case 'arduino-cli':
      if (!b.fqbn) throw new Error(`no FQBN for ${b.name}`);
      return {
        build: ['arduino-cli', ['compile', '--fqbn', b.fqbn, root]],
        flash: ['arduino-cli', ['upload', '--fqbn', b.fqbn, ...(port ? ['-p', port] : []), root]],
      };
    case 'esp-idf':
      return {
        build: ['idf.py', ['-C', root, 'build']],
        flash: ['idf.py', ['-C', root, ...(port ? ['-p', port] : []), 'flash']],
      };
  }
}

// Board, toolchain and commands for build/flash on the selected board.
function projectCmds(ctx: ToolCtx, port?: string) {
  const b = requireBoard(ctx);
  const tc = pickToolchain(ctx, b);
  return { b, tc, ...toolchainCmds(tc, b, ctx.host.root, port) };
}

// pyserial treats socket://, rfc2217://, loop:// and hwgrep:// as URL handlers, which would open arbitrary network connections.
// Only a plain serial device name is accepted: COM5, /dev/ttyUSB0, /dev/cu.usbserial-0001.
const PORT_RE = /^(COM\d{1,3}|\/dev\/[\w./-]{1,60})$/;
const badPort = (p: unknown): string | undefined =>
  typeof p === 'string' && PORT_RE.test(p) && !p.includes('..')
    ? undefined
    : `Refused: "${String(p).slice(0, 60)}" is not a serial device name (expected COM5 or /dev/ttyUSB0).`;

const SERIAL_PY = `import sys,time,serial
port,baud,secs=sys.argv[1],int(sys.argv[2]),float(sys.argv[3])
s=serial.Serial(port,baud,timeout=0.2)
end=time.time()+secs
buf=b''
while time.time()<end:
    buf+=s.read(4096)
sys.stdout.write(buf.decode('utf-8','replace'))
`;

export const hardwareTools: Tool[] = [
  {
    name: 'list_boards',
    description: 'List boards in the registry and which one is currently selected.',
    input_schema: obj({}),
    async run(_a, ctx) {
      const sel = ctx.host.getBoard()?.id;
      return BOARDS.map((b) => `${b.id}${b.id === sel ? ' (selected)' : ''}: ${b.name}, MCU ${b.mcu}, toolchains ${b.toolchains.join('/')}`).join('\n');
    },
  },
  {
    name: 'detect_boards',
    description: 'Detect boards/serial ports physically connected right now (arduino-cli, then PlatformIO, then pyserial). Real hardware state only.',
    input_schema: obj({}),
    async run(_a, ctx) {
      const attempts: [string, string[]][] = [
        ['arduino-cli', ['board', 'list', '--format', 'json']],
        ['pio', ['device', 'list', '--json-output']],
        ['python', ['-m', 'serial.tools.list_ports', '-v']],
      ];
      for (const [cmd, args] of attempts) {
        const r = await run(cmd, args, { timeoutMs: 30_000 });
        if (r.code === 0 && r.out.trim()) {
          const e = ctx.ledger.add('serial', `${cmd} ${args.join(' ')}`, tail(r.out, 1400));
          return `[${e.id}] via ${cmd}:\n${tail(r.out, 3000)}`;
        }
      }
      return 'No detector succeeded (need arduino-cli, PlatformIO, or python with pyserial). No board state is known.';
    },
  },
  {
    name: 'build',
    description: 'Compile the workspace project for the selected board with its toolchain. Returns the real compiler output.',
    input_schema: obj({}),
    async run(_a, ctx) {
      const {
        tc,
        build: [cmd, args],
      } = projectCmds(ctx);
      const r = await run(cmd, args, { cwd: ctx.host.root, timeoutMs: 600_000 });
      const e = ctx.ledger.add('build', `${tc}: ${cmd} ${args.join(' ')}`, `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${tail(r.out, 1200)}`);
      return `[${e.id}] ${tc} build exit code ${r.code}\n${tail(r.out)}`;
    },
  },
  {
    name: 'flash',
    description: 'Flash the built firmware to the connected board. Physically changes hardware; the user must approve.',
    input_schema: obj({ port: str('serial port, e.g. COM5 or /dev/ttyUSB0') }),
    async run(a, ctx) {
      if (a.port !== undefined && badPort(a.port)) return badPort(a.port)!;
      const {
        b,
        tc,
        flash: [cmd, args],
      } = projectCmds(ctx, a.port);
      if (!(await ctx.host.confirm(`Flash ${b.name} via ${tc}${a.port ? ' on ' + a.port : ''}?`))) return 'User declined flashing.';
      const r = await run(cmd, args, { cwd: ctx.host.root, timeoutMs: 600_000 });
      const e = ctx.ledger.add('flash', `${tc}: ${cmd} ${args.join(' ')}`, `exit ${r.code}\n${tail(r.out, 1200)}`);
      return `[${e.id}] flash exit code ${r.code}\n${tail(r.out)}`;
    },
  },
  {
    name: 'serial_capture',
    description: 'Capture real output from the board over serial for N seconds. Use after flashing to verify behaviour with actual data.',
    input_schema: obj({ port: str('serial port'), baud: { type: 'number' }, seconds: { type: 'number' } }, ['port']),
    async run(a, ctx) {
      if (badPort(a.port)) return badPort(a.port)!;
      const b = ctx.host.getBoard();
      const baud = Math.trunc(a.baud ?? b?.baud ?? 115200);
      const secs = Math.min(Number(a.seconds ?? 5), 60);
      const script = path.join(ctx.host.storeDir, 'serial_capture.py');
      writeFile(script, SERIAL_PY);
      const r = await run('python', [script, a.port, String(baud), String(secs)], { timeoutMs: (secs + 15) * 1000 });
      if (r.code !== 0) return `Serial capture failed (need python + pyserial, correct port): ${tail(r.out, 800)}`;
      const e = ctx.ledger.add('serial', `${a.port} @ ${baud}, ${secs}s`, r.out || '(no bytes received)');
      return `[${e.id}] captured from ${a.port} @ ${baud}:\n${tail(r.out) || '(no bytes received)'}`;
    },
  },
];
