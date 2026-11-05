// Sanity and known-answer checks for site/assets/parts-data.js and the vendor profiles. Run from the project root:  node site/tools/test-parts-data.mjs
import * as fs from 'node:fs';
import * as vm from 'node:vm';

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('site/assets/parts-data.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('site/assets/devices-data.js', 'utf8'), ctx);
const P = ctx.window.PARTS,
  D = ctx.window.DEVICES;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const ci = Object.fromEntries(P.cols.map((c, i) => [c, i]));
const R = P.rows,
  g = (r, k) => r[ci[k]];
const row = (n) => R.find((r) => g(r, 'name') === n);

check('more than 8,000 parts in at least 10 categories', R.length > 8000 && P.meta.cats.length >= 10, `${R.length} / ${P.meta.cats.length}`);
check(
  'every row has every column',
  R.every((r) => r.length === P.cols.length),
);
check('library + name is unique', new Set(R.map((r) => `${g(r, 'lib')}/${g(r, 'name')}`)).size === R.length);
check(
  'summary counts match the rows',
  P.meta.counts.parts === R.length &&
    P.meta.counts.withDatasheet === R.filter((r) => g(r, 'ds')).length &&
    P.meta.cats.reduce((s, c) => s + c[1], 0) === R.length,
);
check(
  'datasheet links are http(s) URLs or empty',
  R.every((r) => !g(r, 'ds') || /^https?:\/\/[^\s]+$/.test(g(r, 'ds'))),
);
check(
  'no part is stuck at zero pins (variants inherit from their parent)',
  R.every((r) => g(r, 'pins') > 0),
  String(R.filter((r) => g(r, 'pins') === 0).length),
);
check('provenance and licence recorded', P.meta.source.license === 'CC-BY-SA-4.0' && !!P.meta.source.commit && /kicad-symbols/.test(P.meta.source.repo));
check(
  'the data licence file exists and names CC BY-SA 4.0 and KiCad',
  (() => {
    const t = fs.readFileSync('site/assets/PARTS-DATA-LICENSE.md', 'utf8');
    return /CC BY-SA 4\.0/.test(t) && /KiCad/.test(t);
  })(),
);

const t = row('TMP117xxYBG'),
  t2 = row('TMP117xxDRV'),
  i226 = row('INA226'),
  ads = row('ADS1115IDGS'),
  bme = row('BME280'),
  esp = row('ESP32-WROOM-32'),
  stm = row('STM32F401CCUx');
check(
  'TMP117xxYBG: Texas Instruments, 6 pins, I2C, with SDA and SCL',
  t &&
    g(t, 'vendor') === 'Texas Instruments' &&
    g(t, 'pins') === 6 &&
    /I2C/.test(g(t, 'ifaces')) &&
    /\bSDA\b/.test(g(t, 'pinNames')) &&
    /\bSCL\b/.test(g(t, 'pinNames')),
);
check('TMP117xxDRV (a variant) inherits the 6 pins', t2 && g(t2, 'pins') === 6 && /I2C/.test(g(t2, 'ifaces')));
check(
  'INA226: TI, 10 pins, I2C, with an address pair A0/A1',
  i226 &&
    g(i226, 'vendor') === 'Texas Instruments' &&
    g(i226, 'pins') === 10 &&
    /I2C/.test(g(i226, 'ifaces')) &&
    /\bA0\b/.test(g(i226, 'pinNames')) &&
    /\bA1\b/.test(g(i226, 'pinNames')),
);
check(
  'ADS1115IDGS: TI, 10 pins, four analog inputs AIN0..AIN3',
  ads && g(ads, 'vendor') === 'Texas Instruments' && g(ads, 'pins') === 10 && ['AIN0', 'AIN1', 'AIN2', 'AIN3'].every((p) => g(ads, 'pinNames').includes(p)),
);
check(
  'BME280: Bosch Sensortec, speaks both I2C and SPI',
  bme && g(bme, 'vendor') === 'Bosch Sensortec' && /I2C/.test(g(bme, 'ifaces')) && /SPI/.test(g(bme, 'ifaces')),
);
check('ESP32-WROOM-32 is Espressif, in Wireless & RF', esp && g(esp, 'vendor') === 'Espressif' && g(esp, 'cat') === 'Wireless & RF');
check('STM32F401CCUx is STMicroelectronics, a microcontroller', stm && g(stm, 'vendor') === 'STMicroelectronics' && g(stm, 'cat') === 'Microcontrollers');
check(
  'Analog Devices parts exist and point at analog.com',
  (() => {
    const a = R.filter((r) => g(r, 'vendor') === 'Analog Devices');
    return a.length > 300 && a.every((r) => /analog\.com|maximintegrated\.com|linear\.com/.test(g(r, 'ds')));
  })(),
);
check(
  'manufacturer is only ever set from a datasheet link (never guessed)',
  R.every((r) => !g(r, 'vendor') || g(r, 'ds')),
);

// every part the Device Lab can simulate must exist in the catalog, so the "Simulate" button has a place to live
for (const d of D.devices)
  check(
    `catalog has a ${d.part} entry for the Lab model`,
    R.some((r) => g(r, 'name').toUpperCase().startsWith(d.part)),
  );

// vendor profiles
const prof = P.meta.vendorProfiles;
const known = new Set(P.meta.vendors.map((v) => v[0]));
check(
  'at least 12 vendor profiles, including TI and Analog Devices',
  prof.vendors.length >= 12 && ['Texas Instruments', 'Analog Devices'].every((n) => prof.vendors.some((v) => v.name === n)),
);
check(
  'every profile names a vendor that exists in the catalog',
  prof.vendors.every((v) => known.has(v.name)),
  prof.vendors
    .filter((v) => !known.has(v.name))
    .map((v) => v.name)
    .join(),
);
const urls = prof.vendors.flatMap((v) => [v.website, ...v.links.map((l) => l.url)]);
check('every profile link is https and unique', urls.every((u) => /^https:\/\/[^\s]+$/.test(u)) && new Set(urls).size === urls.length);
check(
  'every link says how it was confirmed',
  prof.vendors.every((v) => v.links.every((l) => ['homepage', 'browser', 'script'].includes(l.how) && l.kind && l.label)),
);
check(
  "each profile link stays on the vendor's own family of domains (no third-party listings)",
  prof.vendors.every((v) => {
    const root = new URL(v.website).hostname
      .replace(/^www\./, '')
      .split('.')
      .slice(-2)
      .join('.');
    return v.links.every((l) => {
      const h = new URL(l.url).hostname;
      return h.endsWith(root) || /esp32\.com$/.test(h);
    });
  }),
);
const blob = JSON.stringify(prof.vendors); // the 'checked' date field is left out: an ISO date looks like a phone number to the regex
check(
  'profiles contain no email addresses or phone numbers',
  !/[\w.+-]+@[\w-]+\.[\w.]+/.test(blob) && !/\+?\d[\d\s().-]{8,}\d/.test(blob.replace(/https?:\/\/[^"]+/g, '')),
);

// the home page's headline numbers must equal what the data files say (regenerate with make-site-stats.mjs after any data change)
vm.runInContext(fs.readFileSync('site/assets/site-stats.js', 'utf8'), ctx);
const S = ctx.window.SITE_STATS;
const countQuotes = (c) => (c ? (c.all ?? [c.q]).length : 0);
const deviceQuotes = D.devices.reduce(
  (n, d) =>
    n +
    countQuotes(d.addressCite) +
    d.registers.reduce((a, r) => a + countQuotes(r.cite), 0) +
    d.facts.reduce((a, f) => a + countQuotes(f.cite), 0) +
    countQuotes(d.cycleTable?.cite),
  0,
);
check(
  'site-stats.js matches the parts, vendor and device data',
  S &&
    S.parts === R.length &&
    S.manufacturers === P.meta.vendors.length &&
    S.vendorProfiles === prof.vendors.length &&
    S.models === D.devices.length &&
    S.quotesChecked === deviceQuotes,
  JSON.stringify(S),
);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
