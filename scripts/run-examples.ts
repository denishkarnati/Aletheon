// Runs the worked examples in examples/<name>/ through the same tool layer the VS Code extension and the MCP server use,
// against real vendor files, and writes what actually happened to examples/<name>/TRANSCRIPT.md and evidence.json.
// Nothing in a transcript is hand-written: every output block is the tool's return value from this run.
//   npm run examples            all examples
//   npm run examples -- rp2040  only examples whose name contains "rp2040"
// Writes are auto-approved here (the extension asks the user instead). No AI model is called.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findBoard } from '../src/core/boards';
import { run, tail } from '../src/core/proc';
import { ToolCtx, callTool, createToolCtx } from '../src/core/tools';

type Step =
  | { note: string; tool: string; args: Record<string, unknown>; as?: string; keep?: number }
  | { note: string; compile: { file: string; target: string; cpu: string }; as?: string };

interface Example {
  name: string;
  title: string;
  board: string;
  intro: string;
  steps: Step[];
  outro: string;
}

const RP2040_SVD = 'https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/rp2040/hardware_regs/RP2040.svd';
const RP2040_DS = 'https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf';
const STM32F401_SVD = 'https://raw.githubusercontent.com/modm-io/cmsis-svd-stm32/main/stm32f4/STM32F401.svd';
const STM32F401_DS = 'https://www.st.com/resource/en/datasheet/stm32f401re.pdf';
const NRF52840_SVD = 'https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/Nordic/nrf52840.svd';
const ESP32S3_SVD = 'https://raw.githubusercontent.com/espressif/svd/main/svd/esp32s3.svd';

