import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { readSource } from './net';
import { TrustClass, classifyTrust, sha256, sourceId, weakestTrust } from './provenance';

export interface SvdField {
  name: string;
  lsb: number;
  msb: number;
  access?: string;
  description?: string;
  enums?: { name: string; value: string; description?: string }[];
}
export interface SvdRegister {
  name: string; // includes cluster prefix, e.g. "CH0_CTRL"
  offset: number;
  address: number;
  size: number;
  reset?: number;
  access?: string;
  description?: string;
  fields: SvdField[];
}
export interface SvdPeripheral {
  name: string;
  base: number;
  description?: string;
  registers: SvdRegister[];
}
export interface SvdDevice {
  id: string;
  source: string;
  name: string;
  peripherals: SvdPeripheral[];
  sha256?: string; // hash of the SVD XML actually parsed
  fetchedAt?: string;
  trust?: TrustClass;
}

// ---- SVD parsing ------------------------------------------------------------------------------

const ARRAYS = new Set(['peripheral', 'register', 'cluster', 'field', 'enumeratedValue']);
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});

// SVD scaledNonNegativeInteger: decimal, 0x/0X hex, or #binary.
export function parseNum(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (/^[+]?0x[0-9a-f]+$/i.test(s)) return parseInt(s.replace(/^[+]?0x/i, ''), 16);
  if (/^#[01]+$/.test(s)) return parseInt(s.slice(1), 2);
  if (/^[+]?\d+$/.test(s)) return parseInt(s, 10);
  return undefined;
}

const text = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v).replace(/\s+/g, ' ').trim());

interface Defaults {
  size: number;
  access?: string;
  reset?: number;
}

// dim arrays: "TIMER%s" / "ARR[%s]" with dim, dimIncrement, dimIndex ("0-3" or "A,B,C").
// An SVD is untrusted: a tiny file can claim <dim>100000000</dim> or nest arrays that multiply, so expansion is capped per array and in total.
const MAX_DIM = 4096;
const MAX_EXPANSION = 3_000_000; // elements (peripherals, clusters, registers, fields) one file may produce; real SVDs stay well below this
let expansionLeft = MAX_EXPANSION;
function dimExpand(node: any, defaultInc = 0): { name: string; delta: number }[] {
  const dim = parseNum(node.dim);
  const name = String(node.name);
  if (dim !== undefined && (!Number.isInteger(dim) || dim < 0 || dim > MAX_DIM)) throw new Error(`SVD array "${name}" has dim ${dim}, outside 0..${MAX_DIM}`);
  expansionLeft -= dim ?? 1; // every produced element counts, so nested arrays cannot multiply past the budget
  if (expansionLeft < 0) throw new Error(`SVD expands to more than ${MAX_EXPANSION} elements`);
  if (dim === undefined) return [{ name, delta: 0 }];
  const inc = parseNum(node.dimIncrement) ?? defaultInc;
  let idx: string[] = Array.from({ length: dim }, (_, i) => String(i));
  const di = text(node.dimIndex);
  if (di) {
    const range = di.match(/^(\d+)-(\d+)$/);
    if (range && +range[2] - +range[1] + 1 > MAX_DIM) throw new Error(`SVD array "${name}" has a dimIndex range larger than ${MAX_DIM}`);
    idx = range
      ? Array.from({ length: Math.max(0, +range[2] - +range[1] + 1) }, (_, i) => String(+range[1] + i))
      : di
          .split(',')
          .slice(0, MAX_DIM)
          .map((s) => s.trim());
  }
  return idx.slice(0, dim).map((ix, i) => ({
    name: name.includes('[%s]') ? name.replace('[%s]', ix) : name.replace('%s', ix),
    delta: i * inc,
  }));
}

function parseField(f: any): SvdField[] {
  const out: SvdField[] = [];
  let lsb = parseNum(f.bitOffset);
  let width = parseNum(f.bitWidth);
  if (lsb === undefined && f.bitRange) {
    const m = String(f.bitRange).match(/\[(\d+):(\d+)\]/);
    if (m) {
      lsb = +m[2];
      width = +m[1] - +m[2] + 1;
    }
  }
  if (lsb === undefined && f.lsb !== undefined) {
    lsb = parseNum(f.lsb);
    width = (parseNum(f.msb) ?? lsb ?? 0) - (lsb ?? 0) + 1;
  }
  if (lsb === undefined) return out;
  const enums = (f.enumeratedValues?.enumeratedValue ?? []).map((e: any) => ({
    name: String(e.name ?? ''),
    value: String(e.value ?? ''),
    description: text(e.description),
  }));
  for (const d of dimExpand(f, width ?? 1)) {
    const l = lsb + d.delta;
    out.push({
      name: d.name,
      lsb: l,
      msb: l + (width ?? 1) - 1,
      access: text(f.access),
      description: text(f.description),
      enums: enums.length ? enums : undefined,
    });
  }
  return out;
}

