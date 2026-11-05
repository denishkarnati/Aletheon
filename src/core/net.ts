import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

// Datasheet/SVD URLs can come from model output, which can be steered by text inside a document (prompt injection).
// Fetches made on the model's behalf must not reach localhost, link-local/metadata endpoints or private networks.
// Set ALETHEON_ALLOW_PRIVATE_URLS=1 to allow an internal mirror.
//
// Two layers: (1) the URL and every redirect hop is checked before connecting, (2) the connection itself re-validates the address
// it is about to use, so a DNS server that answers "public" to the check and "127.0.0.1" to the connect (rebinding) is refused too.

export const MAX_FETCH_BYTES = 100 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 60_000;

function privateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true; // fail closed
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved and broadcast
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

// Eight 16-bit groups of an IPv6 address, or null when it does not parse.
function parseV6(raw: string): number[] | null {
  let s = raw.toLowerCase().split('%')[0];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const q = dotted[1].split('.').map(Number);
    if (q.length !== 4 || q.some((x) => x > 255)) return null;
    s = s.slice(0, -dotted[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const grp = (t: string): number[] | null => {
    if (t === '') return [];
    const out = t.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
    return out.some(Number.isNaN) ? null : out;
  };
  const head = grp(halves[0]);
  const tail = halves.length === 2 ? grp(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function privateV6(ip: string): boolean {
  const h = parseV6(ip);
  if (!h) return true; // fail closed
  const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number): boolean => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return privateV4(v4(h[6], h[7])); // IPv4-mapped ::ffff:a.b.c.d
  if (zeros(0, 6)) return h[6] === 0 && h[7] <= 1 ? true : privateV4(v4(h[6], h[7])); // ::, ::1, deprecated IPv4-compatible
  if (h[0] === 0x64 && h[1] === 0xff9b) return zeros(2, 6) ? privateV4(v4(h[6], h[7])) : true; // NAT64 64:ff9b::/96 (and the local-use /48)
  if (h[0] === 0x2002) return privateV4(v4(h[1], h[2])); // 6to4 embeds an IPv4 address
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return true; // Teredo, documentation
  return (h[0] & 0xe000) !== 0x2000; // only global unicast 2000::/3 is reachable; everything else (ULA, link-local, multicast...) is blocked
}
export const isPrivateIp = (ip: string): boolean => (isIP(ip) === 4 ? privateV4(ip) : isIP(ip) === 6 ? privateV6(ip) : true);

const allowPrivate = (): boolean => process.env.ALETHEON_ALLOW_PRIVATE_URLS === '1';

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`blocked URL scheme ${u.protocol}`);
  if (u.username || u.password) throw new Error('blocked: URLs with embedded credentials');
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error(`blocked private host ${host}`);
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`blocked private address ${host}`);
    return u;
  }
  const addrs = await new Promise<{ address: string }[]>((resolve, reject) => dnsLookup(host, { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error(`blocked: ${host} resolves to a private address`);
  return u;
}

// Used by the socket itself: validates the address that will actually be connected to.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, '', 0);
    const list = addrs as { address: string; family: number }[];
    if (!allowPrivate() && (list.length === 0 || list.some((a) => isPrivateIp(a.address))))
      return callback(new Error(`blocked: ${hostname} resolves to a private address`) as NodeJS.ErrnoException, '', 0);
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export interface FetchLimits {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}
export interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string; // the URL that actually answered, after redirects
}

function getOnce(u: URL, maxBytes: number, timeoutMs: number): Promise<Omit<FetchResult, 'url'> & { redirect?: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const done = (fn: () => void): void => {
      clearTimeout(timer); // `timer` exists before any callback can run: they all fire asynchronously
      fn();
    };
    const req = mod.request(
      u,
      { method: 'GET', lookup: guardedLookup, headers: { 'user-agent': 'aletheon', accept: '*/*', 'accept-encoding': 'identity' } },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          res.resume();
          return done(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0), redirect: loc }));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          req.destroy();
          return done(() => reject(new Error(`response too large (${declared} bytes, limit ${maxBytes})`)));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return done(() => reject(new Error(`response too large (over ${maxBytes} bytes)`)));
          }
          chunks.push(c);
        });
        res.on('end', () => done(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
        res.on('error', (e) => done(() => reject(e)));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    req.on('error', (e) => done(() => reject(e)));
    req.end();
  });
}

// GET that validates every redirect hop, pins the connection to a validated address, and bounds time and size.
export async function safeGet(raw: string, limits: FetchLimits = {}): Promise<FetchResult> {
  const { maxBytes = MAX_FETCH_BYTES, timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = 5 } = limits;
  let url = raw;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = await assertPublicHttpUrl(url);
    const r = await getOnce(u, maxBytes, timeoutMs);
    if (r.redirect) {
      url = new URL(r.redirect, u).toString();
      continue;
    }
    return { status: r.status, headers: r.headers, body: r.body, url: u.toString() };
  }
  throw new Error('too many redirects');
}

// Same checks, returned as a standard Response for callers that want one.
export async function safeFetch(raw: string, maxRedirects = 5): Promise<Response> {
  const r = await safeGet(raw, { maxRedirects });
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
  return new Response(nullBody ? null : new Uint8Array(r.body), { status: r.status, headers });
}

// Bytes of an http(s) URL (validated by safeGet) or of a local regular file.
export async function readSource(source: string): Promise<{ bytes: Buffer; contentType: string; finalUrl?: string }> {
  if (!/^https?:\/\//i.test(source)) {
    const st = fs.statSync(source);
    if (!st.isFile()) throw new Error(`not a regular file: ${source}`); // no FIFOs, devices or directories
    if (st.size > MAX_FETCH_BYTES) throw new Error(`file too large (${st.size} bytes, limit ${MAX_FETCH_BYTES})`);
    return { bytes: fs.readFileSync(source), contentType: '' };
  }
  const r = await safeGet(source);
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} fetching ${source}`);
  const ct = r.headers['content-type'];
  return { bytes: r.body, contentType: (Array.isArray(ct) ? ct[0] : ct) ?? '', finalUrl: r.url };
}
