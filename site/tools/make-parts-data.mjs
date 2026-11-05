// Builds site/assets/parts-data.js: the Parts catalog, from KiCad's official symbol libraries (CC-BY-SA 4.0 with a design exception).
// What is read from each symbol: its name, description, keywords, datasheet link, footprint name, and pin names. Nothing is invented:
//   - the manufacturer is inferred from the datasheet link's domain only ('' when the domain is not a known manufacturer),
//   - interfaces (I2C, SPI, UART, CAN, USB) are inferred from pin names and flagged as derived in the UI.
// The output is a modified excerpt of the KiCad libraries, so it is redistributed under CC-BY-SA 4.0 (see site/assets/PARTS-DATA-LICENSE.md).
// Usage (from the project root):
//   git clone --depth 1 https://gitlab.com/kicad/libraries/kicad-symbols.git /tmp/kicad-symbols
//   node site/tools/make-parts-data.mjs /tmp/kicad-symbols
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) {
  console.error('usage: node site/tools/make-parts-data.mjs <kicad-symbols clone>');
  process.exit(1);
}

// Library name -> catalog category. Libraries not listed (connectors, discretes, passives, regulators, FPGAs, power symbols...) are left out
// on purpose: this catalog is for firmware and embedded work.
const CATS = [
  ['Microcontrollers', /^(MCU_|DSP_|CPU_NXP_IMX$|Microcontroller)/],
  ['Sensors', /^Sensor(_|$)/],
  ['Converters', /^Analog_(ADC|DAC)$/],
  ['Interface', /^Interface(_|$)/],
  ['Memory', /^Memory_/],
  ['Timing & RTC', /^Timer(_RTC)?$/],
  ['Drivers', /^Driver_(Motor|LED|Display)$/],
  ['Displays', /^Display_/],
  ['Wireless & RF', /^RF_(Module|Bluetooth|WiFi|ZigBee|GPS|GSM|NFC|RFID)$/],
  ['Power management', /^(Power_Management|Battery_Management|Power_Supervisor)$/],
  ['Analog front-end', /^(Amplifier_(Instrumentation|Current)|Potentiometer_Digital|Comparator|Analog_Switch|Logic_LevelTranslator)$/],
  ['Security', /^Security$/],
];
const catOf = (lib) => (CATS.find(([, re]) => re.test(lib)) ?? [null])[0];

// Manufacturer from the datasheet link's host. Only well-known manufacturer domains; everything else stays ''.
const VENDORS = [
  ['Texas Instruments', /(^|\.)ti\.com(\.cn)?$/],
  ['Analog Devices', /(^|\.)(analog|maximintegrated|linear)\.com$/],
  ['STMicroelectronics', /(^|\.)st\.com$/],
  ['Microchip', /(^|\.)(microchip|atmel)\.com$/],
  ['NXP', /(^|\.)(nxp|freescale)\.com$/],
  ['onsemi', /(^|\.)(onsemi|fairchildsemi)\.com$/],
  ['Infineon', /(^|\.)(infineon|cypress)\.com$/],
  ['Renesas', /(^|\.)(renesas|idt|intersil)\.com$/],
  ['Nordic Semiconductor', /(^|\.)nordicsemi\.com$/],
  ['Espressif', /(^|\.)espressif\.com$/],
  ['Silicon Labs', /(^|\.)silabs\.com$/],
  ['Bosch Sensortec', /(^|\.)bosch-sensortec\.com$/],
  ['TDK InvenSense', /(^|\.)(invensense|tdk)\.com$/],
  ['Sensirion', /(^|\.)sensirion\.com$/],
  ['Melexis', /(^|\.)melexis\.com$/],
  ['Allegro', /(^|\.)allegromicro\.com$/],
  ['Winbond', /(^|\.)winbond\.com$/],
  ['Diodes Inc.', /(^|\.)diodes\.com$/],
  ['Raspberry Pi', /(^|\.)raspberrypi\.(com|org)$/],
  ['u-blox', /(^|\.)u-blox\.com$/],
  ['Vishay', /(^|\.)vishay\.com$/],
  ['ROHM', /(^|\.)rohm\.com$/],
  ['Monolithic Power', /(^|\.)monolithicpower\.com$/],
  ['Skyworks', /(^|\.)skyworksinc\.com$/],
  ['Qorvo', /(^|\.)qorvo\.com$/],
  ['Lattice', /(^|\.)latticesemi\.com$/],
  ['AMD Xilinx', /(^|\.)(xilinx|amd)\.com$/],
  ['WCH', /(^|\.)wch(-ic)?\.(cn|com)$/],
  ['GigaDevice', /(^|\.)gigadevice\.com$/],
  ['Murata', /(^|\.)murata\.com$/],
  ['Würth Elektronik', /(^|\.)we-online\.com$/],
  ['AKM', /(^|\.)akm\.com$/],
  ['LEM', /(^|\.)lem\.com$/],
  ['FTDI', /(^|\.)ftdichip\.com$/],
  ['ams OSRAM', /(^|\.)(ams|osram-os|ams-osram)\.com$/],
  ['ISSI', /(^|\.)issi\.com$/],
  ['Nexperia', /(^|\.)nexperia\.com$/],
  ['Broadcom', /(^|\.)broadcom\.com$/],
  ['Power Integrations', /(^|\.)power\.com$/],
  ['Alliance Memory', /(^|\.)alliancememory\.com$/],
  ['Macronix', /(^|\.)macronix\.com$/],
  ['Trinamic', /(^|\.)trinamic\.com$/],
  ['HOPERF', /(^|\.)hoperf\.com$/],
];
const vendorOf = (url) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (VENDORS.find(([, re]) => re.test(h)) ?? [''])[0];
  } catch {
    return '';
  }
};

