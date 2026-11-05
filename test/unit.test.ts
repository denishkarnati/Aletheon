// Offline unit tests for the SVD parser, CMSIS-Pack reader, header generator, argument safety and provider backoff.
// No network, no toolchain: these run anywhere in a few hundred ms.
// Run: npm run test:unit
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { BOARDS, findBoard } from '../src/core/boards';
import schema from '../src/core/boards.schema.json';
import { generateRegsHeader } from '../src/core/driver';
import { Ledger } from '../src/core/evidence';
import { safeArg } from '../src/core/proc';
import { retryDelayMs } from '../src/core/providers';
import { parseNum, parseSvd, readZipEntries } from '../src/core/svd';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

// A small synthetic device exercising the SVD features vendors actually use.
const SVD = `<?xml version="1.0"?>
<device>
  <name>TESTCHIP</name>
  <size>32</size><access>read-write</access><resetValue>0</resetValue>
  <peripherals>
    <peripheral>
      <name>UART0</name><baseAddress>0x40001000</baseAddress><description>Test UART</description>
      <registers>
        <register>
          <name>DR</name><addressOffset>0x0</addressOffset><resetValue>0x00000000</resetValue>
          <fields>
            <field><name>DATA</name><bitOffset>0</bitOffset><bitWidth>8</bitWidth></field>
            <field><name>OE</name><bitRange>[11:11]</bitRange></field>
          </fields>
        </register>
        <register>
          <name>FR</name><addressOffset>0x18</addressOffset><access>read-only</access><resetValue>0x90</resetValue>
          <fields>
            <field><name>BUSY</name><lsb>3</lsb><msb>3</msb></field>
            <field>
              <name>MODE</name><bitOffset>4</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>IDLE</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>RUN</name><value>#10</value></enumeratedValue>
              </enumeratedValues>
            </field>
          </fields>
        </register>
        <register derivedFrom="FR"><name>FR_ALIAS</name><addressOffset>0x18</addressOffset></register>
        <register><name>CH%s</name><dim>4</dim><dimIncrement>4</dimIncrement><addressOffset>0x20</addressOffset></register>
        <register><name>int</name><addressOffset>0x30</addressOffset><size>16</size></register>
        <cluster>
          <name>DMA[%s]</name><dim>2</dim><dimIncrement>0x10</dimIncrement><addressOffset>0x40</addressOffset>
          <register><name>CTRL</name><addressOffset>0x0</addressOffset></register>
          <register><name>CNT</name><addressOffset>0x4</addressOffset></register>
        </cluster>
      </registers>
    </peripheral>
    <peripheral derivedFrom="UART0"><name>UART1</name><baseAddress>0x40002000</baseAddress></peripheral>
    <peripheral>
      <name>TIMER%s</name><dim>2</dim><dimIncrement>0x100</dimIncrement><dimIndex>A,B</dimIndex><baseAddress>0x40010000</baseAddress>
      <registers><register><name>LOAD</name><addressOffset>0x0</addressOffset><size>64</size><resetValue>0xFFFFFFFFFFFF</resetValue></register></registers>
    </peripheral>
  </peripherals>
</device>`;

