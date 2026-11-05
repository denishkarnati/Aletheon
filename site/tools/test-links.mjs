// Link and structure check for every site page. Run from the project root:  node site/tools/test-links.mjs
//  - every relative href / src points at a file that exists in site/ (and is not in tools/, which is never published)
//  - every #fragment on an internal link names an id that exists on the target page (#key=value links are page state, not anchors)
//  - every page has the shared menu (the same set of links), the shared stylesheet, a title, a description and exactly one <h1>
//  - no page uses inline event handlers (the CSP would block them and they hide bugs)
import * as fs from 'node:fs';
import * as path from 'node:path';

const SITE = 'site';
let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const pages = fs
  .readdirSync(SITE)
  .filter((f) => f.endsWith('.html'))
  .sort();
const html = Object.fromEntries(pages.map((f) => [f, fs.readFileSync(path.join(SITE, f), 'utf8')]));
const ids = (h) => new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const idsOf = Object.fromEntries(pages.map((f) => [f, ids(html[f])]));

let menu = null;
for (const f of pages) {
  const h = html[f];
  const bad = [];
  for (const m of h.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const v = m[1];
    if (!v || /^(https?:|mailto:|data:|javascript:)/i.test(v)) continue;
    const [file, frag] = [v.split('#')[0].split('?')[0], v.includes('#') ? v.split('#')[1] : ''];
    const target = file === '' ? f : file;
    const full = path.join(SITE, target);
    if (target.startsWith('tools/') || target.startsWith('../') || !fs.existsSync(full)) {
      bad.push(`${v} (missing file)`);
      continue;
    }
    if (frag && !frag.includes('=') && target.endsWith('.html') && !idsOf[target]?.has(frag)) bad.push(`${v} (no id "${frag}")`);
  }
  check(`${f}: every local link, script and image resolves`, bad.length === 0, bad.join('; '));
  check(
    `${f}: has a title, a description, the viewport tag and one <h1>`,
    /<title>[^<]{3,}<\/title>/.test(h) &&
      /name="description"\s+content="[^"]{30,}"/.test(h.replace(/\s+/g, ' ')) &&
      /name="viewport"/.test(h) &&
      (h.match(/<h1[\s>]/g) || []).length === 1,
    f,
  );
  check(`${f}: no inline event handler attributes (onclick=...)`, !/<[a-z][^<>]*\son[a-z]+\s*=/i.test(h));
  const nav = /<nav class="pill"[\s\S]*?<\/nav>/.exec(h)?.[0] ?? '';
  const links = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).join(',');
  menu = menu ?? links;
  check(`${f}: has the shared menu (same links as every other page)`, nav !== '' && links === menu, links);
  check(`${f}: loads the shared nav stylesheet and carries the shared footer`, /assets\/nav\.css/.test(h) && /<footer class="site">/.test(h));
}
if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall link and structure checks passed');
