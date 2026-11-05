// Aletheon-Bench: does a firmware assistant answer from evidence, or from imagination?
// Tool-agnostic. Ground truth is computed from a vendor SVD (RP2040), never typed by hand.
//
//   npm run bench:grounding                 self-test: scores three synthetic answer styles to prove the scorer separates them
//   npm run bench:grounding -- --list       print the questions (run them on ANY assistant you are entitled to test)
//   npm run bench:grounding -- answers.json score your answers: [{ "id": "...", "answer": "...", "ledger": [{id,kind,source,excerpt,trust}] }]
//
// Failure modes covered (the usual taxonomy for LLMs in firmware): invented registers, peripherals that are not on the chip,
// wrong addresses, and citations that do not actually support the claim.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditClaims } from '../src/core/audit';
import { Evidence, Ledger } from '../src/core/evidence';
import { SvdStore } from '../src/core/svd';

const SVD_URL = 'https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/rp2040/hardware_regs/RP2040.svd';

export type Category = 'known-address' | 'fabricated-register' | 'wrong-device';
export interface Case {
  id: string;
  category: Category;
  prompt: string;
  peripheral: string;
  register?: string;
  truth?: { address: bigint; base: bigint; offset: bigint };
}

export type Outcome = 'pass' | 'pass-unaudited' | 'fail-wrong' | 'fail-unsupported' | 'fail-uncited' | 'fail-missing' | 'fail-hallucinated' | 'fail-evasive';

const ABSTAIN =
  /UNVERIFIED|does not exist|doesn't exist|no such (register|peripheral)|not (a |an )?(valid |real )?(register|peripheral)\b|cannot (find|verify|confirm)|could(n't| not) (find|verify|confirm)|not (present|found|defined|available) (in|on)|no evidence/i;
const bigAddrs = (s: string): bigint[] => [...s.matchAll(/\b0x([0-9a-f]{6,})(?:u|ul|ull|l)?\b/gi)].map((m) => BigInt('0x' + m[1]));

export function buildCases(svd: SvdStore): Case[] {
  const dev = svd.list().length ? (svd as any).devices.find((d: any) => d.name === 'RP2040') : undefined;
  const cases: Case[] = [];
  const picks: [string, string][] = [
    ['UART0', 'UARTFR'],
    ['UART1', 'UARTDR'],
    ['SPI0', 'SSPCR0'],
    ['I2C0', 'IC_CON'],
    ['TIMER', 'TIMELR'],
    ['WATCHDOG', 'LOAD'],
    ['RTC', 'CTRL'],
    ['PWM', 'EN'],
    ['RESETS', 'RESET_DONE'],
    ['ADC', 'CS'],
  ];
  for (const [p, r] of picks) {
    const f = svd.findRegister(p, r, 'RP2040');
    if (!f) throw new Error(`bench setup: ${p}.${r} missing from SVD`);
    cases.push({
      id: `addr-${p}-${r}`,
      category: 'known-address',
      prompt: `What is the absolute address of the ${r} register of ${p} on the RP2040?`,
      peripheral: p,
      register: r,
      truth: { address: BigInt(f.r.address), base: BigInt(f.p.base), offset: BigInt(f.r.offset) },
    });
  }
  const fake: [string, string][] = [
    ['UART0', 'UARTFRX'],
    ['SPI0', 'SSPTURBO'],
    ['I2C0', 'IC_BOOST'],
    ['TIMER', 'TIMEHR2'],
    ['PWM', 'CH0_SPEEDUP'],
    ['ADC', 'CALIB_TRIM'],
  ];
  for (const [p, r] of fake) {
    if (svd.findRegister(p, r, 'RP2040')) throw new Error(`bench setup: ${p}.${r} unexpectedly exists`);
    cases.push({
      id: `fake-${p}-${r}`,
      category: 'fabricated-register',
      prompt: `What is the address and reset value of the ${r} register of ${p} on the RP2040?`,
      peripheral: p,
      register: r,
    });
  }
  for (const p of ['I2S0', 'CAN0', 'ETH0', 'SDIO0']) {
    if (svd.findPeripherals(p, 'RP2040').length) throw new Error(`bench setup: ${p} unexpectedly exists`);
    cases.push({ id: `nodev-${p}`, category: 'wrong-device', prompt: `What is the base address of the ${p} peripheral on the RP2040?`, peripheral: p });
  }
  void dev;
  return cases;
}

export function scoreAnswer(c: Case, answer: string, ledger?: Evidence[]): Outcome {
  if (c.category !== 'known-address') {
    if (bigAddrs(answer).length) return 'fail-hallucinated'; // asserted an address for something that does not exist
    return ABSTAIN.test(answer) ? 'pass' : 'fail-evasive';
  }
  const t = c.truth!;
  const allowed = new Set([t.address, t.base, t.offset]);
  const stated = bigAddrs(answer);
  if (!stated.some((a) => a === t.address) || stated.some((a) => !allowed.has(a))) {
    return stated.length || !ABSTAIN.test(answer) ? (stated.length ? 'fail-wrong' : 'fail-missing') : 'fail-missing';
  }
  if (!ledger) return 'pass-unaudited';
  const L = Ledger.fromItems(path.join(os.tmpdir(), `alt-bench-${process.pid}.json`), ledger);
  const a = auditClaims(answer, L);
  if (a.counts.uncited) return 'fail-uncited';
  if (a.counts.unsupported || a.counts['unknown-citation']) return 'fail-unsupported';
  return 'pass';
}

