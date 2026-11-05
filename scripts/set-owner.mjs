// Replaces the GITHUB_OWNER placeholder with your GitHub user or org, once, before the first public push.
//   node scripts/set-owner.mjs your-github-name
import * as fs from 'node:fs';
import * as path from 'node:path';

const owner = process.argv[2];
if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error('usage: node scripts/set-owner.mjs <github-user-or-org>');
  process.exit(1);
}
const skip = new Set(['node_modules', 'dist', '.git']);
let files = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(md|html|json|yml|yaml|mjs|ts|txt)$/.test(e.name) || e.name === 'NOTICE') {
      if (e.name === 'set-owner.mjs') continue;
      const s = fs.readFileSync(p, 'utf8');
      if (s.includes('GITHUB_OWNER')) {
        fs.writeFileSync(p, s.replaceAll('GITHUB_OWNER', owner));
        files++;
      }
    }
  }
};
walk('.');
console.log(`replaced GITHUB_OWNER with ${owner} in ${files} file(s)`);
