// Proves the website's browser port (site/assets/audit.js) behaves like the real TypeScript auditor (src/core/audit.ts):
//  1. named cases with expected statuses (the same cases test/audit.test.ts checks with forged evidence)
//  2. 4000 seeded random answers, compared claim-by-claim against the TypeScript implementation
// Run from the project root:  node site/tools/test-audit-port.mjs
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const port = require('../assets/audit.js');
const out = path.join(os.tmpdir(), 'aletheon-audit-ts.cjs');
buildSync({ entryPoints: ['src/core/audit.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
const ts = require(out);

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

const ledgerArr = [
  { id: 'E1', excerpt: 'RP2040 UART0.UARTFR: address 0x40034018 (base 0x40034000 + offset 0x018), 32 bit', trust: 'vendor-official' },
  { id: 'E2', excerpt: 'exit 0\nLinking .pio/build/pico/firmware.elf', trust: 'measured' },
  { id: 'E3', excerpt: 'The core runs at up to 133MHz and the pad supply is 3.30V.', trust: 'community-mirror' },
];
const fake = { get: (id) => ledgerArr.find((e) => e.id === id) };
const st = (t) => port.audit(t, ledgerArr);

// 1. named cases
check('supported claim passes', st('UARTFR is at 0x40034018 [E1].').ok);
check('hex normalization (padding, suffix)', st('UARTFR is at 0x040034018u [E1].').ok);
check('cited evidence lacks the value => unsupported', st('UARTFR is at 0x40034020 [E1].').counts.unsupported === 1);
check('citation laundering caught', st('UARTFR is at 0x40034018 [E2].').counts.unsupported === 1);
check('uncited value flagged', st('UARTFR is at 0x40034018.').counts.uncited === 1);
check('unknown citation flagged', st('UARTFR is at 0x40034018 [E99].').counts['unknown-citation'] === 1);
check('UNVERIFIED is honest', st('UARTFR address is UNVERIFIED; maybe 0x40034018.').ok);
check('units normalize (133 MHz vs 133MHz, 3.3 V vs 3.30V)', st('Max clock is 133 MHz and VDD is 3.3 V [E3].').ok);
check('multi-cite uses union', st('UARTFR 0x40034018 at 133 MHz [E1, E3].').ok);
const weak = st('Max clock is 133 MHz [E3].');
check('community-only support ok but weak', weak.ok && weak.weak === 1);
check('code blocks are not audited', st('```c\n#define X 0x12345678\n```\nDone.').claims.length === 0);
check('evidence ids are not values', st('See [E1] for details.').claims.length === 0);
check('pin claims need support', st('UART0 TX is on GPIO 0 [E1].').counts.unsupported === 1);

// 2. random parity against the TypeScript implementation
let seed = 20261026;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const values = [
  '0x40034018',
  '0x040034018u',
  '0x40034000',
  '0x40034004',
  '0x00000090UL',
  '0x18',
  '0x4003c000',
  '133 MHz',
  '133MHz',
  '3.3 V',
  '3.30V',
  '12 mA',
  '921600 baud',
  '1.2µs',
  '2 us',
  '125 MHz',
  'GPIO 4',
  'GPIO4',
  'PA5',
  'PB12',
  'PK3',
  '0xDEADBEEF',
  '16 kB',
  '500 ksps',
];
const cites = ['', '', ' [E1]', ' [E2]', ' [E3]', ' [E1, E2]', ' [E1, E3]', ' [E2,E3]', ' [E99]', ' [E4]', ' [E1, E99]'];
const heads = [
  'The register is at ',
  'It runs at ',
  'Reset value is ',
  'UARTFR sits at ',
  'Use ',
  'Supply is ',
  'The pin is ',
  'This is UNVERIFIED but maybe ',
];
const tails = ['.', '!', '?', '. Next see the docs.', '.\n', ''];
let n = 0,
  bad = 0,
  claimsSeen = 0;
for (let i = 0; i < 4000; i++) {
  const nSent = 1 + Math.floor(rnd() * 4);
  let text = '';
  for (let s = 0; s < nSent; s++) {
    const nv = Math.floor(rnd() * 3);
    let sent = pick(heads);
    for (let v = 0; v < nv; v++) sent += (v ? ' and ' : '') + pick(values);
    if (!nv) sent += 'something generic';
    sent += pick(cites) + pick(tails);
    text += sent + ' ';
  }
  if (rnd() < 0.1) text += '\n```c\n#define R 0x1234abcd\n```\nTail 0x40034018 [E1].';
  const a = port.audit(text, ledgerArr),
    b = ts.auditClaims(text, fake);
  n++;
  claimsSeen += a.claims.length;
  const same =
    JSON.stringify(a.counts) === JSON.stringify(b.counts) &&
    a.weak === b.weak &&
    a.ok === b.ok &&
    a.claims.length === b.claims.length &&
    a.claims.every(
      (c, k) =>
        c.status === b.claims[k].status &&
        c.sentence === b.claims[k].sentence &&
        !!c.weakSource === !!b.claims[k].weakSource &&
        JSON.stringify(c.missing ?? []) === JSON.stringify(b.claims[k].missing ?? []),
    );
  if (!same) {
    bad++;
    if (bad <= 3) console.log('  MISMATCH on:', JSON.stringify(text), '\n   port:', JSON.stringify(a.counts), '\n   ts:  ', JSON.stringify(b.counts));
  }
}
check(`${n} random answers (${claimsSeen} claims) agree with the TypeScript auditor`, bad === 0, `${bad} mismatches`);
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
