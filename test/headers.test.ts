// Generates a register header for EVERY peripheral in real vendor SVDs and checks them without a C compiler:
//  - every register has an _ADDR macro equal to base+offset (no silent name collisions)
//  - struct layout re-simulated from the emitted text (natural alignment) matches every layout assert
//  - braces/guards balanced
// Run: npm run test:headers
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRegsHeader } from '../src/core/driver';
import { SvdStore } from '../src/core/svd';

const SRC: Record<string, string> = {
  rp2040: 'https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/rp2040/hardware_regs/RP2040.svd',
  stm32f401: 'https://raw.githubusercontent.com/modm-io/cmsis-svd-stm32/main/stm32f4/STM32F401.svd',
  nrf52840: 'https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/Nordic/nrf52840.svd',
  esp32s3: 'https://raw.githubusercontent.com/espressif/svd/main/svd/esp32s3.svd',
};
const SIZE: Record<string, number> = { uint8_t: 1, uint16_t: 2, uint32_t: 4, uint64_t: 8 };

async function main(): Promise<void> {
  const store = new SvdStore(path.join(os.tmpdir(), 'aletheon-hdr-test'));
  let periphs = 0,
    regs = 0,
    fields = 0,
    structRegs = 0,
    skipped = 0,
    bad = 0,
    addrMissing = 0;
  const problems: string[] = [];

  for (const [key, url] of Object.entries(SRC)) {
    const dev = await store.index(url);
    for (const p of dev.peripherals) {
      periphs++;
      const g = generateRegsHeader(dev, p, 'E1');
      if (process.env.HDR_OUT) {
        // Dump for compile testing: HDR_OUT/<device>/<peripheral>.h
        fs.mkdirSync(path.join(process.env.HDR_OUT, key), { recursive: true });
        fs.writeFileSync(path.join(process.env.HDR_OUT, key, `${p.name.replace(/[^A-Za-z0-9_]/g, '_')}.h`), g.text);
      }
      regs += g.registers;
      fields += g.fields;
      structRegs += g.structMembers;
      skipped += g.skipped.length;
      const t = g.text;
      const tag = `${key}/${p.name}`;

      // 1. every register has an ADDR macro with the right value
      const P = p.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      for (const r of p.registers) {
        const R = `${P}_${r.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
        if (!t.includes(`#define ${R}_ADDR (${P}_BASE + ${R}_OFFSET)`)) {
          addrMissing++;
          if (problems.length < 15) problems.push(`${tag}: missing ADDR for ${r.name} (name collision?)`);
        }
        const m = t.match(new RegExp(`#define ${R}_OFFSET 0x([0-9A-F]+)u`));
        if (m && parseInt(m[1], 16) !== r.offset && !problems.some((x) => x.includes(`${tag}: offset`)))
          problems.push(`${tag}: offset macro for ${r.name} differs (collision between duplicate names)`);
      }

      // 2. independent struct layout simulation vs. the emitted asserts
      const body = t.match(/typedef struct \{\n([\s\S]*?)\} \w+_Type;/);
      if (body) {
        let off = 0;
        const sim = new Map<string, number>();
        for (const line of body[1].split('\n')) {
          const r = line.match(/^\s+uint8_t _reserved\d+\[(\d+)\];/);
          if (r) {
            off += +r[1];
            continue;
          }
          const m = line.match(/^\s+volatile (uint\d+_t) (\w+);/);
          if (!m) continue;
          const sz = SIZE[m[1]];
          const aligned = Math.ceil(off / sz) * sz; // natural alignment padding the compiler would add
          sim.set(m[2], aligned);
          off = aligned + sz;
        }
        for (const a of t.matchAll(/offsetof\(\w+_Type, (\w+)\) == 0x([0-9A-F]+)u/g)) {
          if (sim.get(a[1]) !== parseInt(a[2], 16)) {
            bad++;
            if (problems.length < 15) problems.push(`${tag}: struct member ${a[1]} lands at ${sim.get(a[1])}, SVD says 0x${a[2]}`);
          }
        }
      }

      // 3. structural sanity
      const code = t.replace(/\/\*[\s\S]*?\*\//g, ''); // descriptions may contain braces
      const open = (code.match(/\{/g) ?? []).length,
        close = (code.match(/\}/g) ?? []).length;
      if (open !== close || !t.includes('#endif /*')) {
        bad++;
        problems.push(`${tag}: unbalanced`);
      }
    }
  }

  // Known-answer spot check against well-documented addresses.
  const rp = store.findPeripherals('UART0', 'RP2040')[0];
  const h = generateRegsHeader(rp.dev, rp.p, 'E7').text;
  const known = [
    '#define UART0_BASE 0x40034000u',
    '#define UART0_UARTDR_ADDR',
    '#define UART0_UARTFR_OFFSET 0x018u',
    'Evidence: [E7]',
    'ALETHEON_ASSERT(offsetof(UART0_Type, UARTFR) == 0x018u',
  ];
  const knownOk = known.every((k) => h.includes(k));

  console.log(`peripherals ${periphs}, registers ${regs}, fields ${fields}, struct members ${structRegs}, left out of struct ${skipped}`);
  console.log(`ADDR macros missing/colliding: ${addrMissing}; layout/structure failures: ${bad}; known-answer spot check: ${knownOk ? 'PASS' : 'FAIL'}`);
  problems.slice(0, 15).forEach((x) => console.log('  ' + x));
  console.log('\n--- excerpt (RP2040 UART0) ---');
  console.log(h.split('\n').slice(0, 26).join('\n'));
  console.log('…');
  const i = h.indexOf('typedef struct');
  console.log(h.slice(i, i + 700));
  process.exit(addrMissing || bad || !knownOk ? 1 : 0);
}
main();