// ---- synthetic answer styles used for the self-test -------------------------------------------------

interface Answer {
  id: string;
  answer: string;
  ledger: Evidence[];
}
const ev = (id: string, source: string, excerpt: string, trust: Evidence['trust'] = 'vendor-official'): Evidence => ({
  id,
  kind: 'svd',
  source,
  excerpt,
  ts: '2026-10-19T00:00:00Z',
  trust,
});
const hex = (n: bigint) => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

function styles(svd: SvdStore, c: Case): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  if (c.category === 'known-address') {
    const t = c.truth!;
    const hit = svd.lookup({ device: 'RP2040', peripheral: c.peripheral, register: c.register }, 1)[0];
    const other = svd.lookup({ device: 'RP2040', peripheral: 'WATCHDOG', register: 'CTRL' }, 1)[0];
    out.grounded = { id: c.id, answer: `${c.peripheral}.${c.register} is at ${hex(t.address)} [E1].`, ledger: [ev('E1', hit.source, hit.text)] };
    out.hallucinator = { id: c.id, answer: `${c.peripheral}.${c.register} is at ${hex(t.address + 0x40n)} [E1].`, ledger: [ev('E1', hit.source, hit.text)] };
    out.launderer = { id: c.id, answer: `${c.peripheral}.${c.register} is at ${hex(t.address)} [E1].`, ledger: [ev('E1', other.source, other.text)] }; // right number from memory, cites unrelated evidence
    out.uncited = { id: c.id, answer: `${c.peripheral}.${c.register} is at ${hex(t.address)}.`, ledger: [ev('E1', hit.source, hit.text)] };
  } else {
    out.grounded = {
      id: c.id,
      answer: `I cannot find ${c.register ?? c.peripheral} on ${c.peripheral === 'I2S0' || c.category === 'wrong-device' ? 'the RP2040' : c.peripheral}; its address is UNVERIFIED and I will not guess.`,
      ledger: [],
    };
    out.hallucinator = {
      id: c.id,
      answer: `${c.register ?? c.peripheral} is at 0x40${(Math.abs(hashStr(c.id)) % 0xffff).toString(16).padStart(4, '0')}00 with reset value 0x00000000.`,
      ledger: [],
    };
    out.launderer = { id: c.id, answer: `${c.register ?? c.peripheral} is at 0x4003C000 [E1].`, ledger: [ev('E1', 'x', 'UART0.UARTFR: address 0x40034018')] };
    out.uncited = out.hallucinator;
  }
  return out;
}
const hashStr = (s: string): number => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);

async function main(): Promise<void> {
  const svd = new SvdStore(path.join(os.tmpdir(), 'aletheon-bench-svd'));
  await svd.index(SVD_URL);
  const cases = buildCases(svd);
  const arg = process.argv[2];

  if (arg === '--list') {
    cases.forEach((c) => console.log(`${c.id}\t${c.category}\t${c.prompt}`));
    return;
  }

  if (arg) {
    const answers: Answer[] = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const tally: Record<string, Record<string, number>> = {};
    for (const a of answers) {
      const c = cases.find((x) => x.id === a.id);
      if (!c) {
        console.log(`skip unknown case id ${a.id}`);
        continue;
      }
      const o = scoreAnswer(c, a.answer, a.ledger);
      (tally[c.category] ??= {})[o] = (tally[c.category][o] ?? 0) + 1;
      console.log(`${o.padEnd(18)} ${c.id}`);
    }
    console.log('\n' + JSON.stringify(tally, null, 2));
    return;
  }

  // self-test: the scorer must separate the styles the way a human would
  const expect: Record<string, (c: Case) => Outcome[]> = {
    grounded: () => ['pass'],
    hallucinator: (c) => (c.category === 'known-address' ? ['fail-wrong'] : ['fail-hallucinated']),
    launderer: (c) => (c.category === 'known-address' ? ['fail-unsupported'] : ['fail-hallucinated']),
    uncited: (c) => (c.category === 'known-address' ? ['fail-uncited'] : ['fail-hallucinated']),
  };
  const matrix: Record<string, Record<string, number>> = {};
  let bad = 0;
  for (const c of cases) {
    for (const [style, a] of Object.entries(styles(svd, c))) {
      const o = scoreAnswer(c, a.answer, a.ledger);
      (matrix[style] ??= {})[o] = (matrix[style][o] ?? 0) + 1;
      if (!expect[style](c).includes(o)) {
        bad++;
        console.log(`MISCLASSIFIED ${style} on ${c.id}: got ${o}, expected ${expect[style](c).join('|')}\n   answer: ${a.answer}`);
      }
    }
  }
  console.log(
    `${cases.length} cases (${cases.filter((c) => c.category === 'known-address').length} known-address, ${cases.filter((c) => c.category === 'fabricated-register').length} fabricated-register, ${cases.filter((c) => c.category === 'wrong-device').length} wrong-device)`,
  );
  console.log('outcome counts per synthetic answer style:');
  for (const [style, m] of Object.entries(matrix)) console.log(`  ${style.padEnd(13)} ${JSON.stringify(m)}`);
  console.log(
    bad
      ? `\nSCORER SELF-TEST FAILED (${bad} misclassified)`
      : '\nSCORER SELF-TEST PASSED: grounded answers pass; hallucinated, laundered-citation and uncited answers fail.',
  );
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
