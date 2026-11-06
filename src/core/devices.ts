// Datasheet-checked device models and the part-number catalog lookup, for the assistant's tools.
//
// The models are the same JSON files the website's Device Lab uses (site/tools/devices/*.json). Every register, address and behavior in them
// carries a page-cited quote of at most 15 words, and site/tools/verify-devices.mjs checks each quote against the vendor PDF. The simulator is
// the Device Lab's own register-level core. It is a BEHAVIORAL model: it shows whether a sequence of I2C operations is consistent with the
// documented behavior, not that real hardware or a real board will behave that way.
import { core as makeCore } from '../../site/assets/devicecore.js';
import ads1115 from '../../site/tools/devices/ads1115.json';
import ina219 from '../../site/tools/devices/ina219.json';
import ina226 from '../../site/tools/devices/ina226.json';
import tmp117 from '../../site/tools/devices/tmp117.json';

export interface Cite {
  p: number;
  q?: string;
  all?: string[];
}
export interface DeviceModel {
  id: string;
  part: string;
  kind: string;
  vendor: string;
  summary: string;
  source: { doc: string; rev: string; url: string; sha256: string; bytes: number; pages: number };
  addresses: { strap: string; addr: string }[];
  addressCite: Cite;
  registers: { addr: string; name: string; access: string; reset: string; cite: Cite }[];
  facts: { id?: string; text: string; cite: Cite; derived?: boolean }[];
  notModeled: string[];
  inputs: { id: string; label: string; unit: string; min: number; max: number; default: number }[];
}

export const MODELS = [ads1115, ina219, ina226, tmp117] as unknown as DeviceModel[];
const sim = makeCore({ devices: MODELS });

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// "TMP117", "tmp-117" and an orderable name such as "TMP117AIDRVR" all find the TMP117 model; "ADS1113" does not find the ADS1115.
export function findModel(part: string): DeviceModel | undefined {
  const q = norm(part);
  return q ? MODELS.find((m) => q.startsWith(norm(m.part))) : undefined;
}

const quote = (c: Cite): string => `[datasheet p.${c.p}: ${(c.all ?? (c.q ? [c.q] : [])).map((s) => `"${s}"`).join(' ')}]`;
const hex = (n: number, w = 2): string => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

// Text blocks, each short enough to be kept whole as one evidence entry (the ledger clips at 1,500 characters).
export function describeModel(m: DeviceModel): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  const head =
    `${m.part}: ${m.kind} (${m.vendor}). Model written from datasheet ${m.source.doc} ${m.source.rev}; the checked PDF has SHA-256 ${m.source.sha256}. Official copy: ${m.source.url}\n` +
    `I2C 7-bit addresses: ${m.addresses.map((a) => `${a.addr} (${a.strap})`).join('; ')} ${quote(m.addressCite)}`;
  out.push({ title: 'source and addresses', text: head });
  const chunk = (title: string, lines: string[]): void => {
    let cur = '';
    let n = 0;
    for (const l of lines) {
      if (cur && cur.length + l.length > 1300) {
        out.push({ title: `${title} ${++n}`, text: cur });
        cur = '';
      }
      cur += (cur ? '\n' : '') + l;
    }
    if (cur) out.push({ title: n ? `${title} ${n + 1}` : title, text: cur });
  };
  chunk(
    'registers',
    m.registers.map((r) => `${m.part} register ${r.addr} ${r.name}, ${r.access}, reset ${r.reset} ${quote(r.cite)}`),
  );
  chunk(
    'behaviors',
    m.facts.map((f) => `${m.part}: ${f.text}${f.derived ? ' (derived, not stated in the datasheet)' : ''} ${quote(f.cite)}`),
  );
  out.push({ title: 'what the model leaves out', text: `${m.part} model does NOT cover: ${m.notModeled.join('; ')}` });
  return out;
}

// ---- simulate_i2c ----------------------------------------------------------------------------------------------------------------------
export type Op =
  | { op: 'write'; addr: number; bytes: number[] }
  | { op: 'read'; addr: number; n: number }
  | { op: 'delay'; ms: number }
  | { op: 'set'; input: string; value: number };

export const SIM_LIMITS = { ops: 200, bytes: 16, totalMs: 600_000 };

const isByte = (b: unknown): b is number => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255;
const isAddr = (a: unknown): a is number => typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 127;

export function parseOps(raw: unknown): Op[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('ops must be a non-empty array');
  if (raw.length > SIM_LIMITS.ops) throw new Error(`at most ${SIM_LIMITS.ops} operations`);
  return raw.map((o, i): Op => {
    const at = `ops[${i}]`;
    if (!o || typeof o !== 'object') throw new Error(`${at} must be an object`);
    const r = o as Record<string, unknown>;
    switch (r.op) {
      case 'write':
        if (!isAddr(r.addr)) throw new Error(`${at}.addr must be an integer 0-127 (7-bit address)`);
        if (!Array.isArray(r.bytes) || r.bytes.length > SIM_LIMITS.bytes || !r.bytes.every(isByte))
          throw new Error(`${at}.bytes must be up to ${SIM_LIMITS.bytes} integers 0-255`);
        return { op: 'write', addr: r.addr, bytes: r.bytes as number[] };
      case 'read':
        if (!isAddr(r.addr)) throw new Error(`${at}.addr must be an integer 0-127 (7-bit address)`);
        if (typeof r.n !== 'number' || !Number.isInteger(r.n) || r.n < 1 || r.n > SIM_LIMITS.bytes)
          throw new Error(`${at}.n must be an integer 1-${SIM_LIMITS.bytes}`);
        return { op: 'read', addr: r.addr, n: r.n };
      case 'delay':
        if (typeof r.ms !== 'number' || !(r.ms >= 0) || r.ms > SIM_LIMITS.totalMs) throw new Error(`${at}.ms must be 0-${SIM_LIMITS.totalMs}`);
        return { op: 'delay', ms: r.ms };
      case 'set':
        if (typeof r.input !== 'string' || typeof r.value !== 'number' || !Number.isFinite(r.value))
          throw new Error(`${at} needs input (string) and value (number)`);
        return { op: 'set', input: r.input, value: r.value };
      default:
        throw new Error(`${at}.op must be "write", "read", "delay" or "set"`);
    }
  });
}

