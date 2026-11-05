import type { DocStore } from './docs';
import type { Evidence, Ledger } from './evidence';
import { TRUST_RANK } from './provenance';
import type { SvdRegister } from './svd';

// ---- claim auditing -----------------------------------------------------------------------------
// A citation is only worth something if the cited passage actually contains the value being claimed.
// "[E7]" next to "UART0 is at 0x40034000" is checked by looking for 0x40034000 inside E7's excerpt.

export type ClaimStatus = 'supported' | 'unsupported' | 'uncited' | 'unknown-citation' | 'declared-unverified';

export interface ClaimResult {
  sentence: string;
  values: string[]; // normalized hardware values found in the sentence
  cited: string[];
  status: ClaimStatus;
  missing?: string[]; // values that none of the cited evidence contains
  weakSource?: boolean; // supported, but only by community-mirror/unknown sources
}

export interface AuditReport {
  claims: ClaimResult[];
  counts: Record<ClaimStatus, number>;
  weak: number;
  ok: boolean;
}

const UNITS = 'mA|µA|uA|V|MHz|kHz|GHz|ns|µs|us|ms|baud|kB|MB|ksps';
const RE_HEX = /\b0x([0-9a-f]{2,})(?:u|ul|ull|l)?\b/gi;
const RE_QTY = new RegExp(`(\\d+(?:\\.\\d+)?)\\s?(${UNITS})\\b`, 'gi');
const RE_GPIO = /\bGPIO\s?(\d+)\b/gi;
const RE_PORTPIN = /\bP([A-K])(\d{1,2})\b/g;

export function extractValues(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(RE_HEX)) out.add('hex:' + BigInt('0x' + m[1]).toString(16));
  for (const m of text.matchAll(RE_QTY)) out.add(`qty:${parseFloat(m[1])}${m[2].toLowerCase().replace('µ', 'u')}`);
  for (const m of text.matchAll(RE_GPIO)) out.add(`pin:gpio${+m[1]}`);
  for (const m of text.matchAll(RE_PORTPIN)) out.add(`pin:p${m[1].toLowerCase()}${+m[2]}`);
  return [...out];
}

const CITE = /\[(E\d+(?:\s*,\s*E\d+)*)\]/g;

export function auditClaims(answer: string, ledger: Ledger): AuditReport {
  const prose = answer.replace(/```[\s\S]*?```/g, ''); // code is checked by build/flash, not by citation
  const claims: ClaimResult[] = [];
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const cleaned = sentence.replace(CITE, ' '); // evidence ids are not hardware values
    const values = extractValues(cleaned);
    if (!values.length) continue;
    const cited = [...sentence.matchAll(CITE)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
    if (/UNVERIFIED/i.test(sentence)) {
      claims.push({ sentence, values, cited, status: 'declared-unverified' });
      continue;
    }
    if (!cited.length) {
      claims.push({ sentence, values, cited, status: 'uncited' });
      continue;
    }
    const ev = cited.map((id) => ledger.get(id));
    if (ev.some((e) => !e)) {
      claims.push({ sentence, values, cited, status: 'unknown-citation' });
      continue;
    }
    const found = new Set((ev as Evidence[]).flatMap((e) => extractValues(e.excerpt)));
    const missing = values.filter((v) => !found.has(v));
    const supporters = (ev as Evidence[]).filter((e) => extractValues(e.excerpt).some((v) => values.includes(v)));
    const weakSource =
      !missing.length && supporters.length > 0 && Math.max(...supporters.map((e) => TRUST_RANK[e.trust ?? 'unknown'])) <= TRUST_RANK['community-mirror'];
    claims.push({
      sentence,
      values,
      cited,
      status: missing.length ? 'unsupported' : 'supported',
      ...(missing.length ? { missing } : {}),
      ...(weakSource ? { weakSource } : {}),
    });
  }
  const counts: Record<ClaimStatus, number> = { supported: 0, unsupported: 0, uncited: 0, 'unknown-citation': 0, 'declared-unverified': 0 };
  for (const c of claims) counts[c.status]++;
  return { claims, counts, weak: claims.filter((c) => c.weakSource).length, ok: !counts.unsupported && !counts.uncited && !counts['unknown-citation'] };
}

