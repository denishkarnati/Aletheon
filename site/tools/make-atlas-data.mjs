// Builds site/assets/atlas-data.js: the Chip Atlas, assembled from REAL public data.
//   boards  : PlatformIO board manifests (github.com/platformio/platform-*, Apache-2.0): MCU, CPU clock, flash, RAM, frameworks,
//             connectivity, debug/simulation targets. Facts are copied as published; nothing is invented.
//   svd     : file list of github.com/cmsis-svd/cmsis-svd-data (a community mirror of vendor CMSIS-SVD register maps), used only to flag
//             which chips HAVE a register map and where. No SVD files are read or redistributed here.
// Usage (from the project root):
//   mkdir -p /tmp/atlas && cd /tmp/atlas
//   for r in atmelavr atmelsam ststm32 espressif32 nordicnrf52 raspberrypi teensy nxplpc nxpimxrt siliconlabsefm32 sifive maxim32 titiva microchippic32 chipsalliance; do
//     git clone --depth 1 --branch develop --filter=blob:none --sparse https://github.com/platformio/platform-$r.git platform-$r && (cd platform-$r && git sparse-checkout set boards); done
//   curl -s "https://api.github.com/repos/cmsis-svd/cmsis-svd-data/git/trees/main?recursive=1" -o svdtree.json
//   cd <project root> && node site/tools/make-atlas-data.mjs /tmp/atlas /tmp/atlas/svdtree.json
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const [dir, treeFile] = process.argv.slice(2);
if (!dir || !treeFile) {
  console.error('usage: node site/tools/make-atlas-data.mjs <dir with platform-* clones> <svdtree.json>');
  process.exit(1);
}

// ---- SVD index (file names only) -------------------------------------------------------------------------------------------
const tree = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
const svdFiles = tree.tree
  .filter((x) => x.type === 'blob' && /\.svd$/i.test(x.path))
  .map((x) => ({ path: x.path, vendor: x.path.split('/')[1], stem: path.basename(x.path, path.extname(x.path)) }));
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^at(?=(sam|tiny|mega|xmega))/, '')
    .replace(/x+$/, '');
const byNorm = new Map();
for (const f of svdFiles) {
  const k = norm(f.stem);
  if (!byNorm.has(k)) byNorm.set(k, f);
}
const stems = [...byNorm.keys()].filter((k) => k.length >= 6).sort((a, b) => b.length - a.length);

function matchSvd(mcu, hint) {
  if (hint) {
    const k = norm(path.basename(hint, path.extname(hint)));
    if (byNorm.has(k)) return { f: byNorm.get(k), how: 'hint' };
  }
  const m = norm(mcu);
  if (byNorm.has(m)) return { f: byNorm.get(m), how: 'name' };
  for (const s of stems) if (m.startsWith(s)) return { f: byNorm.get(s), how: 'name' };
  return null;
}

// ---- boards ----------------------------------------------------------------------------------------------------------------
const XTENSA = { esp32: 'xtensa-lx6', esp32s2: 'xtensa-lx7', esp32s3: 'xtensa-lx7' };
const PLATFORM_ARCH = { atmelavr: 'avr', sifive: 'riscv', microchippic32: 'mips', chipsalliance: 'riscv' };
const archOf = (platform, mcu, cpu) => {
  if (cpu) return cpu.replace('cortex-m0plus', 'cortex-m0+');
  if (platform === 'espressif32') return XTENSA[mcu] ?? (/^esp32[ch]/.test(mcu) ? 'riscv' : 'other');
  return PLATFORM_ARCH[platform] ?? 'other';
};
const TESTED = [(m) => m === 'rp2040', (m) => m === 'esp32s3', (m) => m === 'esp32', (m) => m.startsWith('stm32f401'), (m) => m === 'nrf52840'];

// Silicon vendor, from the chip's part-number prefix (public naming conventions). 'Other' when no rule applies; never guessed from the board.
const SILICON = [
  [/^stm32/, 'STMicroelectronics'],
  [/^(esp32|esp8266)/, 'Espressif'],
  [/^nrf\d/, 'Nordic Semiconductor'],
  [/^(atmega|attiny|at90|at91sam|atxmega|sam[dlecgvr]\d|sam3|sam4|samv|same|pic32|32m[xz]|atsam)/, 'Microchip'],
  [/^rp2/, 'Raspberry Pi'],
  [/^(lpc|mimxrt|imxrt|imx|mk\d|mkl|mke|mkw|k\d{2}|s32)/, 'NXP'],
  [/^(efm32|efr32|ezr32)/, 'Silicon Labs'],
  [/^(max32|max\d)/, 'Analog Devices'],
  [/^(tm4c|lm4f|lplm4f|lptm4c|msp|cc\d|am\d)/, 'Texas Instruments'],
  [/^(fe310|fu5|fu7)/, 'SiFive'],
  [/^(gd32)/, 'GigaDevice'],
  [/^(xmc)/, 'Infineon'],
  [/^(ch32|ch5)/, 'WCH'],
  [/^(w7500|w5)/, 'WIZnet'],
];
const siliconOf = (mcu) => (SILICON.find(([re]) => re.test(mcu)) ?? [null, 'Other'])[1];
// Board vendors differ only by case/punctuation in places ("Seeed Studio" / "SeeedStudio"); keep the most common spelling.
const vendorCanon = (() => {
  const seen = new Map();
  return (v) => {
    const k = v.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(k)) seen.set(k, v);
    return seen.get(k);
  };
})();

