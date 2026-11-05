// Verifies driver-sourced device facts in site/tools/devices-online/*.json against open-source driver files at pinned commits.
//   node site/tools/verify-driver-facts.mjs          (run from the project root; needs network, saves nothing to disk)
// This is a weaker check than verify-devices.mjs, which checks datasheet page quotes. Here the evidence is a line of public driver
// source (Apache-2.0 or BSD-3-Clause) fetched from raw.githubusercontent.com at an exact commit, held in memory only. A fact is:
//   cross-checked  two or more independent driver sources quote the same value,
//   single-source  only one source quotes it (the report says so),
//   conflict       sources disagree or give different parts of the value; both quotes are shown and neither is picked.
// Only facts (addresses, offsets, bit positions) are recorded; no driver code is copied. Each quote is at most 15 words.
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_WORDS = 15;
const COMMIT = /^[0-9a-f]{40}$/;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const dir = path.join('site', 'tools', 'devices-online');
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};

const cache = new Map();
async function load(src) {
  const url = `https://raw.githubusercontent.com/${src.repo}/${src.commit}/${src.path}`;
  if (!cache.has(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    cache.set(url, res.ok ? await res.text() : null);
  }
  return cache.get(url);
}

for (const f of fs
  .readdirSync(dir)
  .filter((x) => x.endsWith('.json'))
  .sort()) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log(`${m.part} (${m.sources.length} sources)`);
  const texts = {};
  for (const s of m.sources) {
    if (!COMMIT.test(s.commit)) {
      fail(`${s.id}: commit must be a full 40-character hash, not a branch`);
      continue;
    }
    const text = await load(s);
    if (text === null) {
      fail(`${s.id}: could not fetch ${s.repo}@${s.commit.slice(0, 8)}:${s.path}`);
      continue;
    }
    const head = text.split('\n').slice(0, 15).join('\n');
    if (!head.includes(`SPDX-License-Identifier: ${s.license}`)) fail(`${s.id}: header does not declare ${s.license}`);
    texts[s.id] = norm(text);
  }

  const tally = { 'cross-checked': 0, 'single-source': 0, conflict: 0 };
  for (const x of m.facts) {
    const srcs = new Set();
    for (const c of x.cites) {
      const words = norm(c.q).split(' ').length;
      if (words > MAX_WORDS) fail(`${x.id}: quote has ${words} words (max ${MAX_WORDS}): "${c.q}"`);
      else if (!texts[c.src]) fail(`${x.id}: unknown or unfetched source ${c.src}`);
      else if (!texts[c.src].includes(norm(c.q))) fail(`${x.id}: not in ${c.src}: "${c.q}"`);
      else if (!x.conflict && !norm(c.q).toLowerCase().includes(String(x.value).toLowerCase())) fail(`${x.id}: quote lacks the value ${x.value}`);
      else srcs.add(c.src);
    }
    const tier = x.conflict ? 'conflict' : srcs.size >= 2 ? 'cross-checked' : 'single-source';
    if (x.tier !== tier) fail(`${x.id}: model says ${x.tier}, evidence gives ${tier}`);
    tally[tier]++;
  }
  console.log(`  ${tally['cross-checked']} cross-checked, ${tally['single-source']} single-source, ${tally.conflict} conflict`);
  for (const g of m.gaps) console.log(`  gap: ${g}`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL DRIVER FACTS VERIFIED');
process.exit(failed ? 1 : 0);