// {{name}} in a later step's args is replaced by the first [E#] that step `as: name` returned.
const EXAMPLES: Example[] = [
  {
    name: 'rp2040-uart-driver',
    title: 'RP2040 (Raspberry Pi Pico): UART0 driver from SVD to compiled Cortex-M0+ object',
    board: 'rpi-pico',
    intro:
      'The full driver workflow up to the point where real hardware is needed: index the vendor register map and datasheet, look up and cross-check ' +
      'the registers the driver touches, generate register headers, compile them, then compile a driver that uses only the generated macros for a ' +
      'Cortex-M0+ target. Flashing and serial capture are not part of this run (no board attached), so behaviour on hardware is not claimed.',
    steps: [
      { note: 'Parse the vendor CMSIS-SVD register map.', tool: 'index_svd', args: { source: RP2040_SVD }, as: 'svd' },
      { note: 'Index the vendor datasheet (keyword search with page numbers).', tool: 'index_datasheet', args: { source: RP2040_DS }, as: 'ds' },
      {
        note: 'Look up the flag register the driver polls.',
        tool: 'lookup_register',
        args: { device: 'RP2040', peripheral: 'UART0', register: 'UARTFR' },
        as: 'fr',
        keep: 1,
      },
      {
        note: 'Look up the reset controller bit that holds UART0 in reset.',
        tool: 'lookup_register',
        args: { device: 'RP2040', peripheral: 'RESETS', register: 'RESET', field: 'uart0' },
        as: 'reset',
        keep: 1,
      },
      {
        note: 'Check the SVD address of UARTFR against the datasheet text.',
        tool: 'cross_check_register',
        args: { peripheral: 'UART0', register: 'UARTFR' },
        as: 'xfr',
      },
      { note: 'Check UARTIBRD (integer baud divisor) the same way.', tool: 'cross_check_register', args: { peripheral: 'UART0', register: 'UARTIBRD' } },
      {
        note: 'Find the baud-rate divisor rule in the datasheet.',
        tool: 'search_datasheets',
        args: { query: 'UARTIBRD UARTFBRD baud rate divisor', k: 2 },
        as: 'baud',
      },
      {
        note: 'Check the init-order rule the driver relies on (when do new divisors take effect?). First try: both hits are register tables, so the rule is not found yet and must not be cited.',
        tool: 'search_datasheets',
        args: { query: 'UARTLCR_H write UARTIBRD UARTFBRD updated', k: 2 },
      },
      {
        note: 'Second try with fewer, rarer words (keyword search ranks exact terms). This finds the rule.',
        tool: 'search_datasheets',
        args: { query: 'LCR_H latch divisors', k: 1 },
        as: 'latch',
      },
      { note: 'Generate the UART0 register header.', tool: 'generate_regs_header', args: { peripheral: 'UART0', path: 'include/gen/uart0_regs.h' } },
      {
        note: 'Generate the RESETS header (to take UART0 out of reset).',
        tool: 'generate_regs_header',
        args: { peripheral: 'RESETS', path: 'include/gen/resets_regs.h' },
      },
      {
        note: 'Generate the IO_BANK0 header (GPIO function select).',
        tool: 'generate_regs_header',
        args: { peripheral: 'IO_BANK0', path: 'include/gen/io_bank0_regs.h' },
      },
      { note: 'Compile the UART0 header on the host, including its layout asserts.', tool: 'check_header', args: { path: 'include/gen/uart0_regs.h' } },
      { note: 'Compile the RESETS header.', tool: 'check_header', args: { path: 'include/gen/resets_regs.h' } },
      { note: 'Compile the IO_BANK0 header.', tool: 'check_header', args: { path: 'include/gen/io_bank0_regs.h' } },
      {
        note: 'Cross-compile the driver (src/uart0.c, written against the generated macros) for Cortex-M0+.',
        compile: { file: 'src/uart0.c', target: 'thumb-freestanding-eabi', cpu: 'cortex_m0plus' },
        as: 'cc',
      },
      {
        note: 'Audit a correct, cited answer.',
        tool: 'audit_claims',
        args: { text: 'UART0 UARTFR is at 0x40034018 [{{fr}}]. The driver cross-compiled for Cortex-M0+ with no warnings [{{cc}}].' },
      },
      {
        note: 'Audit a wrong answer that cites real evidence (citation laundering).',
        tool: 'audit_claims',
        args: { text: 'UART0 UARTFR is at 0x40034020 [{{fr}}].' },
      },
      {
        note: 'Audit an answer with no citations at all.',
        tool: 'audit_claims',
        args: { text: 'UART0 UARTFR is at 0x40034018 and the core runs at 133 MHz.' },
      },
    ],
    outro:
      'What this proves: the addresses and bit positions in the driver come from the vendor SVD (vendor-official, hash recorded), the headers compile ' +
      'with their layout asserts, and the driver compiles for the real CPU. What it does not prove: that the driver transmits bytes on a Pico. That ' +
      'needs `flash` and `serial_capture` on a board, which would add `measured` evidence.',
  },
  {
    name: 'stm32f401-gpio-header',
    title: 'STM32F401 (Nucleo-F401RE): GPIOA header and an electrical-value claim from the datasheet',
    board: 'nucleo-f401re',
    intro:
      'Register headers from a community-maintained SVD, plus a datasheet search for an electrical value. Shows how trust classes differ: the SVD is a ' +
      'community mirror, the datasheet is vendor-official, and the audit says so.',
    steps: [
      { note: 'Parse the STM32F401 SVD (community-maintained mirror).', tool: 'index_svd', args: { source: STM32F401_SVD }, as: 'svd' },
      { note: 'Index the ST datasheet.', tool: 'index_datasheet', args: { source: STM32F401_DS } },
      {
        note: 'Look up the GPIOA mode register.',
        tool: 'lookup_register',
        args: { device: 'STM32F401', peripheral: 'GPIOA', register: 'MODER' },
        as: 'moder',
        keep: 1,
      },
      { note: 'Generate and compile the GPIOA header.', tool: 'generate_regs_header', args: { peripheral: 'GPIOA', path: 'include/gen/gpioa_regs.h' } },
      { note: '', tool: 'check_header', args: { path: 'include/gen/gpioa_regs.h' } },
      {
        note: 'Search the datasheet for the supply range.',
        tool: 'search_datasheets',
        args: { query: 'operating voltage VDD 1.7 V to 3.6 V', k: 2 },
        as: 'vdd',
      },
      {
        note: 'Audit a claim that rests on the community-mirror SVD alone.',
        tool: 'audit_claims',
        args: { text: 'GPIOA MODER is at 0x40020000 [{{moder}}].' },
      },
      {
        note: 'Audit a voltage claim citing the top search hit. The passage is the operating-conditions table, but its excerpt does not contain "1.7 V", so the audit refuses it.',
        tool: 'audit_claims',
        args: { text: 'The STM32F401 runs from 1.7 V to 3.6 V [{{vdd}}].' },
      },
      {
        note: "Search again with the datasheet's own wording.",
        tool: 'search_datasheets',
        args: { query: 'application supply 1.7 V to 3.6 V', k: 1 },
        as: 'vdd2',
      },
      {
        note: 'Audit the same claim citing the passage that actually states it.',
        tool: 'audit_claims',
        args: { text: 'The STM32F401 runs from 1.7 V to 3.6 V [{{vdd2}}].' },
      },
    ],
    outro:
      "The address claim passes but is flagged weak: it rests only on a community mirror. To make it strong, index ST's own CMSIS pack " +
      '(`index_svd` with a .pack and `entry`) or cross-check against the reference manual (RM0368). The voltage claim shows the audit doing its ' +
      'job: citing a nearby passage is not enough, the cited text has to contain the value.',
  },
  {
    name: 'nrf52840-uarte-header',
    title: 'nRF52840: UARTE0 header (large peripheral, overlapping registers)',
    board: 'nrf52840-dk',
    intro:
      'A large, sparse peripheral (tasks at 0x000, events at 0x100, configuration from 0x500): the struct needs many reserved gaps, each proven by a layout assert.',
    steps: [
      { note: 'Parse the nRF52840 SVD.', tool: 'index_svd', args: { source: NRF52840_SVD } },
      { note: 'Look up the baud-rate register.', tool: 'lookup_register', args: { device: 'nrf52840', peripheral: 'UARTE0', register: 'BAUDRATE' }, keep: 1 },
      { note: 'Generate and compile the UARTE0 header.', tool: 'generate_regs_header', args: { peripheral: 'UARTE0', path: 'include/gen/uarte0_regs.h' } },
      { note: '', tool: 'check_header', args: { path: 'include/gen/uarte0_regs.h' } },
    ],
    outro:
      'All 34 registers fit in the struct with no overlaps, and the compiler checked each offset. On a peripheral with aliased registers, the ' +
      'overlapping ones keep their _ADDR/_REG macros and are left out of the struct (the unit tests cover that case).',
  },
  {
    name: 'esp32s3-gpio-header',
    title: "ESP32-S3: GPIO header from Espressif's SVD",
    board: 'esp32-s3-devkitc-1',
    intro: 'Xtensa target: the header is checked on the host compiler (layout asserts are target-independent for fixed-width types).',
    steps: [
      { note: 'Parse the Espressif SVD.', tool: 'index_svd', args: { source: ESP32S3_SVD } },
      {
        note: 'Look up the GPIO output-enable register.',
        tool: 'lookup_register',
        args: { device: 'ESP32-S3', peripheral: 'GPIO', register: 'ENABLE' },
        keep: 1,
      },
      { note: 'Generate and compile the GPIO header.', tool: 'generate_regs_header', args: { peripheral: 'GPIO', path: 'include/gen/gpio_regs.h' } },
      { note: '', tool: 'check_header', args: { path: 'include/gen/gpio_regs.h' } },
    ],
    outro: 'Building an ESP-IDF project with this header needs `idf.py`; that step is not part of this run.',
  },
];

