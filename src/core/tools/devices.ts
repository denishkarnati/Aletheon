// Part-number tools: find a part's datasheet link, read its datasheet-checked model, and check a sequence of I2C operations against that model.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODELS, PartRow, describeModel, findModel, parseCatalog, parseOps, searchCatalog, simulateI2c } from '../devices';
import { safeGet } from '../net';
import { classifyTrust } from '../provenance';
import { Tool, obj, str } from './context';

const CATALOG_URL = 'https://denishkarnati.github.io/Aletheon/assets/parts-data.js';
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const CATALOG_MAX_BYTES = 12 * 1024 * 1024;

async function loadCatalog(storeDir: string): Promise<{ rows: PartRow[]; from: string }> {
  const url = process.env.ALETHEON_PARTS_URL || CATALOG_URL;
  if (!/^https:\/\//i.test(url)) throw new Error('ALETHEON_PARTS_URL must be an https URL');
  const file = path.join(storeDir, 'cache', 'parts-catalog.js');
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < CACHE_MAX_AGE_MS) return { rows: parseCatalog(fs.readFileSync(file, 'utf8')), from: `cache of ${url}` };
  } catch {
    /* no usable cache: fetch */
  }
  const r = await safeGet(url, { maxBytes: CATALOG_MAX_BYTES, timeoutMs: 30_000 });
  if (r.status !== 200) throw new Error(`the catalog answered HTTP ${r.status}`);
  const text = r.body.toString('utf8');
  const rows = parseCatalog(text); // validates before it is cached
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { rows, from: url };
}