function expandRegisters(container: any, base: number, offsetBase: number, prefix: string, dflt: Defaults): SvdRegister[] {
  const out: SvdRegister[] = [];
  const regs: any[] = container.register ?? [];
  const byName = new Map<string, any>(regs.map((r) => [String(r.name), r]));
  for (let r of regs) {
    const from = r['@_derivedFrom'];
    if (from && byName.has(from)) r = { ...byName.get(from), ...r, fields: r.fields ?? byName.get(from).fields };
    const off = parseNum(r.addressOffset) ?? 0;
    const size = parseNum(r.size) ?? dflt.size;
    for (const d of dimExpand(r, size / 8)) {
      const offset = offsetBase + off + d.delta;
      out.push({
        name: prefix + d.name,
        offset,
        address: base + offset,
        size,
        reset: parseNum(r.resetValue) ?? dflt.reset,
        access: text(r.access) ?? dflt.access,
        description: text(r.description),
        fields: (r.fields?.field ?? []).flatMap(parseField),
      });
    }
  }
  for (const c of container.cluster ?? []) {
    const off = parseNum(c.addressOffset) ?? 0;
    for (const d of dimExpand(c)) {
      out.push(
        ...expandRegisters(c, base, offsetBase + off + d.delta, prefix + d.name + '_', {
          ...dflt,
          size: parseNum(c.size) ?? dflt.size,
          access: text(c.access) ?? dflt.access,
        }),
      );
    }
  }
  return out;
}

export function parseSvd(source: string, xmlText: string): SvdDevice {
  expansionLeft = MAX_EXPANSION;
  const dev = xml.parse(xmlText)?.device;
  if (!dev) throw new Error('not a CMSIS-SVD file (no <device> element)');
  const dflt: Defaults = { size: parseNum(dev.size) ?? 32, access: text(dev.access), reset: parseNum(dev.resetValue) };
  const raw: any[] = dev.peripherals?.peripheral ?? [];
  const byName = new Map<string, any>(raw.map((p) => [String(p.name), p]));
  const peripherals: SvdPeripheral[] = [];
  for (const p0 of raw) {
    let p = p0;
    const from = p0['@_derivedFrom'];
    if (from && byName.has(from)) {
      const b = byName.get(from);
      p = { ...b, ...p0, registers: p0.registers ?? b.registers };
    }
    const pd: Defaults = { size: parseNum(p.size) ?? dflt.size, access: text(p.access) ?? dflt.access, reset: parseNum(p.resetValue) ?? dflt.reset };
    for (const d of dimExpand(p)) {
      const base = (parseNum(p.baseAddress) ?? 0) + d.delta;
      peripherals.push({ name: d.name, base, description: text(p.description), registers: expandRegisters(p.registers ?? {}, base, 0, '', pd) });
    }
  }
  return {
    id: sourceId(source),
    source,
    name: String(dev.name ?? 'unknown'),
    peripherals,
  };
}

// ---- CMSIS-Pack (zip) reader --------------------------------------------------------------------