// Builds a real zip (one stored entry, one deflated entry) so the pack reader is tested on bytes, not mocks.
function makeZip(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function main(): void {
  // ---- parseNum: SVD scaledNonNegativeInteger
  check('parseNum decimal', parseNum('42') === 42);
  check('parseNum hex (0x/0X, +)', parseNum('0x1F') === 31 && parseNum('0X1f') === 31 && parseNum('+0x10') === 16);
  check('parseNum #binary', parseNum('#1010') === 10);
  check('parseNum rejects junk', parseNum('0xZZ') === undefined && parseNum('abc') === undefined && parseNum(undefined) === undefined);

  // ---- parseSvd
  const dev = parseSvd('test.svd', SVD);
  const u0 = dev.peripherals.find((p) => p.name === 'UART0')!;
  const reg = (n: string, p = u0) => p.registers.find((r) => r.name === n);
  check('device name', dev.name === 'TESTCHIP');
  check('register address = base + offset', reg('FR')?.address === 0x40001018 && reg('FR')?.offset === 0x18);
  check('register access + reset', reg('FR')?.access === 'read-only' && reg('FR')?.reset === 0x90);
  check('device defaults inherited', reg('DR')?.access === 'read-write' && reg('DR')?.size === 32);
  const fr = reg('FR')!;
  check(
    'field via lsb/msb',
    fr.fields.some((f) => f.name === 'BUSY' && f.lsb === 3 && f.msb === 3),
  );
  check(
    'field via bitRange',
    reg('DR')!.fields.some((f) => f.name === 'OE' && f.lsb === 11 && f.msb === 11),
  );
  check(
    'field via bitOffset/bitWidth',
    reg('DR')!.fields.some((f) => f.name === 'DATA' && f.lsb === 0 && f.msb === 7),
  );
  check('enumerated values kept', fr.fields.find((f) => f.name === 'MODE')?.enums?.length === 2);
  check('register derivedFrom copies fields', reg('FR_ALIAS')?.fields.length === fr.fields.length);
  const chs = u0.registers.filter((r) => /^CH\d$/.test(r.name)).map((r) => r.offset);
  check('dim register array expands %s', JSON.stringify(chs) === JSON.stringify([0x20, 0x24, 0x28, 0x2c]), JSON.stringify(chs));
  check('cluster array expands with prefix', reg('DMA1_CNT')?.offset === 0x54 && reg('DMA0_CTRL')?.offset === 0x40, u0.registers.map((r) => r.name).join(','));
  const u1 = dev.peripherals.find((p) => p.name === 'UART1');
  check('peripheral derivedFrom: same registers, own base', u1?.registers.length === u0.registers.length && reg('FR', u1)?.address === 0x40002018);
  const tb = dev.peripherals.find((p) => p.name === 'TIMERB');
  check('peripheral dimIndex list (A,B)', !!dev.peripherals.find((p) => p.name === 'TIMERA') && tb?.base === 0x40010100);
  let threw = false;
  try {
    parseSvd('x', '<notsvd/>');
  } catch {
    threw = true;
  }
  check('non-SVD XML is rejected', threw);

  // ---- CMSIS-Pack zip reader
  const zip = makeZip([
    { name: 'pdsc/Test.pdsc', data: Buffer.from('<package/>'), deflate: false },
    { name: 'SVD/TESTCHIP.svd', data: Buffer.from(SVD), deflate: true },
  ]);
  const entries = readZipEntries(zip);
  check('zip: both entries listed', entries.map((e) => e.name).join('|') === 'pdsc/Test.pdsc|SVD/TESTCHIP.svd');
  check('zip: stored entry reads back', entries[0].data().toString() === '<package/>');
  check('zip: deflated entry reads back byte-exact', entries[1].data().toString() === SVD);
  threw = false;
  try {
    readZipEntries(Buffer.from('not a zip at all, definitely not'));
  } catch {
    threw = true;
  }
  check('zip: garbage rejected', threw);

  // ---- header generator
  const g = generateRegsHeader(dev, u0, 'E3');
  const t = g.text;
  check('header: base macro', t.includes('#define UART0_BASE 0x40001000u'));
  check(
    'header: offset/addr/reg macros',
    t.includes('#define UART0_FR_OFFSET 0x018u') &&
      t.includes('#define UART0_FR_ADDR (UART0_BASE + UART0_FR_OFFSET)') &&
      t.includes('#define UART0_FR_REG (*(volatile uint32_t *)UART0_FR_ADDR)'),
  );
  check('header: reset value', t.includes('#define UART0_FR_RESET 0x00000090u'));
  check(
    'header: field Pos/Msk',
    t.includes('#define UART0_FR_BUSY_Pos 3u') && t.includes('#define UART0_FR_BUSY_Msk 0x00000008u') && t.includes('#define UART0_DR_DATA_Msk 0x000000FFu'),
  );
  check('header: enum values (decimal and #binary)', t.includes('#define UART0_FR_MODE_IDLE 0u') && t.includes('#define UART0_FR_MODE_RUN 2u'));
  check('header: evidence id stamped', t.includes('Evidence: [E3]'));
  check(
    'header: gap becomes reserved bytes',
    /uint8_t _reserved0\[20\];\n\s+volatile uint32_t FR;/.test(t),
    t.slice(t.indexOf('typedef'), t.indexOf('typedef') + 300),
  );
  check('header: overlapping alias left out of struct but keeps macros', g.skipped.includes('FR_ALIAS') && t.includes('#define UART0_FR_ALIAS_ADDR'));
  check('header: C keyword member renamed', /volatile uint16_t int_;/.test(t));
  check('header: layout assert per struct member', (t.match(/ALETHEON_ASSERT\(offsetof/g) ?? []).length === g.structMembers);
  check('header: guard balanced', t.includes('#ifndef ALETHEON_TESTCHIP_UART0_REGS_H') && t.trimEnd().endsWith('#endif /* ALETHEON_TESTCHIP_UART0_REGS_H */'));
  const g64 = generateRegsHeader(dev, tb!, 'E4').text;
  check('header: 64-bit register uses uint64_t and ULL', g64.includes('volatile uint64_t *') && g64.includes('0x0000FFFFFFFFFFFFULL'));
  const evil = parseSvd('x', SVD.replace('<name>DR</name>', '<name>DR</name><description>closes */ comment</description>'));
  check('header: description cannot close the comment', !generateRegsHeader(evil, evil.peripherals[0], 'E1').text.includes('closes */'));

  // ---- argument safety for spawned toolchains
  check('safeArg: ordinary paths and fqbn ok', safeArg('C:\\work\\fw', true) && safeArg('esp32:esp32:esp32s3', false) && safeArg('/dev/ttyUSB0', false));
  check('safeArg: shell metacharacters rejected', !safeArg('a;rm -rf', false) && !safeArg('$(id)', false) && !safeArg('a|b', true) && !safeArg('a&b', true));
  check('safeArg: % allowed on POSIX, rejected on Windows (cmd.exe expands %VAR%)', safeArg('100%', false) && !safeArg('%PATH%', true));

  // ---- provider backoff
  check('retry-after seconds honoured', retryDelayMs(0, '3') === 3000);
  check('retry-after capped at 60 s', retryDelayMs(0, '600') === 60_000);
  const d0 = retryDelayMs(0),
    d3 = retryDelayMs(3);
  check('exponential backoff without retry-after', d0 >= 1000 && d0 < 1250 && d3 >= 8000 && d3 < 8250, `${d0} ${d3}`);
  check('backoff capped at 30 s', retryDelayMs(10) < 30_250);

  // ---- evidence ledger (append-only JSON Lines)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-ledger-'));
  const lf = path.join(dir, 'ledger.json');
  const L1 = new Ledger(lf);
  const a1 = L1.add('svd', 'x.svd', 'first');
  const a2 = L1.add('build', 'pio run', 'exit 0');
  L1.setExcerpt(a1.id, 'first, updated');
  check('ledger: ids are sequential', a1.id === 'E1' && a2.id === 'E2');
  check('ledger: stored as JSON Lines next to the given path', fs.existsSync(lf + 'l') && !fs.existsSync(lf));
  const L2 = new Ledger(lf);
  check(
    'ledger: reload keeps entries and applies updates',
    L2.items.length === 2 && L2.get('E1')?.excerpt === 'first, updated' && L2.get('E2')?.trust === 'measured',
  );
  check('ledger: next id continues after reload', L2.add('user', 'chat', 'note').id === 'E3');
  fs.appendFileSync(lf + 'l', '{"id":"E4","kind":"svd","sou'); // torn write
  const L3 = new Ledger(lf);
  check('ledger: torn final line is skipped, earlier entries survive', L3.items.length === 3 && L3.add('user', 'chat', 'after crash').id === 'E4');
  const legacy = path.join(dir, 'old', 'ledger.json');
  fs.mkdirSync(path.dirname(legacy));
  fs.writeFileSync(
    legacy,
    JSON.stringify([{ id: 'E1', kind: 'svd', source: 's', excerpt: 'legacy', ts: '2026-01-01T00:00:00.000Z', trust: 'vendor-official' }]),
  );
  const L4 = new Ledger(legacy);
  check(
    'ledger: legacy ledger.json migrated once',
    L4.get('E1')?.excerpt === 'legacy' && fs.existsSync(legacy + 'l') && fs.existsSync(legacy + '.migrated') && !fs.existsSync(legacy),
  );
  check('ledger: migrated ledger reloads from JSONL', new Ledger(legacy).items.length === 1);

  // ---- board registry (src/core/boards.json against boards.schema.json's rules)
  const allowed = new Set(Object.keys(schema.properties.boards.items.properties));
  const required: string[] = schema.properties.boards.items.required;
  const toolchains = new Set<string>(schema.properties.boards.items.properties.toolchains.items.enum);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const b of BOARDS as unknown as Record<string, any>[]) {
    for (const k of required) if (b[k] === undefined) problems.push(`${b.id}: missing ${k}`);
    for (const k of Object.keys(b)) if (!allowed.has(k)) problems.push(`${b.id}: unknown field ${k}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(b.id)) problems.push(`${b.id}: bad id`);
    if (seen.has(b.id)) problems.push(`${b.id}: duplicate id`);
    seen.add(b.id);
    if (!b.toolchains?.length || b.toolchains.some((t: string) => !toolchains.has(t))) problems.push(`${b.id}: bad toolchains`);
    if (b.toolchains?.includes('arduino-cli') && !b.fqbn) problems.push(`${b.id}: arduino-cli needs fqbn`);
    if (b.toolchains?.includes('platformio') && !b.pioBoard) problems.push(`${b.id}: platformio needs pioBoard`);
    if (!Number.isInteger(b.baud) || b.baud < 300) problems.push(`${b.id}: bad baud`);
    for (const u of [b.svd, ...(b.docs ?? []).map((d: any) => d.url)].filter(Boolean))
      if (!/^https:\/\//.test(u)) problems.push(`${b.id}: non-https link ${u}`);
  }
  check('boards: registry entries valid against the schema rules', problems.length === 0, problems.join('; '));
  check(
    'boards: the six shipped boards are present',
    ['esp32-s3-devkitc-1', 'esp32-devkitc', 'rpi-pico', 'arduino-uno', 'nucleo-f401re', 'nrf52840-dk'].every((id) => !!findBoard(id)),
  );
  check('boards: unknown id is undefined, not a crash', findBoard('no-such-board') === undefined && findBoard(undefined) === undefined);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main();
