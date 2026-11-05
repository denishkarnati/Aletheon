// Stamps the shared navigation bar, the shared footer and the shared stylesheet link into every page, so the site has ONE menu.
//   node site/tools/stamp-chrome.mjs        (from the project root; then: npx prettier --write site && npm run site:csp)
// A link to a page that does not exist (yet) is left out, so the menu never points at a 404 while the site grows.
// The nav is replaced wherever <nav class="pill"> appears. The footer lives between <!-- chrome:footer --> markers (added once, after </main>).
import * as fs from 'node:fs';
import * as path from 'node:path';

const SITE = 'site';
export const NAV = [
  ['Atlas', 'atlas.html'],
  ['Parts', 'parts.html'],
  ['Lab', 'lab.html'],
  ['Bench', 'bench.html'],
  ['Analyzer', 'analyzer.html'],
  ['Labs', 'labs.html'],
  ['Docs', 'docs.html'],
];
const REPO = 'https://github.com/denishkarnati/Aletheon';

const MARK = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="12" width="40" height="40" rx="9" fill="#0B0D10" stroke="#F4F5F7" stroke-width="3"/><g stroke="#F4F5F7" stroke-width="3" stroke-linecap="round"><path d="M22 5v7M32 5v7M42 5v7M22 52v7M32 52v7M42 52v7M5 22h7M5 32h7M5 42h7M52 22h7M52 32h7M52 42h7"/></g><path d="M22 43 32 21l10 22" fill="none" stroke="#F4F5F7" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="36" r="3.2" fill="#7BE0AE"/></svg>`;

const exists = (href) => /^https?:/.test(href) || fs.existsSync(path.join(SITE, href.split('#')[0]));
const a = (href, label) => (exists(href) ? `<a href="${href}">${label}</a>` : '');

export function navFor(page) {
  const links = NAV.filter(([, href]) => exists(href))
    .map(([label, href]) => `<a href="${href}"${href === page ? ' class="on"' : ''}>${label}</a>`)
    .join('');
  return `<nav class="pill" aria-label="Primary"><a class="brand" href="index.html" aria-label="Aletheon home">${MARK}Aletheon</a><div class="links">${links}</div><a class="btn primary sm" href="${REPO}">GitHub</a></nav>`;
}

export function footer() {
  return `<!-- chrome:footer -->
<footer class="site">
<div class="wrap">
<div class="cols">
<div>
<div class="brandline">${MARK}Aletheon</div>
<p>An evidence-grounded firmware assistant, with a free, open set of embedded-systems tools: a board atlas, a parts catalog, datasheet-checked device models and IoT simulators.</p>
</div>
<div>
<h4>Platform</h4>
${a('atlas.html', 'Chip Atlas')}${a('parts.html', 'Parts catalog')}${a('lab.html', 'Device Lab')}${a('bench.html', 'IoT Bench')}${a('analyzer.html', 'Logic Analyzer')}${a('labs.html', 'Scenario Labs')}
</div>
<div>
<h4>Learn</h4>
${a('docs.html', 'Documentation')}${a('docs.html#methodology', 'How the models are checked')}${a('docs.html#limits', 'What the simulators leave out')}${a('index.html#install', 'Install the extension')}
</div>
<div>
<h4>Project</h4>
${a('about.html', 'About and contact')}${a(REPO, 'Source on GitHub')}${a(REPO + '/issues', 'Report an issue')}${a('about.html#security', 'Report a security problem')}${a('privacy.html', 'Privacy and legal')}
</div>
</div>
<div class="legal">
<p>Open source under Apache-2.0. Aletheon is independent and is not affiliated with, sponsored by or endorsed by any chip vendor named on this site. Part names and numbers belong to their owners. Simulators here are behavioral models, not circuit simulations, and never a substitute for the current official datasheet or for testing on real hardware.</p>
</div>
</div>
</footer>
<!-- /chrome:footer -->`;
}

export function stamp(file, html) {
  const page = path.basename(file);
  let out = html.replace(/<nav class="pill"[\s\S]*?<\/nav>/, navFor(page));
  if (!/href="assets\/nav\.css"/.test(out)) {
    const i = out.lastIndexOf('</style>');
    const link = '<link rel="stylesheet" href="assets/nav.css" />';
    out = i >= 0 ? out.slice(0, i + 8) + '\n    ' + link + out.slice(i + 8) : out.replace('</head>', `    ${link}\n  </head>`);
  }
  const block = /<!-- chrome:footer -->[\s\S]*?<!-- \/chrome:footer -->/;
  if (block.test(out)) out = out.replace(block, footer());
  else out = out.replace(/<\/main>/, `</main>\n${footer()}`);
  return out;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'stamp-chrome.mjs') {
  for (const f of fs
    .readdirSync(SITE)
    .filter((x) => x.endsWith('.html'))
    .sort()) {
    const file = path.join(SITE, f),
      html = fs.readFileSync(file, 'utf8'),
      next = stamp(file, html);
    if (next !== html) {
      fs.writeFileSync(file, next);
      console.log(`stamped ${f}`);
    }
  }
}