const fence = (s: string): string => '```text\n' + s.replace(/```/g, "'''") + '\n```';
// Datasheet passages are vendor text: keep transcripts to short quotes and leave the full text in the local ledger.
const clipPassages = (s: string): string =>
  s.replace(/(page \d+:\n)([\s\S]*?)(?=\n\n\[E\d+\]|$)/g, (_m, h, body) => h + (body.length > 360 ? body.slice(0, 360) + ' …[clipped]' : body));
const firstId = (s: string): string | undefined => s.match(/\[(E\d+)\]/)?.[1];
const fill = (v: unknown, ids: Map<string, string>): unknown =>
  typeof v === 'string'
    ? v.replace(/\{\{(\w+)\}\}/g, (_m, k) => ids.get(k) ?? `E?${k}`)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ids)]))
      : v;

async function compileFor(ctx: ToolCtx, c: { file: string; target: string; cpu: string }): Promise<string> {
  const obj = path.join(ctx.host.storeDir, path.basename(c.file) + '.o');
  const args = [
    '-m',
    'ziglang',
    'cc',
    '-target',
    c.target,
    `-mcpu=${c.cpu}`,
    '-std=c11',
    '-Os',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Iinclude',
    '-c',
    c.file,
    '-o',
    obj,
  ];
  fs.rmSync(obj, { force: true });
  const r = await run('python', args, { cwd: ctx.host.root, timeoutMs: 120_000 });
  const size = fs.existsSync(obj) ? `object ${fs.statSync(obj).size} bytes` : 'no object produced';
  const e = ctx.ledger.add('build', `zig cc -target ${c.target} -mcpu=${c.cpu} -c ${c.file}`, `exit ${r.code}; ${size}\n${tail(r.out, 1200)}`);
  return `[${e.id}] cross-compile exit ${r.code}; ${size}\n${tail(r.out) || '(clean: no warnings, no errors)'}`;
}