const cols = ['id', 'name', 'vendor', 'si', 'platform', 'mcu', 'cpu', 'arch', 'mhz', 'flashKB', 'ramKB', 'fw', 'conn', 'dbg', 'svd', 'svdHow', 'ale', 'url'];
const rows = [];
const sources = [];
for (const repo of fs
  .readdirSync(dir)
  .filter((d) => d.startsWith('platform-'))
  .sort()) {
  const platform = repo.replace('platform-', '');
  const bdir = path.join(dir, repo, 'boards');
  if (!fs.existsSync(bdir)) continue;
  let commit = '';
  try {
    commit = execFileSync('git', ['-C', path.join(dir, repo), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    /* not a git dir */
  }
  let n = 0;
  for (const f of fs
    .readdirSync(bdir)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'));
    } catch {
      continue;
    }
    const b = j.build ?? {},
      u = j.upload ?? {},
      d = j.debug ?? {};
    const mcu = String(b.mcu ?? '').toLowerCase();
    if (!mcu || !b.f_cpu) continue;
    n++;
    const sv = matchSvd(mcu, d.svd_path);
    const conn = [...new Set((j.connectivity ?? []).map((c) => String(c).toLowerCase().replace('nb-iot', 'nbiot')))].sort();
    const dbg = [];
    if (d.openocd_target || d.openocd_board || d.openocd_chipname) dbg.push('openocd');
    if (d.jlink_device) dbg.push('jlink');
    if (d.pyocd_target) dbg.push('pyocd');
    if (d.renode_machine) dbg.push('renode');
    if (d.qemu_machine) dbg.push('qemu');
    if (d.simavr_target) dbg.push('simavr');
    const tested = TESTED.some((t) => t(mcu)) ? 2 : mcu === 'atmega328p' ? 1 : 0;
    rows.push([
      `${platform}/${f.replace(/\.json$/, '')}`,
      String(j.name ?? f),
      vendorCanon(String(j.vendor ?? '').trim()),
      siliconOf(mcu),
      platform,
      mcu,
      b.cpu ?? '',
      archOf(platform, mcu, b.cpu),
      Math.round(parseInt(String(b.f_cpu), 10) / 1e5) / 10,
      Math.round(((u.maximum_size ?? 0) / 1024) * 10) / 10,
      Math.round(((u.maximum_ram_size ?? 0) / 1024) * 10) / 10,
      (j.frameworks ?? []).slice().sort(),
      conn,
      dbg,
      sv ? sv.f.path.replace(/^data\//, '') : '',
      sv ? sv.how : '',
      tested,
      j.url ?? '',
    ]);
  }
  if (n > 0) sources.push({ repo: `platformio/${repo}`, commit, boards: n }); // a repo whose boards lack an MCU or clock contributes nothing
}

// ---- summary -----------------------------------------------------------------------------------------------------------------
const ci = Object.fromEntries(cols.map((c, i) => [c, i]));
const uniq = (k) => new Set(rows.map((r) => r[ci[k]]).filter(Boolean));
const count = (k) => {
  const m = {};
  rows.forEach((r) => {
    const v = r[ci[k]];
    (Array.isArray(v) ? v : [v]).forEach((x) => {
      if (x) m[x] = (m[x] ?? 0) + 1;
    });
  });
  return m;
};
const meta = {
  generated: new Date().toISOString().slice(0, 10),
  sources,
  svd: { repo: 'cmsis-svd/cmsis-svd-data', tree: tree.sha, files: svdFiles.length },
  counts: {
    boards: rows.length,
    vendors: uniq('vendor').size,
    mcus: uniq('mcu').size,
    platforms: uniq('platform').size,
    withSvd: rows.filter((r) => r[ci.svd]).length,
    mcusWithSvd: new Set(rows.filter((r) => r[ci.svd]).map((r) => r[ci.mcu])).size,
    wifi: rows.filter((r) => r[ci.conn].includes('wifi')).length,
    bluetooth: rows.filter((r) => r[ci.conn].includes('bluetooth')).length,
    can: rows.filter((r) => r[ci.conn].includes('can')).length,
    simulatable: rows.filter((r) => r[ci.dbg].some((x) => ['renode', 'qemu', 'simavr'].includes(x))).length,
  },
  arch: count('arch'),
  vendorTop: Object.entries(count('vendor'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12),
  siliconCounts: Object.entries(count('si')).sort((a, b) => b[1] - a[1]),
};
const out = path.join(process.cwd(), 'site', 'assets', 'atlas-data.js');
fs.writeFileSync(
  out,
  `/* Generated by site/tools/make-atlas-data.mjs from public data (PlatformIO board manifests, Apache-2.0; CMSIS-SVD file list). Do not edit. */\nwindow.ATLAS=${JSON.stringify({ meta, cols, rows })};\n`,
);
console.log(
  `wrote ${out}: ${rows.length} boards, ${meta.counts.mcus} MCUs, ${meta.counts.vendors} vendors, ${meta.counts.withSvd} boards with a register map; ${(fs.statSync(out).size / 1024).toFixed(0)} KB`,
);
console.log(JSON.stringify({ counts: meta.counts, arch: meta.arch }, null, 1));
