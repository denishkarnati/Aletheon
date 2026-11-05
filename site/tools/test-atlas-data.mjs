// Sanity and known-answer checks for site/assets/atlas-data.js. Run from the project root:  node site/tools/test-atlas-data.mjs
// Known answers are real, widely published specs, so a data-build bug (wrong unit, wrong column) cannot pass silently.
import * as fs from 'node:fs';
import * as vm from 'node:vm';

const src = fs.readFileSync('site/assets/atlas-data.js', 'utf8');
const ctx = { window: {} };
vm.runInNewContext(src, ctx);
const A = ctx.window.ATLAS;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const ci = Object.fromEntries(A.cols.map((c, i) => [c, i]));
const R = A.rows;
const row = (id) => R.find((r) => r[ci.id] === id);
const g = (r, k) => r[ci[k]];

check('more than 1,000 boards', R.length > 1000, String(R.length));
check(
  'every row has every column',
  R.every((r) => r.length === A.cols.length),
);
check('ids are unique', new Set(R.map((r) => g(r, 'id'))).size === R.length);
// Real extremes exist: HiFive Unleashed runs at 1.5 GHz with 8 GB of RAM, i.MX RT EVKs have 32 MB SDRAM. Bounds only catch unit mistakes.
check(
  'clock is plausible (1 to 3000 MHz)',
  R.every((r) => g(r, 'mhz') >= 1 && g(r, 'mhz') <= 3000),
  JSON.stringify(
    R.filter((r) => g(r, 'mhz') < 1 || g(r, 'mhz') > 3000)
      .slice(0, 2)
      .map((r) => g(r, 'id')),
  ),
);
check(
  'flash and RAM are positive and plausible',
  R.every((r) => g(r, 'flashKB') > 0 && g(r, 'ramKB') > 0 && g(r, 'flashKB') <= 131072 && g(r, 'ramKB') <= 16777216),
);
const big = row('sifive/hifive-unleashed');
check('HiFive Unleashed keeps its real extremes (1500 MHz, 8 GB RAM)', big && g(big, 'mhz') === 1500 && g(big, 'ramKB') === 8388608);
check(
  'connectivity and debug are arrays of strings',
  R.every((r) => Array.isArray(g(r, 'conn')) && Array.isArray(g(r, 'dbg')) && Array.isArray(g(r, 'fw'))),
);
check('every board has a silicon vendor', R.every((r) => g(r, 'si')) && !R.some((r) => g(r, 'si') === 'Other'));
check(
  'summary counts match the rows',
  A.meta.counts.boards === R.length &&
    A.meta.counts.withSvd === R.filter((r) => g(r, 'svd')).length &&
    A.meta.counts.mcus === new Set(R.map((r) => g(r, 'mcu'))).size,
);
check(
  'provenance recorded for every source repo',
  A.meta.sources.length >= 10 && A.meta.sources.every((s) => s.repo && s.commit && s.boards > 0) && !!A.meta.svd.tree,
);

const f401 = row('ststm32/nucleo_f401re');
check(
  'Nucleo-F401RE: STM32F401, 84 MHz, 512 KB flash, 96 KB RAM',
  f401 && g(f401, 'mcu').startsWith('stm32f401') && g(f401, 'mhz') === 84 && g(f401, 'flashKB') === 512 && g(f401, 'ramKB') === 96,
  JSON.stringify(f401 && [g(f401, 'mcu'), g(f401, 'mhz'), g(f401, 'flashKB'), g(f401, 'ramKB')]),
);
check(
  'Nucleo-F401RE is Cortex-M4, ST silicon, with a register map',
  f401 && g(f401, 'arch') === 'cortex-m4' && g(f401, 'si') === 'STMicroelectronics' && /STM32F401/.test(g(f401, 'svd')),
);
const nrf = row('nordicnrf52/nrf52840_dk');
check(
  'nRF52840-DK: 64 MHz, 1 MB flash, 256 KB RAM, Nordic',
  nrf && g(nrf, 'mhz') === 64 && g(nrf, 'flashKB') === 1024 && g(nrf, 'ramKB') === 256 && g(nrf, 'si') === 'Nordic Semiconductor',
);
const uno = row('atmelavr/uno');
check(
  'Arduino Uno: ATmega328P, 16 MHz, 2 KB RAM, AVR',
  uno && g(uno, 'mcu') === 'atmega328p' && g(uno, 'mhz') === 16 && g(uno, 'ramKB') === 2 && g(uno, 'arch') === 'avr',
);
const s3 = row('espressif32/esp32-s3-devkitc-1');
check(
  'ESP32-S3-DevKitC-1: esp32s3, 240 MHz, Xtensa LX7, Espressif, register map',
  s3 && g(s3, 'mcu') === 'esp32s3' && g(s3, 'mhz') === 240 && g(s3, 'arch') === 'xtensa-lx7' && g(s3, 'si') === 'Espressif' && /esp32s3/i.test(g(s3, 'svd')),
);
const pico = R.find((r) => g(r, 'mcu') === 'rp2040');
check(
  'an RP2040 board exists at 133 MHz with a register map and the tested flag',
  pico && g(pico, 'mhz') === 133 && /rp2040/i.test(g(pico, 'svd')) && g(pico, 'ale') === 2,
);
check(
  'boards on tested chips are flagged tested (and only those)',
  R.filter((r) => g(r, 'ale') === 2).every((r) => ['rp2040', 'esp32', 'esp32s3', 'nrf52840'].includes(g(r, 'mcu')) || g(r, 'mcu').startsWith('stm32f401')),
);
check(
  'register-map paths are relative .svd files inside the mirror',
  R.filter((r) => g(r, 'svd')).every((r) => /^[\w-]+(\/[\w.-]+)+\.svd$/i.test(g(r, 'svd'))),
);

// Upstream manifests are untrusted input: a link that is not http(s) (for example javascript:) must never reach the page.
check(
  'every board link is empty or a plain http(s) URL with no quote or angle bracket',
  R.every((r) => !g(r, 'url') || /^https?:\/\/[^\s"'<>]+$/i.test(g(r, 'url'))),
  JSON.stringify(
    R.filter((r) => g(r, 'url') && !/^https?:\/\/[^\s"'<>]+$/i.test(g(r, 'url')))
      .slice(0, 3)
      .map((r) => [g(r, 'id'), g(r, 'url')]),
  ),
);

// The home page loads only this 2 KB summary instead of the 270 KB dataset; it must never drift from it.
const metaCtx = { window: {} };
vm.runInNewContext(fs.readFileSync('site/assets/atlas-meta.js', 'utf8'), metaCtx);
check(
  'atlas-meta.js (home page) equals the meta of atlas-data.js and carries no rows',
  JSON.stringify(metaCtx.window.ATLAS.meta) === JSON.stringify(A.meta) && !metaCtx.window.ATLAS.rows,
);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
