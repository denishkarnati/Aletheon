// Tests for provenance/trust, claim auditing (with forged evidence), and the SVD-vs-datasheet cross-check on the real RP2040 files.
// Run: npm run test:audit
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditClaims, crossCheckRegister } from '../src/core/audit';
import { DocStore } from '../src/core/docs';
import { Ledger } from '../src/core/evidence';
import { classifyTrust } from '../src/core/provenance';
import { SvdStore } from '../src/core/svd';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

async function main(): Promise<void> {
  // ---- provenance classification
  check('vendor domain => vendor-official', classifyTrust('https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf') === 'vendor-official');
  check('vendor GitHub org => vendor-official', classifyTrust('https://raw.githubusercontent.com/espressif/svd/main/svd/esp32s3.svd') === 'vendor-official');
  check(
    'other GitHub => community-mirror',
    classifyTrust('https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/Nordic/nrf52840.svd') === 'community-mirror',
  );
  check(
    'lookalike host is NOT vendor',
    classifyTrust('https://espressif.com.evil.example/x.pdf') === 'community-mirror' && classifyTrust('https://notespressif.com/x.pdf') === 'community-mirror',
  );
  check('local path => user-supplied', classifyTrust('C:\\work\\ds.pdf') === 'user-supplied' && classifyTrust('docs/ds.pdf') === 'user-supplied');
  check('pack member keeps source host class', classifyTrust('https://www.keil.com/pack/X.pack!SVD/X.svd') === 'community-mirror');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-audit-'));
  const L = new Ledger(path.join(tmp, 'ledger.json'));
  const e1 = L.add('svd', 'x.svd#UART0.UARTFR', 'RP2040 UART0.UARTFR: address 0x40034018 (base 0x40034000 + offset 0x018), 32 bit', {
    trust: 'vendor-official',
  });
  const e2 = L.add('build', 'pio run', 'exit 0\nLinking .pio/build/pico/firmware.elf', {});
  const e3 = L.add('datasheet', 'https://forum.example/post p.1', 'The core runs at up to 133MHz and the pad supply is 3.30V.', { trust: 'community-mirror' });
  check('ledger default trust: build => measured', e2.trust === 'measured');
  check('ledger keeps provided trust', e1.trust === 'vendor-official' && e3.trust === 'community-mirror');

  // ---- audit with forged evidence
  const a = (t: string) => auditClaims(t, L);
  check('supported claim passes', a(`UARTFR is at 0x40034018 [${e1.id}].`).ok);
  check('hex normalization (padding, suffix)', a(`UARTFR is at 0x040034018u [${e1.id}].`).ok);
  const wrong = a(`UARTFR is at 0x40034020 [${e1.id}].`);
  check('cited evidence lacks the value => unsupported', !wrong.ok && wrong.counts.unsupported === 1, JSON.stringify(wrong.counts));
  const launder = a(`UARTFR is at 0x40034018 [${e2.id}].`);
  check('citation laundering (real id, irrelevant evidence) caught', !launder.ok && launder.counts.unsupported === 1, JSON.stringify(launder.counts));
  check('uncited value flagged', a('UARTFR is at 0x40034018.').counts.uncited === 1);
  check('unknown citation flagged', a('UARTFR is at 0x40034018 [E99].').counts['unknown-citation'] === 1);
  check('UNVERIFIED is honest, not a failure', a('UARTFR address is UNVERIFIED; maybe 0x40034018.').ok);
  check('units normalize (133 MHz vs 133MHz, 3.3 V vs 3.30V)', a(`Max clock is 133 MHz and VDD is 3.3 V [${e3.id}].`).ok);
  check('multi-cite uses union of evidence', a(`UARTFR 0x40034018 at 133 MHz [${e1.id}, ${e3.id}].`).ok);
  const weak = a(`Max clock is 133 MHz [${e3.id}].`);
  check('community-only support is ok but flagged weak', weak.ok && weak.weak === 1, JSON.stringify(weak));
  check('code blocks are not audited as prose', a('```c\n#define X 0x12345678\n```\nDone.').claims.length === 0);
  check('evidence ids are not mistaken for values', a(`See [${e1.id}] for details.`).claims.length === 0);
  check('pin claims need support too', a('UART0 TX is on GPIO 0 [E1].').counts.unsupported === 1);

  // ---- real data: provenance recorded + cross-check
  const docs = new DocStore(path.join(tmp, 'docs')); // fresh store so provenance fields are populated
  await docs.index('https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf');
  const svd = new SvdStore(path.join(os.tmpdir(), 'aletheon-audit-svd'));
  const dev = await svd.index('https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/rp2040/hardware_regs/RP2040.svd');
  check(
    'SVD provenance: sha256 + vendor-official + fetchedAt',
    /^[0-9a-f]{64}$/.test(dev.sha256 ?? '') && dev.trust === 'vendor-official' && !!dev.fetchedAt,
    JSON.stringify({ t: dev.trust }),
  );
  const nrf = await svd.index('https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/Nordic/nrf52840.svd');
  check('community SVD is labeled community-mirror', nrf.trust === 'community-mirror');
  const dmeta = docs.list()[0];
  check('datasheet indexed with hash/trust', !!dmeta);
  // The recorded hash must be the hash of the real file (a detached/empty buffer hashes to e3b0c442...).
  const { createHash } = await import('node:crypto');
  const real = createHash('sha256')
    .update(Buffer.from(await (await fetch('https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf')).arrayBuffer()))
    .digest('hex');
  check(
    'datasheet sha256 equals the hash of the downloaded file',
    (docs as any).docs[0].sha256 === real && real !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    String((docs as any).docs[0].sha256).slice(0, 12),
  );
  const hit = (await docs.search('UARTFR', 1)).hits[0];
  check(
    'search hits carry trust + sha256',
    hit.trust === 'vendor-official' && /^[0-9a-f]{64}$/.test(hit.sha256 ?? ''),
    JSON.stringify({ t: hit.trust, s: hit.sha256 }),
  );

  // calibrate on a sample of registers: honest agreement rate, and how often a TAMPERED offset still "agrees"
  const periphs = [
    'UART0',
    'UART1',
    'SPI0',
    'I2C0',
    'PWM',
    'TIMER',
    'WATCHDOG',
    'RTC',
    'ADC',
    'DMA',
    'PIO0',
    'USBCTRL_REGS',
    'CLOCKS',
    'XOSC',
    'PLL_SYS',
    'RESETS',
    'SYSCFG',
    'TBMAN',
    'PSM',
    'IO_BANK0',
  ];
  const tally: Record<string, number> = { agree: 0, conflict: 0, 'name-only': 0, 'not-found': 0 };
  const tamperTally: Record<string, number> = { agree: 0, conflict: 0, 'name-only': 0, 'not-found': 0 };
  let n = 0;
  const sampleNote: string[] = [];
  for (const pn of periphs) {
    const p = dev.peripherals.find((x) => x.name === pn);
    if (!p) continue;
    const regs = p.registers.filter((r) => r.name.length >= 5 && r.fields.length > 0).slice(0, 6);
    for (const r of regs) {
      n++;
      const real = await crossCheckRegister(docs, p.name, r);
      tally[real.verdict]++;
      const forged = { ...r, offset: r.offset + 0x40, address: r.address + 0x40 };
      const fake = await crossCheckRegister(docs, p.name, forged);
      tamperTally[fake.verdict]++;
      if (n <= 4) sampleNote.push(`${p.name}.${r.name}: real=${real.verdict} tampered=${fake.verdict}`);
    }
  }
  console.log(`\ncross-check on ${n} real RP2040 registers:`);
  console.log('  real SVD    :', JSON.stringify(tally));
  console.log('  offset +0x40:', JSON.stringify(tamperTally));
  sampleNote.forEach((s) => console.log('  e.g.', s));
  const knownGood = await crossCheckRegister(
    docs,
    'UART0',
    dev.peripherals.find((x) => x.name === 'UART0')!.registers.find((r) => r.name === 'UARTFR')!,
  );
  console.log('  UART0.UARTFR ->', knownGood.verdict, '|', knownGood.detail.slice(0, 140));
  check('UART0.UARTFR agrees with the datasheet', knownGood.verdict === 'agree', knownGood.verdict);
  check('tampering is not waved through as agree (<=10%)', tamperTally.agree / n <= 0.1, JSON.stringify(tamperTally));
  check('most real registers verify as agree (>=50%)', tally.agree / n >= 0.5, JSON.stringify(tally));
  check('no real register is called a conflict (false alarms <=10%)', tally.conflict / n <= 0.1, JSON.stringify(tally));

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main();