const unesc = (s) => s.replace(/\\(["\\])/g, '$1').replace(/\\n/g, ' ');
const prop = (txt, name) => {
  const m = new RegExp(`\\(property "${name}" "((?:[^"\\\\]|\\\\.)*)"`).exec(txt);
  return m ? unesc(m[1]).trim() : '';
};
const IFACES = [
  ['I2C', (p) => (p.has('SDA') || p.has('SDI/SDA')) && (p.has('SCL') || p.has('SCLK/SCL') || p.has('SCK/SCL'))],
  [
    'SPI',
    (p) =>
      (p.has('MOSI') || p.has('SDI') || p.has('DIN') || p.has('SDO/SDI')) &&
      (p.has('SCK') || p.has('SCLK') || p.has('CLK')) &&
      (p.has('MISO') || p.has('SDO') || p.has('DOUT') || p.has('CS') || p.has('~{CS}') || p.has('CSB') || p.has('~{CSB}')),
  ],
  ['UART', (p) => (p.has('TX') || p.has('TXD')) && (p.has('RX') || p.has('RXD'))],
  ['CAN', (p) => (p.has('CANH') && p.has('CANL')) || (p.has('CAN_H') && p.has('CAN_L'))],
  ['USB', (p) => p.has('D+') && p.has('D-')],
];

const rows = [],
  pending = [];
const libs = new Set(),
  cats = new Set(),
  vendors = new Set();
let scanned = 0,
  noDs = 0;
const seen = new Set();
for (const d of fs
  .readdirSync(root)
  .filter((x) => x.endsWith('.kicad_symdir'))
  .sort()) {
  const lib = d.replace(/\.kicad_symdir$/, '');
  const cat = catOf(lib);
  if (!cat) continue;
  for (const f of fs
    .readdirSync(path.join(root, d))
    .filter((x) => x.endsWith('.kicad_sym'))
    .sort()) {
    scanned++;
    const txt = fs.readFileSync(path.join(root, d, f), 'utf8');
    const name = prop(txt, 'Value') || f.replace(/\.kicad_sym$/, '');
    const key = `${lib}/${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let ds = prop(txt, 'Datasheet');
    ds = ds.replace(/,\s.*$/, ''); // a few upstream links carry a stray package name after a comma ("...pdf, MSOP-8")
    if (!/^https?:\/\//i.test(ds)) {
      ds = '';
      noDs++;
    }
    const desc = prop(txt, 'Description').replace(/\s+/g, ' ');
    const kw = prop(txt, 'ki_keywords').replace(/\s+/g, ' ');
    const fp = prop(txt, 'Footprint').replace(/^.*:/, '');
    const pinNames = [...txt.matchAll(/\(pin \w+ \w+\s+\(at [^)]*\)\s+\(length [^)]*\)\s+(?:\(hide yes\)\s+)?\(name "((?:[^"\\]|\\.)*)"/g)].map((m) =>
      unesc(m[1]),
    );
    const pinCount = (txt.match(/\(pin \w+ \w+/g) ?? []).length;
    const parent = (/\(extends "((?:[^"\\]|\\.)*)"\)/.exec(txt) ?? [])[1];
    libs.add(lib);
    cats.add(cat);
    pending.push({ lib, cat, name, desc, kw, fp, ds, pinNames, pinCount, parent: parent ? unesc(parent) : '' });
  }
}
// Variants ("extends") carry no pins of their own: inherit pin data from the parent symbol in the same library.
const byKey = new Map(pending.map((p) => [`${p.lib}/${p.name}`, p]));
const rootOf = (p, depth = 0) => (p.parent && depth < 5 && byKey.get(`${p.lib}/${p.parent}`) ? rootOf(byKey.get(`${p.lib}/${p.parent}`), depth + 1) : p);
// Interfaces: from pin names (when the pins are known) and from the words I2C / SPI / UART / CAN / USB in the description (derived, shown as such).
const WORDS = [
  ['I2C', /\bI2C\b/i],
  ['SPI', /\bSPI\b/i],
  ['UART', /\bUART\b/i],
  ['CAN', /\bCAN( bus)?\b/i],
  ['USB', /\bUSB\b/i],
];
for (const p of pending) {
  const src = p.pinCount ? p : rootOf(p);
  const pinNames = src.pinNames,
    pinCount = src.pinCount;
  const uniqPins = [...new Set(pinNames.filter((n) => n && n !== '~'))];
  const small = p.cat !== 'Microcontrollers' && pinCount > 0 && pinCount <= 40;
  const set = new Set(pinNames);
  const ifs = new Set(small ? IFACES.filter(([, test]) => test(set)).map(([n]) => n) : []);
  if (p.cat !== 'Microcontrollers')
    WORDS.forEach(([n, re]) => {
      if (re.test(p.desc) || re.test(p.kw)) ifs.add(n);
    });
  const ven = vendorOf(p.ds);
  if (ven) vendors.add(ven);
  rows.push([
    p.name,
    p.desc.slice(0, 160),
    p.lib,
    p.cat,
    ven,
    p.ds,
    p.fp || rootOf(p).fp,
    pinCount,
    small ? uniqPins.slice(0, 24).join(' ') : '',
    p.kw.slice(0, 60),
    ['I2C', 'SPI', 'UART', 'CAN', 'USB'].filter((n) => ifs.has(n)).join(' '),
  ]);
}
rows.sort((a, b) => a[3].localeCompare(b[3]) || a[0].localeCompare(b[0], 'en', { numeric: true }));

let commit = '';
try {
  commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* not a git dir */
}
const cols = ['name', 'desc', 'lib', 'cat', 'vendor', 'ds', 'fp', 'pins', 'pinNames', 'kw', 'ifaces'];
const count = (i) => {
  const m = {};
  rows.forEach((r) => {
    if (r[i]) m[r[i]] = (m[r[i]] ?? 0) + 1;
  });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
const meta = {
  generated: new Date().toISOString().slice(0, 10),
  source: { repo: 'gitlab.com/kicad/libraries/kicad-symbols', commit, license: 'CC-BY-SA-4.0' },
  counts: {
    parts: rows.length,
    libraries: libs.size,
    withDatasheet: rows.filter((r) => r[5]).length,
    withVendor: rows.filter((r) => r[4]).length,
    withIface: rows.filter((r) => r[10]).length,
  },
  cats: count(3),
  vendors: count(4),
  ifaces: Object.entries(
    rows.reduce((m, r) => {
      r[10]
        .split(' ')
        .filter(Boolean)
        .forEach((i) => {
          m[i] = (m[i] ?? 0) + 1;
        });
      return m;
    }, {}),
  ).sort((a, b) => b[1] - a[1]),
};
// Company-level contact and support pages, confirmed by hand and by site/tools/check-vendor-links.mjs (see vendors.json).
const vend = JSON.parse(fs.readFileSync(path.join('site', 'tools', 'vendors.json'), 'utf8'));
meta.vendorProfiles = { checked: vend.checked, vendors: vend.vendors };
const out = path.join('site', 'assets', 'parts-data.js');
fs.writeFileSync(
  out,
  `/* Generated by site/tools/make-parts-data.mjs from the KiCad symbol libraries (CC-BY-SA 4.0). See PARTS-DATA-LICENSE.md. Do not edit. */\nwindow.PARTS=${JSON.stringify({ meta, cols, rows })};\n`,
);
console.log(
  `scanned ${scanned} symbols in ${libs.size} libraries; kept ${rows.length}; ${meta.counts.withDatasheet} with datasheet link; ${meta.counts.withVendor} with a known manufacturer; ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`,
);
console.log(JSON.stringify({ cats: meta.cats, vendors: meta.vendors.slice(0, 20), ifaces: meta.ifaces }));
