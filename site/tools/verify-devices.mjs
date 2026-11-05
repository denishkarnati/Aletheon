// Verifies the device models in site/tools/devices/*.json against the vendor datasheets you downloaded yourself.
//   node site/tools/verify-devices.mjs <dir>        <dir>/<id>/ds.pdf for each device (id = file name of the model, e.g. tmp117)
// For every device it checks: the PDF's SHA-256 and size match the model, and every citation points at a real page whose text
// contains the quoted words. A citation is { p, q } (one quote) or { p, all: [...] } (several short strings); each string is at most
// 15 words, which is the quoting limit this project holds itself to. Datasheets are never copied into the repo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node site/tools/verify-devices.mjs <dir containing <id>/ds.pdf>');
  process.exit(1);
}
const unpdf = await import(pathToFileURL(path.resolve('node_modules/unpdf/dist/index.mjs')).href);
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const MAX_WORDS = 15;
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};

const modelsDir = path.join('site', 'tools', 'devices');
for (const f of fs
  .readdirSync(modelsDir)
  .filter((x) => x.endsWith('.json'))
  .sort()) {
  const m = JSON.parse(fs.readFileSync(path.join(modelsDir, f), 'utf8'));
  const pdf = path.join(dir, m.id, 'ds.pdf');
  console.log(`${m.part} (${m.source.doc})`);
  if (!fs.existsSync(pdf)) {
    fail(`missing ${pdf}`);
    continue;
  }
  const bytes = fs.readFileSync(pdf);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex'); // hash before parsing: pdf.js detaches the buffer
  if (sha !== m.source.sha256) fail(`sha256 ${sha} != model ${m.source.sha256}`);
  if (bytes.length !== m.source.bytes) fail(`size ${bytes.length} != model ${m.source.bytes}`);
  const doc = await unpdf.getDocumentProxy(new Uint8Array(bytes));
  const { text } = await unpdf.extractText(doc, { mergePages: false });
  const pages = text.map(norm);
  if (pages.length !== m.source.pages) fail(`pages ${pages.length} != model ${m.source.pages}`);

  let cites = 0,
    quotedWords = 0;
  const check = (label, c) => {
    if (!c || !Number.isInteger(c.p) || c.p < 1 || c.p > pages.length) return fail(`${label}: bad page ${c && c.p}`);
    const strs = c.all ?? (c.q ? [c.q] : []);
    if (!strs.length) return fail(`${label}: no quote`);
    for (const s of strs) {
      const words = norm(s).split(' ').length;
      cites++;
      quotedWords += words;
      if (words > MAX_WORDS) fail(`${label}: quote has ${words} words (max ${MAX_WORDS}): "${s}"`);
      else if (!pages[c.p - 1].includes(norm(s))) fail(`${label}: not on page ${c.p}: "${s}"`);
    }
  };
  check('addresses', m.addressCite);
  for (const r of m.registers) check(`register ${r.addr} ${r.name}`, r.cite);
  for (const x of m.facts) check(`fact ${x.id}`, x.cite);
  if (m.cycleTable) check('cycleTable', m.cycleTable.cite);

  for (const a of m.addresses) {
    if (a.bin !== undefined && parseInt(a.bin, 2) !== parseInt(a.addr, 16)) fail(`address ${a.strap}: ${a.bin} is not ${a.addr}`);
  }
  for (const r of m.registers) if (!/^0x[0-9A-F]{2}$/.test(r.addr) || !/^0x[0-9A-F]{4}$/.test(r.reset)) fail(`register format ${r.addr} ${r.reset}`);
  console.log(`  ${cites} quotes checked, ${quotedWords} words quoted in total`);
}
console.log(failed ? `\n${failed} FAILED` : '\nALL CITATIONS VERIFIED');
process.exit(failed ? 1 : 0);
