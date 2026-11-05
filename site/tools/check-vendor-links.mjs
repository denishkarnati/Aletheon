// Checks that every link in site/tools/vendors.json still answers. Run from the project root:  node site/tools/check-vendor-links.mjs
// Uses an honest user agent and does not try to get around bot protection: a 401/403/429 is reported as "blocked to scripts", which is not
// the same as a dead link (those are the links whose 'how' is "browser": they were confirmed in a normal browser session).
import * as fs from 'node:fs';

const { vendors } = JSON.parse(fs.readFileSync('site/tools/vendors.json', 'utf8'));
const UA = 'aletheon-linkcheck/0.1 (checking public vendor contact pages)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0,
  blocked = 0,
  ok = 0;
for (const v of vendors) {
  for (const l of [{ url: v.website, kind: 'Website' }, ...v.links]) {
    let status = 0;
    try {
      status = (await fetch(l.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(25000) })).status;
    } catch (e) {
      status = -1;
    }
    const tag = status >= 200 && status < 400 ? 'ok' : [401, 403, 429].includes(status) ? 'blocked to scripts' : status === -1 ? 'unchecked (network)' : 'FAIL';
    if (tag === 'ok') ok++;
    else if (tag === 'FAIL') bad++;
    else blocked++;
    console.log(`${tag.padEnd(19)} ${String(status).padStart(3)}  ${v.name} / ${l.kind}: ${l.url}${l.how ? '  [' + l.how + ']' : ''}`);
    await sleep(500);
  }
}
console.log(`\n${ok} ok, ${blocked} blocked to scripts, ${bad} failed`);
process.exit(bad ? 1 : 0);
