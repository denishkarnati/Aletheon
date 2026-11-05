// Checks that every page carries a current Content-Security-Policy and that nothing in the pages would fight it.
//   node site/tools/test-csp.mjs      (from the project root)
// A stale hash (an inline script changed after make-csp.mjs ran) would make the browser refuse the script and the page would look dead,
// so this must pass before every deploy. Fix: prettier --write site, then node site/tools/make-csp.mjs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ASSET_CACHE, OTHER_HEADERS, PAGE_CACHE, inlineScripts, policyFor } from './make-csp.mjs';

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
const headers = fs.existsSync(path.join(SITE, '_headers')) ? fs.readFileSync(path.join(SITE, '_headers'), 'utf8') : '';
check('there are pages to protect', pages.length >= 5, String(pages.length));
check('site/_headers exists', headers.length > 0);

for (const f of pages) {
  const html = fs.readFileSync(path.join(SITE, f), 'utf8');
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi)];
  check(`${f}: exactly one CSP <meta> tag`, metas.length === 1, String(metas.length));
  const want = policyFor(f, html);
  check(`${f}: the policy is current (inline script hashes match)`, metas[0]?.[1] === want, 'run: prettier --write site && node site/tools/make-csp.mjs');
  const firstScript = html.search(/<script\b/i);
  check(`${f}: the policy comes before the first <script>`, metas[0] !== undefined && (firstScript < 0 || metas[0].index < firstScript));
  const scriptSrc = (metas[0]?.[1] ?? '').match(/script-src ([^;]*)/)?.[1] ?? '';
  const lab = f === 'lab.html';
  check(
    `${f}: script-src ${lab ? 'allows eval only here (Device Lab worker)' : 'has no unsafe-eval or unsafe-inline'}`,
    lab ? /'unsafe-eval'/.test(scriptSrc) && !/'unsafe-inline'/.test(scriptSrc) : !/'unsafe-(eval|inline)'/.test(scriptSrc),
    scriptSrc,
  );
  if (lab)
    check(
      'lab.html: no network from the sandbox (connect-src none) and blob: workers allowed',
      /connect-src 'none'/.test(want) && /worker-src blob:/.test(want),
    );
  check(
    `${f}: default-src is none, no <base>, no forms or plugins possible`,
    /default-src 'none'/.test(want) && /base-uri 'none'/.test(want) && /form-action 'none'/.test(want) && /object-src 'none'/.test(want),
  );
  const route = f === 'index.html' ? '/' : `/${f}`;
  const block = headers.split('\n\n').find((b) => b.startsWith(route + '\n'));
  check(
    `${f}: _headers carries the same policy as a real header (plus frame-ancestors)`,
    !!block && block.includes(`Content-Security-Policy: ${policyFor(f, html, { header: true })}`),
    route,
  );
  check(
    `${f}: no inline event handlers (onclick=...) and no javascript: links`,
    !/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')) && !/(href|src)\s*=\s*["']\s*javascript:/i.test(html),
  );
  check(
    `${f}: no <iframe>, <form>, <object>, <embed> or remote stylesheet/script`,
    !/<(iframe|form|object|embed)\b/i.test(html) &&
      !/<(script|link)\b[^>]*(src|href)\s*=\s*["']https?:\/\//i.test(html.replace(/<link\b[^>]*rel=["'](?:icon|canonical|alternate)["'][^>]*>/gi, '')),
  );
  check(`${f}: no plain http:// link`, !/(href|src)\s*=\s*["']http:\/\/(?!127\.0\.0\.1|localhost)/i.test(html));
  check(
    `${f}: inline scripts are all accounted for`,
    inlineScripts(html).every((s) => want.includes("'sha256-")),
    '',
  );
}

check(
  '_headers: every page route revalidates quickly',
  pages.every((f) =>
    (headers.split('\n\n').find((b) => b.startsWith((f === 'index.html' ? '/' : `/${f}`) + '\n')) ?? '').includes(`Cache-Control: ${PAGE_CACHE}`),
  ),
);
check(
  '_headers: /assets/* is cached for a day with stale-while-revalidate, and is not immutable',
  headers.includes(`/assets/*\n  Cache-Control: ${ASSET_CACHE}`) && !/immutable/i.test(headers),
);
check('_headers: no Content-Encoding rule (the host compresses by itself)', !/Content-Encoding/i.test(headers));
for (const [k, v] of OTHER_HEADERS) check(`_headers sets ${k}`, headers.includes(`  ${k}: ${v}`));
check(
  '_headers never puts a Content-Security-Policy on the catch-all /* rule (that would be enforced on top of each page)',
  !/\/\*\n(?:  [^\n]+\n)*?  Content-Security-Policy/.test(headers),
);

const sec = path.join(SITE, '.well-known', 'security.txt');
const txt = fs.existsSync(sec) ? fs.readFileSync(sec, 'utf8') : '';
const exp = /^Expires:\s*(\S+)/m.exec(txt)?.[1];
check('security.txt tells researchers how to report a problem', /^Contact:\s*\S+/m.test(txt));
check(
  'security.txt has an Expires date in the future and within a year (RFC 9116)',
  !!exp && Date.parse(exp) > Date.now() && Date.parse(exp) < Date.now() + 366 * 864e5,
  String(exp),
);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