async function runExample(ex: Example, repo: string): Promise<boolean> {
  const root = path.join(repo, 'examples', ex.name);
  const storeDir = path.join(root, '.aletheon');
  fs.rmSync(path.join(storeDir, 'ledger.jsonl'), { force: true }); // fresh ledger: E1 is this run's first evidence
  fs.rmSync(path.join(root, 'include', 'gen'), { recursive: true, force: true });
  const ctx = createToolCtx({
    root,
    storeDir,
    getBoard: () => findBoard(ex.board),
    getToolchain: () => 'auto',
    getEmbedder: async () => undefined, // keyword search: reproducible without a model
    confirm: async () => true,
    log: () => {},
  });
  const ids = new Map<string, string>();
  const out: string[] = [
    `# ${ex.title}`,
    '',
    `> Generated by \`npm run examples\` on ${new Date().toISOString().slice(0, 10)} (${os.platform()} ${os.arch()}, Node ${process.version}). ` +
      'Every output block below is the real return value of the tool named above it. Rerun the command to reproduce.',
    '',
    ex.intro,
    '',
    `Board: \`${ex.board}\`. Evidence ledger for this run: [evidence.json](evidence.json).`,
    '',
  ];
  let ok = true;
  let n = 0;
  for (const s of ex.steps) {
    const t0 = Date.now();
    let result: string;
    let label: string;
    if ('compile' in s) {
      label = `cross-compile \`${s.compile.file}\` (${s.compile.target}, ${s.compile.cpu})`;
      result = await compileFor(ctx, s.compile);
    } else {
      const args = fill(s.args, ids) as Record<string, unknown>;
      label = `\`${s.tool}\` ${JSON.stringify(args)}`;
      result = await callTool(s.tool, args, ctx);
      if (s.keep)
        result = result
          .split(/\n\n(?=\[E\d+\])/)
          .slice(0, s.keep)
          .join('\n\n');
    }
    const id = firstId(result);
    if (s.as && id) ids.set(s.as, id);
    if (result.startsWith('Error:') || /exit (?!0\b)-?\d+/.test(result.split('\n')[0])) ok = false;
    out.push(
      `## ${++n}. ${s.note || 'Continued'}`,
      '',
      label,
      '',
      fence(clipPassages(result)),
      '',
      `<sub>${((Date.now() - t0) / 1000).toFixed(1)} s</sub>`,
      '',
    );
    process.stdout.write(`  ${ex.name} step ${n}: ${result.split('\n')[0].slice(0, 110)}\n`);
  }
  out.push('## What this shows', '', ex.outro, '');
  fs.writeFileSync(path.join(root, 'TRANSCRIPT.md'), out.join('\n'));
  const ledger = ctx.ledger.items.map((e) => ({
    ...e,
    excerpt: e.kind === 'datasheet' && e.excerpt.length > 240 ? e.excerpt.slice(0, 240) + ' …[clipped]' : e.excerpt,
  }));
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(ledger, null, 2) + '\n');
  return ok;
}

async function main(): Promise<void> {
  const repo = path.resolve(__dirname, '..');
  const filter = process.argv[2];
  let failed = 0;
  for (const ex of EXAMPLES.filter((e) => !filter || e.name.includes(filter))) {
    console.log(`${ex.name}`);
    if (!(await runExample(ex, repo))) failed++;
  }
  console.log(failed ? `${failed} example(s) had a failing step; see TRANSCRIPT.md` : 'all examples completed');
  process.exit(failed ? 1 : 0);
}
main();