export const deviceTools: Tool[] = [
  {
    name: 'find_datasheet',
    description:
      'Find the datasheet link for a part number (e.g. "TMP117", "ESP32-C3", "INA226") in the parts catalog (about 9,000 parts, built from the KiCad symbol libraries). ' +
      'Returns candidate parts with vendor, description and datasheet URL. The catalog row only POINTS to a datasheet: it is a community-derived link, never evidence for an address or register. ' +
      'Next: index_datasheet on the URL, then search_datasheets, and cite those passages. If the vendor blocks automated downloads, ask the user for the PDF.',
    input_schema: obj({ part: str('part number or a few words, e.g. "TMP117" or "ADS1115 ADC"'), limit: { type: 'number' } }, ['part']),
    async run(a, ctx) {
      const q = String(a.part).trim();
      if (!q || q.length > 80) return 'Error: give a part number of 1-80 characters.';
      const { rows, from } = await loadCatalog(ctx.host.storeDir);
      const hits = searchCatalog(rows, q, Math.min(15, Math.max(1, Number(a.limit) || 8)));
      if (!hits.length)
        return `No part matching "${q}" in the catalog (${rows.length} parts, from ${from}). Try the manufacturer's name or ask the user for the datasheet.`;
      const lines = hits.map((r) => {
        const trust = r[5] ? classifyTrust(r[5]) : 'unknown';
        return `${r[0]}: ${r[1]} | vendor ${r[4] || 'unknown'} | category ${r[3]}${r[10] ? ' | interfaces ' + r[10] : ''} | datasheet ${r[5] || 'none listed'} (${trust === 'vendor-official' ? 'vendor domain' : 'not a recognised vendor domain'})`;
      });
      const e = ctx.ledger.add('web', from, `Catalog lookup for "${q}":\n${lines.join('\n')}`, { trust: 'community-mirror' });
      return `[${e.id}] ${hits.length} catalog match(es) for "${q}" (a pointer to datasheets, not evidence of any value):\n${lines.join('\n')}\n\nNext: index_datasheet with the datasheet URL, then search_datasheets for the I2C address, registers and timing.`;
    },
  },
  {
    name: 'device_model',
    description:
      `Read the datasheet-checked behavioral model of a part: I2C addresses (with the pin strapping for each), every modeled register with access and reset value, ` +
      `and each documented behavior, each with a page-cited datasheet quote that a script verified against the vendor PDF. Available parts: ${MODELS.map((m) => m.part).join(', ')}. ` +
      'Results are recorded as evidence [E#] (trust: derived, from a verified datasheet). It lists what the model leaves out. For other parts use find_datasheet and index_datasheet.',
    input_schema: obj({ part: str('part number, e.g. TMP117 (an orderable name like TMP117AIDRVR also works)') }, ['part']),
    async run(a, ctx) {
      const m = findModel(String(a.part));
      if (!m)
        return `No datasheet-checked model for "${a.part}". Modeled parts: ${MODELS.map((x) => x.part).join(', ')}. For anything else: find_datasheet, index_datasheet, search_datasheets, and report UNVERIFIED what you cannot cite.`;
      const parts = describeModel(m).map((b) => {
        const e = ctx.ledger.add('datasheet', m.source.url, b.text, { trust: 'derived', sha256: m.source.sha256 });
        return `[${e.id}] (${b.title})\n${b.text}`;
      });
      const inputs = m.inputs.map((i) => `${i.id} (${i.label}, ${i.unit}, default ${i.default})`).join('; ');
      return `${parts.join('\n\n')}\n\nPhysical inputs for simulate_i2c: ${inputs}. This is a behavioral model checked against datasheet ${m.source.doc}; it is not proof of behavior on real hardware.`;
    },
  },
  {
    name: 'simulate_i2c',
    description:
      'Check a planned I2C sequence against the datasheet-checked model of a part BEFORE flashing: each operation is ACKed or NACKed, reads return the bytes the documented registers would give, ' +
      'and every step is explained (which register, what value, why) with warnings for read-only writes, wrong lengths and wrong addresses. Parts: ' +
      `${MODELS.map((m) => m.part).join(', ')}. ops is a list of {op:"write",addr,bytes:[..]}, {op:"read",addr,n}, {op:"delay",ms} or {op:"set",input,value} (change a physical input such as temperature). ` +
      'Addresses are 7-bit. Use it to confirm the address, register pointer, configuration word and result decoding. A pass means the sequence is consistent with the documented behavior; it does NOT prove the code works on a board (build, flash and serial_capture do that).',
    input_schema: obj(
      {
        part: str('modeled part number, e.g. TMP117'),
        addr: { type: 'number', description: '7-bit address of the simulated part (default: the first address in its datasheet table)' },
        inputs: { type: 'object', description: 'starting physical inputs, e.g. {"temp": 25}' },
        ops: { type: 'array', description: 'operations in order' },
      },
      ['part', 'ops'],
    ),
    async run(a, ctx) {
      const m = findModel(String(a.part));
      if (!m) return `No datasheet-checked model for "${a.part}". Modeled parts: ${MODELS.map((x) => x.part).join(', ')}.`;
      const inputs = a.inputs && typeof a.inputs === 'object' && !Array.isArray(a.inputs) ? (a.inputs as Record<string, number>) : undefined;
      const r = simulateI2c(m, parseOps(a.ops), { addr: a.addr === undefined ? undefined : Number(a.addr), inputs });
      const regs = r.registers.map((x) => `${x.addr} ${x.name} (${x.access}) = ${x.value}`).join('\n');
      const verdict = `${r.nacks} NACK(s), ${r.warnings} warning(s), ${r.simMs} ms simulated`;
      const text = `${m.part} simulated at 0x${r.addr.toString(16).toUpperCase()} (datasheet ${m.source.doc}):\n${r.lines.join('\n')}\n\nRegisters after the run:\n${regs}\n\nResult: ${verdict}.`;
      const e = ctx.ledger.add('sim', `simulate_i2c ${m.part}`, text, { trust: 'derived' });
      return `[${e.id}] ${text}\n\nSimulation shows consistency with the documented behavior of ${m.part}. It leaves out: ${m.notModeled.slice(0, 4).join('; ')}. Say so, and do not claim the code works on hardware until a build and a real capture show it.`;
    },
  },
];