export function readZipEntries(buf: Buffer): { name: string; data: () => Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip/.pack file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: () => Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({
      name,
      data: () => {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) return inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }); // a zip bomb must not exhaust memory
        throw new Error(`unsupported zip method ${method} for ${name}`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---- Store + lookup -----------------------------------------------------------------------------

const hex = (n: number, w = 8) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');

export class SvdStore {
  private devices: SvdDevice[] = [];

  constructor(private dir: string) {
    try {
      this.devices = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SvdDevice);
    } catch {
      this.devices = [];
    }
  }

  list(): { name: string; source: string; peripherals: number }[] {
    return this.devices.map((d) => ({ name: d.name, source: d.source, peripherals: d.peripherals.length }));
  }

  // source: .svd URL/path, or a .pack/.zip (CMSIS-Pack); `entry` picks which .svd inside a pack by substring.
  async index(source: string, entry?: string): Promise<SvdDevice> {
    const { bytes, finalUrl } = await readSource(source);
    let xmlText: string;
    let label = source;
    if (bytes.readUInt32LE(0) === 0x04034b50) {
      const svds = readZipEntries(bytes).filter((e) => /\.svd$/i.test(e.name));
      if (!svds.length) throw new Error('no .svd files inside the pack');
      const hit = entry ? svds.find((e) => e.name.toLowerCase().includes(entry.toLowerCase())) : svds.length === 1 ? svds[0] : undefined;
      if (!hit)
        throw new Error(
          `pack has ${svds.length} SVDs; pass entry to choose one of: ${svds
            .slice(0, 40)
            .map((e) => e.name)
            .join(', ')}`,
        );
      xmlText = hit.data().toString('utf8');
      label = `${source}!${hit.name}`;
    } else xmlText = bytes.toString('utf8');
    const dev = parseSvd(label, xmlText);
    dev.sha256 = sha256(xmlText);
    dev.fetchedAt = new Date().toISOString();
    dev.trust = finalUrl ? weakestTrust(classifyTrust(source), classifyTrust(finalUrl)) : classifyTrust(source);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${dev.id}.json`), JSON.stringify(dev));
    this.devices = this.devices.filter((d) => d.id !== dev.id).concat(dev);
    return dev;
  }

  // Exact (case-insensitive) peripheral match across indexed devices; several matches => caller must pass `device`.
  findPeripherals(peripheral: string, device?: string): { dev: SvdDevice; p: SvdPeripheral }[] {
    const pu = peripheral.toUpperCase();
    return this.pick(device).flatMap((dev) => dev.peripherals.filter((p) => p.name.toUpperCase() === pu).map((p) => ({ dev, p })));
  }

  findRegister(peripheral: string, register: string, device?: string): { dev: SvdDevice; p: SvdPeripheral; r: SvdRegister } | undefined {
    const ru = register.toUpperCase();
    for (const { dev, p } of this.findPeripherals(peripheral, device)) {
      const r = p.registers.find((x) => x.name.toUpperCase() === ru);
      if (r) return { dev, p, r };
    }
    return undefined;
  }

  listPeripherals(device?: string): string {
    return this.pick(device)
      .map((d) => `${d.name} (${d.source})\n` + d.peripherals.map((p) => `  ${p.name} @ ${hex(p.base)}`).join('\n'))
      .join('\n');
  }

  lookup(
    q: { device?: string; peripheral?: string; register?: string; field?: string },
    max = 8,
  ): { source: string; text: string; trust?: TrustClass; sha256?: string }[] {
    const out: { source: string; text: string; trust?: TrustClass; sha256?: string }[] = [];
    const pu = q.peripheral?.toUpperCase();
    const ru = q.register?.toUpperCase();
    const fu = q.field?.toUpperCase();
    for (const d of this.pick(q.device)) {
      for (const p of d.peripherals) {
        if (pu && p.name.toUpperCase() !== pu && !(pu.length >= 3 && p.name.toUpperCase().startsWith(pu))) continue;
        for (const r of p.registers) {
          if (ru && !(r.name.toUpperCase() === ru) && !r.name.toUpperCase().includes(ru)) continue;
          if (fu && !r.fields.some((f) => f.name.toUpperCase() === fu)) continue;
          const fields = r.fields
            .filter((f) => !fu || f.name.toUpperCase() === fu)
            .map((f) => {
              const en = f.enums?.length
                ? ` {${f.enums
                    .slice(0, 8)
                    .map((e) => `${e.value}=${e.name}`)
                    .join(', ')}${f.enums.length > 8 ? ', …' : ''}}`
                : '';
              return `    [${f.msb}:${f.lsb}] ${f.name}${f.access ? ' (' + f.access + ')' : ''}${f.description ? ' — ' + f.description.slice(0, 120) : ''}${en}`;
            });
          out.push({
            source: `${d.source}#${p.name}.${r.name}`,
            trust: d.trust,
            sha256: d.sha256,
            text:
              `${d.name} ${p.name}.${r.name}: address ${hex(r.address)} (base ${hex(p.base)} + offset ${hex(r.offset, 3)}), ` +
              `${r.size} bit, reset ${r.reset === undefined ? 'n/a' : hex(r.reset, r.size / 4)}, access ${r.access ?? 'n/a'}` +
              (r.description ? `\n  ${r.description.slice(0, 200)}` : '') +
              (fields.length ? '\n' + fields.slice(0, 40).join('\n') : ''),
          });
          if (out.length >= max) return out;
        }
      }
    }
    return out;
  }

  private pick(device?: string): SvdDevice[] {
    if (!device) return this.devices;
    // Ignore punctuation so "esp32s3" matches the SVD's "ESP32-S3".
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return this.devices.filter((d) => norm(d.name).includes(norm(device)));
  }
}