export function formatAudit(r: AuditReport): string {
  const bad = r.claims.filter((c) => c.status === 'unsupported' || c.status === 'uncited' || c.status === 'unknown-citation');
  const lines = [
    `claims with hardware values: ${r.claims.length}; supported ${r.counts.supported}, unsupported ${r.counts.unsupported}, uncited ${r.counts.uncited}, unknown citation ${r.counts['unknown-citation']}, declared UNVERIFIED ${r.counts['declared-unverified']}${r.weak ? `; ${r.weak} rest only on community/unknown sources` : ''}`,
    ...bad.map((c) => `- ${c.status.toUpperCase()}${c.missing ? ' (cited evidence lacks ' + c.missing.join(', ') + ')' : ''}: "${c.sentence.slice(0, 160)}"`),
  ];
  return lines.join('\n');
}

// ---- cross-source check: SVD register vs datasheet text ------------------------------------------

export type CrossVerdict = 'agree' | 'conflict' | 'name-only' | 'not-found';
export interface CrossResult {
  verdict: CrossVerdict;
  detail: string;
  passages: { page: number; source: string; excerpt: string; trust?: Evidence['trust']; sha256?: string }[];
}

const hexNum = (s: string): bigint => BigInt('0x' + s.replace(/^0x/i, ''));

// Heuristic, not a proof: looks for "<REGISTER> ... 0x<offset|address>" in the register's datasheet passages.
export async function crossCheckRegister(docs: DocStore, peripheral: string, reg: SvdRegister): Promise<CrossResult> {
  const res = await docs.search(reg.name, 20); // keyword mode: exact identifiers
  const nameRe = new RegExp(`\\b${reg.name.replace(/[^A-Za-z0-9_]/g, '.')}\\b`, 'g');
  const family = peripheral.replace(/\d+$/, '').toLowerCase(); // "UART0" -> "uart"
  const want = new Set([BigInt(reg.offset), BigInt(reg.address)]);
  let named = 0;
  let agree: CrossResult['passages'][number] | undefined;
  let conflict: { p: CrossResult['passages'][number]; seen: string } | undefined;
  for (const h of res.hits) {
    // Long distinctive names (CH0_READ_ADDR) identify themselves; short generic ones (STATUS, CTRL) must sit next to the peripheral family name.
    const generic = reg.name.length < 7;
    if (!nameRe.test(h.excerpt) || (generic && family.length >= 3 && !h.excerpt.toLowerCase().includes(family))) continue;
    nameRe.lastIndex = 0;
    named++;
    const p = { page: h.page, source: h.source, excerpt: h.excerpt, trust: h.trust, sha256: h.sha256 };
    for (const m of h.excerpt.matchAll(nameRe)) {
      // Only structured placements count. Register lists put the offset right BEFORE the name ("0x018 UARTFR ...");
      // detail tables put it right AFTER ("UARTFR Offset: 0x018"). Hex values in prose, or belonging to the next row, are ignored.
      const before = h.excerpt.slice(Math.max(0, m.index! - 16), m.index!).match(/(0x[0-9a-f]+)\s+$/i)?.[1];
      const after = h.excerpt.slice(m.index! + m[0].length, m.index! + m[0].length + 20).match(/^\s*(?:Offset:?\s*)?(0x[0-9a-f]+)\b/i)?.[1];
      const seen = [before, after].filter((x): x is string => !!x);
      if (seen.some((x) => want.has(hexNum(x)))) agree ??= p;
      else if (seen.length) conflict ??= { p, seen: seen[0] };
    }
    nameRe.lastIndex = 0;
  }
  if (agree)
    return {
      verdict: 'agree',
      detail: `datasheet p.${agree.page} lists ${reg.name} with the SVD offset/address (offset 0x${reg.offset.toString(16)}, address 0x${reg.address.toString(16)})`,
      passages: [agree],
    };
  if (conflict)
    return {
      verdict: 'conflict',
      detail: `datasheet p.${conflict.p.page} shows ${reg.name} near ${conflict.seen}, but the SVD says offset 0x${reg.offset.toString(16)} / address 0x${reg.address.toString(16)}; unresolved, check both against the vendor`,
      passages: [conflict.p],
    };
  if (named)
    return { verdict: 'name-only', detail: `${reg.name} appears in the datasheet but no offset/address was found next to it to compare`, passages: [] };
  return { verdict: 'not-found', detail: `${reg.name} does not appear in the indexed datasheets (or none are indexed)`, passages: [] };
}
