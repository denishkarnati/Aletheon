// Tests for the part-number tools: device_model, simulate_i2c and find_datasheet, and how they feed the evidence ledger and claim audit.
// Expected values are worked examples printed in the vendor datasheets (the same ones site/tools/test-devices.mjs uses), so a modeling
// mistake cannot pass. Offline: find_datasheet reads a catalog cache seeded from the website's own data file.
// Run: npm run test:devices
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditClaims } from '../src/core/audit';
import { MODELS, describeModel, findModel, parseCatalog, parseOps, searchCatalog } from '../src/core/devices';
import { callTool, createToolCtx, TOOLS } from '../src/core/tools';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-dev-'));
const ctx = createToolCtx({
  root,
  storeDir: path.join(root, '.aletheon'),
  getBoard: () => undefined,
  getToolchain: () => 'auto',
  getEmbedder: async () => undefined,
  confirm: async () => false,
  log: () => {},
});

async function main(): Promise<void> {
  // ---- registry and model lookup
  const names = TOOLS.map((t) => t.name);
  check(
    'the three new tools are in the shared registry (so VS Code chat and every MCP client get them)',
    ['find_datasheet', 'device_model', 'simulate_i2c'].every((n) => names.includes(n)),
  );
  check(
    'models: four datasheet-checked parts are bundled, and there is one per file in site/tools/devices',
    MODELS.length === 4 && fs.readdirSync('site/tools/devices').filter((f) => f.endsWith('.json')).length === MODELS.length,
  );
  check(
    'findModel: "TMP117", "tmp-117" and the orderable "TMP117AIDRVR" find the TMP117',
    ['TMP117', 'tmp-117', 'TMP117AIDRVR'].every((p) => findModel(p)?.id === 'tmp117'),
  );
  check(
    'findModel: "ADS1113" (a different part) does not get the ADS1115 model, and junk finds nothing',
    findModel('ADS1113') === undefined && findModel('') === undefined && findModel('???') === undefined,
  );
  const blocks = MODELS.flatMap((m) => describeModel(m));
  check(
    'describeModel: every block fits one ledger entry (1,500 characters) so no value is clipped away',
    blocks.every((b) => b.text.length <= 1500),
    String(Math.max(...blocks.map((b) => b.text.length))),
  );
  check(
    'describeModel: every register address and name of every model appears in its blocks',
    MODELS.every((m) => {
      const all = describeModel(m)
        .map((b) => b.text)
        .join('\n');
      return m.registers.every((r) => all.includes(r.addr) && all.includes(r.name)) && m.addresses.every((a) => all.includes(a.addr));
    }),
  );

  // ---- device_model
  const dm = await callTool('device_model', { part: 'TMP117' }, ctx);
  const ids = [...dm.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]);
  check(
    'device_model TMP117: returns evidence ids with the I2C addresses, strap and a page-cited quote',
    ids.length >= 3 && dm.includes('0x48 (ADD0 to GND)') && /datasheet p\.\d+: "/.test(dm),
    dm.slice(0, 200),
  );
  const e0 = ctx.ledger.items.find((e) => e.id === ids[0]);
  check(
    'device_model: the ledger entry is trust "derived" and carries the SHA-256 of the checked PDF',
    e0?.trust === 'derived' && e0.sha256 === findModel('TMP117')!.source.sha256 && e0.kind === 'datasheet',
    JSON.stringify(e0),
  );
  check(
    'device_model: an unmodeled part is refused with the list of modeled ones, never invented',
    /No datasheet-checked model/.test(await callTool('device_model', { part: 'STM32F401' }, ctx)),
  );

  // the audit must accept a claim that cites this evidence and flag the same claim without a citation
  const good = auditClaims(`The TMP117 answers at 0x48 when ADD0 is tied to GND [${ids[0]}].`, ctx.ledger);
  const bad = auditClaims('The TMP117 answers at 0x48 when ADD0 is tied to GND.', ctx.ledger);
  check(
    'audit: the I2C address claim passes when it cites the device_model evidence',
    good.claims.every((c) => c.status === 'supported'),
    JSON.stringify(good.claims.map((c) => c.status)),
  );
  check(
    'audit: the same claim without a citation is flagged',
    bad.claims.some((c) => c.status !== 'supported'),
    JSON.stringify(bad.claims.map((c) => c.status)),
  );

  // ---- simulate_i2c: datasheet worked examples
  const sim = async (args: unknown): Promise<string> => callTool('simulate_i2c', args, ctx);
  const t1 = await sim({
    part: 'TMP117',
    inputs: { temp: 25 },
    ops: [
      { op: 'write', addr: 0x48, bytes: [0x0f] },
      { op: 'read', addr: 0x48, n: 2 },
      { op: 'delay', ms: 200 },
      { op: 'write', addr: 0x48, bytes: [0x00] },
      { op: 'read', addr: 0x48, n: 2 },
    ],
  });
  check('simulate_i2c TMP117: Device_ID reads 0x01 0x17', /Device_ID[^\n]*-> 0x0117|-> \[0x01 0x17\]/.test(t1), t1);
  check('simulate_i2c TMP117: 25 C reads 0x0C 0x80 (3200 counts of 7.8125 mC) after the first conversion', t1.includes('-> [0x0C 0x80]'), t1);
  check(
    'simulate_i2c: the result is recorded as evidence with trust "derived" and kind "sim"',
    (() => {
      const id = /^\[(E\d+)\]/.exec(t1)?.[1];
      const e = ctx.ledger.items.find((x) => x.id === id);
      return e?.kind === 'sim' && e.trust === 'derived';
    })(),
  );
  const early = await sim({
    part: 'TMP117',
    ops: [
      { op: 'write', addr: 0x48, bytes: [0x00] },
      { op: 'read', addr: 0x48, n: 2 },
    ],
  });
  check('simulate_i2c TMP117: reading before the first conversion gives 0x8000 (-256 C), the classic bring-up trap', early.includes('-> [0x80 0x00]'), early);
  const nack = await sim({ part: 'TMP117', ops: [{ op: 'write', addr: 0x49, bytes: [0x00] }] });
  check(
    'simulate_i2c: the wrong address (0x49 with ADD0 to GND) is a NACK that names the right address',
    /NACK: nothing answers at 0x49; the part is at 0x48/.test(nack) && /1 NACK/.test(nack),
    nack,
  );
  const ro = await sim({ part: 'TMP117', ops: [{ op: 'write', addr: 0x48, bytes: [0x0f, 0x12, 0x34] }] });
  check('simulate_i2c: writing a read-only register (Device_ID) warns and is ignored', /WARNING/.test(ro) && /read-only/.test(ro), ro);
  const strapped = await sim({
    part: 'TMP117',
    addr: 0x49,
    ops: [
      { op: 'write', addr: 0x49, bytes: [0x0f] },
      { op: 'read', addr: 0x49, n: 2 },
    ],
  });
  check('simulate_i2c: the part can be placed at another strapped address', /-> \[0x01 0x17\]/.test(strapped));
  const ina = await sim({
    part: 'INA226',
    inputs: { vbus: 11.98, iload: 10, rshunt: 0.002 },
    ops: [
      { op: 'write', addr: 0x40, bytes: [0x05, 0x0a, 0x00] },
      { op: 'write', addr: 0x40, bytes: [0x04] },
      { op: 'read', addr: 0x40, n: 2 },
    ],
  });
  check(
    'simulate_i2c INA226: datasheet example (20 mV across 2 mOhm, calibration 2560) gives current register 10000 = 0x2710',
    ina.includes('-> [0x27 0x10]'),
    ina,
  );
  const inaNoCal = await sim({
    part: 'INA226',
    inputs: { vbus: 11.98, iload: 10, rshunt: 0.002 },
    ops: [
      { op: 'write', addr: 0x40, bytes: [0x04] },
      { op: 'read', addr: 0x40, n: 2 },
    ],
  });
  check(
    'simulate_i2c INA226: without writing the calibration register the current reads 0 (the other classic bring-up trap)',
    inaNoCal.includes('-> [0x00 0x00]'),
    inaNoCal,
  );
  const ads = await sim({
    part: 'ADS1115',
    inputs: { ain0: 1.65 },
    ops: [
      { op: 'write', addr: 0x48, bytes: [0x01, 0xc3, 0x83] },
      { op: 'delay', ms: 10 },
      { op: 'write', addr: 0x48, bytes: [0x00] },
      { op: 'read', addr: 0x48, n: 2 },
    ],
  });
  check('simulate_i2c ADS1115: single-shot AIN0 at +-4.096 V reads 1.65 V as 13200 = 0x3390', ads.includes('-> [0x33 0x90]'), ads);

  // ---- argument validation: nothing the model sends can run code or loop forever
  const bad1 = [
    { part: 'TMP117', ops: [] },
    { part: 'TMP117', ops: [{ op: 'eval', code: 'x' }] },
    { part: 'TMP117', ops: [{ op: 'write', addr: 300, bytes: [0] }] },
    { part: 'TMP117', ops: [{ op: 'write', addr: 0x48, bytes: [256] }] },
    { part: 'TMP117', ops: [{ op: 'read', addr: 0x48, n: 1000 }] },
    { part: 'TMP117', ops: [{ op: 'delay', ms: 1e12 }] },
    { part: 'TMP117', ops: Array.from({ length: 201 }, () => ({ op: 'delay', ms: 1 })) },
    { part: 'TMP117', inputs: { nope: 1 }, ops: [{ op: 'delay', ms: 1 }] },
    {
      part: 'TMP117',
      ops: [
        { op: 'delay', ms: 400000 },
        { op: 'delay', ms: 400000 },
      ],
    },
  ];
  const results = await Promise.all(bad1.map((a) => sim(a)));
  check(
    'simulate_i2c: empty, unknown, out-of-range and oversized operation lists are all rejected with an error',
    results.every((r) => /^Error:/.test(r)),
    results
      .filter((r) => !/^Error:/.test(r))
      .join(' | ')
      .slice(0, 200),
  );
  check(
    'parseOps: only write/read/delay/set exist, so there is no code path from a model-supplied value to execution',
    (() => {
      try {
        parseOps([{ op: 'write', addr: 1, bytes: [1], extra: 'ignored' }]);
        return true;
      } catch {
        return false;
      }
    })(),
  );

  // ---- find_datasheet against the real catalog (seeded as the cache, so no network)
  const cache = path.join(root, '.aletheon', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.copyFileSync('site/assets/parts-data.js', path.join(cache, 'parts-catalog.js'));
  const rows = parseCatalog(fs.readFileSync('site/assets/parts-data.js', 'utf8'));
  check('catalog: the real data file parses (9,000+ parts)', rows.length > 9000, String(rows.length));
  const tmp = searchCatalog(rows, 'TMP117');
  check(
    'catalog: a search for TMP117 finds TMP117 parts with a TI datasheet link',
    tmp.length >= 1 && tmp.every((r) => r[0].toUpperCase().includes('TMP117')) && tmp.some((r) => /ti\.com/.test(r[5])),
    JSON.stringify(tmp.map((r) => [r[0], r[5]])),
  );
  const fd = await callTool('find_datasheet', { part: 'ADS1115' }, ctx);
  const fdId = /^\[(E\d+)\]/.exec(fd)?.[1];
  const fe = ctx.ledger.items.find((e) => e.id === fdId);
  check(
    'find_datasheet: returns the vendor datasheet URL, logged as a community-derived pointer (never vendor-official evidence)',
    /ADS1115/.test(fd) && /https?:\/\/\S+\.pdf/i.test(fd) && fe?.trust === 'community-mirror' && /not evidence/.test(fd),
    fd.slice(0, 300),
  );
  check('find_datasheet: tells the model the next step (index_datasheet then search_datasheets)', /index_datasheet/.test(fd) && /search_datasheets/.test(fd));
  check(
    'find_datasheet: an unknown part number gets an honest "no match", not a guess',
    /No part matching/.test(await callTool('find_datasheet', { part: 'ZZQ-NOPE-9999' }, ctx)),
  );
  check(
    'find_datasheet: rejects an empty or oversized query',
    /^Error/.test(await callTool('find_datasheet', { part: '   ' }, ctx)) && /^Error/.test(await callTool('find_datasheet', { part: 'x'.repeat(200) }, ctx)),
  );
  process.env.ALETHEON_PARTS_URL = 'http://insecure.example/parts.js';
  fs.rmSync(path.join(cache, 'parts-catalog.js'));
  check('find_datasheet: a non-https catalog URL is refused', /https/.test(await callTool('find_datasheet', { part: 'TMP117' }, ctx)));
  delete process.env.ALETHEON_PARTS_URL;

  if (failed) {
    console.log(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall device tool checks passed');
}
void main();