export interface SimResult {
  lines: string[];
  registers: { addr: string; name: string; access: string; value: string }[];
  nacks: number;
  warnings: number;
  simMs: number;
  addr: number;
}

export function simulateI2c(model: DeviceModel, ops: Op[], opt: { addr?: number; inputs?: Record<string, number> } = {}): SimResult {
  const addr = opt.addr ?? parseInt(model.addresses[0].addr, 16);
  if (!isAddr(addr)) throw new Error('addr must be an integer 0-127');
  for (const [k, v] of Object.entries(opt.inputs ?? {})) {
    if (!model.inputs.some((i) => i.id === k))
      throw new Error(`no physical input "${k}" on ${model.part} (inputs: ${model.inputs.map((i) => i.id).join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`input ${k} must be a finite number`);
  }
  const dev = sim.makeDevice(model.id, addr, opt.inputs);
  const lines: string[] = [];
  let t = 0;
  let nacks = 0;
  let warnings = 0;
  const stamp = (): string => `t=${(Math.round(t * 1000) / 1000).toString().padStart(8)} ms`;
  for (const o of ops) {
    if (o.op === 'delay') {
      if (t + o.ms > SIM_LIMITS.totalMs) throw new Error(`simulated time would pass ${SIM_LIMITS.totalMs / 1000} s`);
      t += o.ms;
      dev.advance(o.ms);
      lines.push(`${stamp()}  delay ${o.ms} ms`);
    } else if (o.op === 'set') {
      try {
        dev.setInput(o.input, o.value);
        lines.push(`${stamp()}  physical input ${o.input} = ${o.value}`);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
      }
    } else if (o.addr !== dev.addr) {
      nacks++;
      lines.push(
        `${stamp()}  ${o.op === 'write' ? 'W' : 'R'} ${hex(o.addr)}${o.op === 'write' ? ' [' + o.bytes.map((b) => hex(b)).join(' ') + ']' : ' x' + o.n}  NACK: nothing answers at ${hex(o.addr)}; the part is at ${hex(dev.addr)}`,
      );
    } else if (o.op === 'write') {
      const r = dev.write(o.bytes);
      warnings += r.warns.length;
      lines.push(
        `${stamp()}  W ${hex(o.addr)} [${o.bytes.map((b) => hex(b)).join(' ')}]  ACK  ${r.notes.join('; ')}${r.warns.map((w) => '  WARNING: ' + w).join('')}`,
      );
    } else {
      const r = dev.read(o.n);
      warnings += r.warns.length;
      lines.push(
        `${stamp()}  R ${hex(o.addr)} x${o.n}  ACK  -> [${r.bytes.map((b) => hex(b)).join(' ')}]  ${r.notes.join('; ')}${r.warns.map((w) => '  WARNING: ' + w).join('')}`,
      );
    }
  }
  return { lines, registers: dev.snapshot(), nacks, warnings, simMs: t, addr: dev.addr };
}

// ---- part-number catalog ---------------------------------------------------------------------------------------------------------------
// Rows of the website's parts catalog (derived from the KiCad symbol libraries, CC BY-SA 4.0). Column order is the file's own "cols".
export type PartRow = [
  name: string,
  desc: string,
  lib: string,
  cat: string,
  vendor: string,
  ds: string,
  fp: string,
  pins: number,
  pinNames: string,
  kw: string,
  ifaces: string,
];

export function parseCatalog(text: string): PartRow[] {
  const i = text.indexOf('window.PARTS=');
  if (i < 0) throw new Error('not a parts catalog file');
  const data = JSON.parse(text.slice(i + 'window.PARTS='.length).replace(/;\s*$/, '')) as { rows?: unknown };
  if (!Array.isArray(data.rows)) throw new Error('catalog has no rows');
  return data.rows as PartRow[];
}

export function searchCatalog(rows: PartRow[], query: string, limit = 8): PartRow[] {
  const tokens = query.toUpperCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored: { r: PartRow; s: number }[] = [];
  const q = norm(query);
  for (const r of rows) {
    const name = r[0].toUpperCase();
    const hay = `${name} ${r[1]} ${r[9]}`.toUpperCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    const n = norm(name);
    scored.push({ r, s: n === q ? 100 : n.startsWith(q) ? 60 : n.includes(q) ? 40 : 5 });
  }
  return scored
    .sort((a, b) => b.s - a.s || a.r[0].length - b.r[0].length)
    .slice(0, limit)
    .map((x) => x.r);
}
