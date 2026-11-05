import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Embedder } from './embeddings';
import { readSource } from './net';
import { TrustClass, classifyTrust, sha256, sourceId, weakestTrust } from './provenance';
import { errorMessage } from './util';

export interface DocPage {
  n: number;
  text: string;
}
export interface IndexedDoc {
  id: string;
  source: string;
  pages: DocPage[];
  sha256?: string; // hash of the downloaded bytes, so evidence can be tied to one exact file version
  fetchedAt?: string;
  trust?: TrustClass;
}
export interface Hit {
  docId: string;
  source: string;
  page: number;
  score: number;
  excerpt: string;
  kwRank?: number; // 1-based rank in the keyword list, when it appeared there
  vecRank?: number; // 1-based rank in the vector list
  cosine?: number;
  trust?: TrustClass;
  sha256?: string;
}
export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  note?: string; // why we fell back / what is missing
  hits: Hit[];
}

const CHUNK = 900;
const OVERLAP = 150;
const RRF_K = 60;
const VEC_POOL = 50;

interface Chunk {
  docId: string;
  source: string;
  page: number;
  text: string;
  tf: Map<string, number>;
  len: number;
}
interface Vectors {
  model: string;
  dim: number;
  vecs: Float32Array; // n * dim, each row L2-normalized
}

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];

// Visible text of an HTML page. Linear time on purpose: the page is untrusted and the old regexes took seconds on a few hundred KB of '<'.
const MAX_HTML_CHARS = 20_000_000;
export function stripHtml(input: string): string {
  const s = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const low = s.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, lt), ' ');
    const block = /^<(script|style)\b/.exec(low.slice(lt, lt + 9));
    if (block) {
      const close = low.indexOf('</' + block[1], lt);
      if (close < 0) break; // an unterminated script or style block: drop the rest
      const gt = low.indexOf('>', close);
      i = gt < 0 ? s.length : gt + 1;
      continue;
    }
    const gt = s.indexOf('>', lt);
    if (gt < 0) {
      out.push(s.slice(lt)); // a stray '<' with no closing '>': keep the text
      break;
    }
    i = gt + 1;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK) return text ? [text] : [];
  const out: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + CHUNK);
    if (end < text.length) {
      const sp = text.lastIndexOf(' ', end);
      if (sp > start + CHUNK / 2) end = sp; // break on whitespace, not mid-token (register names!)
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - OVERLAP;
  }
  return out;
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / n;
  return o;
}

export class DocStore {
  private docs: IndexedDoc[] = [];
  private chunks = new Map<string, Chunk[]>(); // docId -> chunks
  private vectors = new Map<string, Vectors>();

  constructor(private dir: string) {
    try {
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        this.add(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as IndexedDoc);
      }
    } catch {
      /* empty store */
    }
  }

  private add(doc: IndexedDoc): void {
    this.docs = this.docs.filter((d) => d.id !== doc.id).concat(doc);
    const cs: Chunk[] = [];
    for (const p of doc.pages)
      for (const text of chunkText(p.text)) {
        const tf = new Map<string, number>();
        const toks = tokenize(text);
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
        cs.push({ docId: doc.id, source: doc.source, page: p.n, text, tf, len: toks.length });
      }
    this.chunks.set(doc.id, cs);
    this.vectors.delete(doc.id);
  }

  list(): { id: string; source: string; pages: number; chunks: number; embedded: string | null }[] {
    return this.docs.map((d) => ({
      id: d.id,
      source: d.source,
      pages: d.pages.length,
      chunks: this.chunks.get(d.id)?.length ?? 0,
      embedded: this.loadVectors(d.id)?.model ?? null,
    }));
  }

  async index(source: string): Promise<IndexedDoc> {
    const id = sourceId(source);
    const src = await readSource(source);
    const isPdf = /\.pdf($|\?)/i.test(source) || src.contentType.includes('pdf');
    const bytes = new Uint8Array(src.bytes); // a private copy: pdf.js detaches the buffer it is given
    const hash = sha256(bytes); // hash BEFORE parsing: pdf.js takes ownership of the buffer and leaves it empty
    let pages: DocPage[];
    if (isPdf) {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: false });
      pages = text.map((t, i) => ({ n: i + 1, text: t.replace(/\s+/g, ' ').trim() }));
    } else {
      pages = [{ n: 1, text: stripHtml(Buffer.from(bytes).toString('utf8')) }];
    }
    const doc: IndexedDoc = {
      id,
      source,
      pages,
      sha256: hash,
      fetchedAt: new Date().toISOString(),
      trust: src.finalUrl ? weakestTrust(classifyTrust(source), classifyTrust(src.finalUrl)) : classifyTrust(source),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(doc));
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.emb`)); // content may have changed
    } catch {
      /* none */
    }
    this.add(doc);
    return doc;
  }

  // ---- embeddings ---------------------------------------------------------------------------------

  private embPath = (id: string) => path.join(this.dir, `${id}.emb`);

  private loadVectors(id: string, model?: string): Vectors | undefined {
    let v = this.vectors.get(id);
    if (!v) {
      try {
        const f = JSON.parse(fs.readFileSync(this.embPath(id), 'utf8'));
        const n = this.chunks.get(id)?.length ?? -1;
        if (f.chunk !== CHUNK || f.overlap !== OVERLAP || f.n !== n) return undefined; // chunking changed: stale
        const b = Buffer.from(f.data, 'base64');
        v = { model: f.model, dim: f.dim, vecs: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
        this.vectors.set(id, v);
      } catch {
        return undefined;
      }
    }
    return model && v.model !== model ? undefined : v;
  }

  // Embeds every chunk of every doc that lacks vectors for this model. Cheap no-op when up to date.
  async ensureEmbedded(embedder: Embedder, onProgress?: (msg: string) => void): Promise<{ embedded: number; reused: number }> {
    let embedded = 0,
      reused = 0;
    for (const d of this.docs) {
      const cs = this.chunks.get(d.id) ?? [];
      if (this.loadVectors(d.id, embedder.id)) {
        reused += cs.length;
        continue;
      }
      const rows: Float32Array[] = [];
      const STEP = 64;
      for (let i = 0; i < cs.length; i += STEP) {
        const out = await embedder.embed(
          cs.slice(i, i + STEP).map((c) => c.text),
          'doc',
        );
        if (out.length !== Math.min(STEP, cs.length - i))
          throw new Error(`embedder returned ${out.length} vectors for ${Math.min(STEP, cs.length - i)} inputs`);
        rows.push(...out.map(normalize));
        onProgress?.(`embedding ${d.source}: ${Math.min(i + STEP, cs.length)}/${cs.length} chunks`);
      }
      const dim = rows[0]?.length ?? 0;
      const flat = new Float32Array(rows.length * dim);
      rows.forEach((r, i) => flat.set(r, i * dim));
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(
        this.embPath(d.id),
        JSON.stringify({ model: embedder.id, dim, chunk: CHUNK, overlap: OVERLAP, n: cs.length, data: Buffer.from(flat.buffer).toString('base64') }),
      );
      this.vectors.set(d.id, { model: embedder.id, dim, vecs: flat });
      embedded += cs.length;
    }
    return { embedded, reused };
  }

  // ---- search -------------------------------------------------------------------------------------

  async search(query: string, k = 5, embedder?: Embedder): Promise<SearchResult> {
    const all = this.docs.flatMap((d) => (this.chunks.get(d.id) ?? []).map((c, i) => ({ c, i })));
    const keyword = this.keywordRank(
      query,
      all.map((x) => x.c),
    );
    let note: string | undefined;
    let vector: { idx: number; cos: number }[] = [];

    if (embedder) {
      try {
        const [qv] = await embedder.embed([query], 'query');
        const q = normalize(qv);
        const offsets = new Map<string, number>();
        let o = 0;
        for (const d of this.docs) {
          offsets.set(d.id, o);
          o += this.chunks.get(d.id)?.length ?? 0;
        }
        const scored: { idx: number; cos: number }[] = [];
        let missing = 0;
        for (const d of this.docs) {
          const v = this.loadVectors(d.id, embedder.id);
          if (!v || v.dim !== q.length) {
            missing++;
            continue;
          }
          const n = this.chunks.get(d.id)!.length;
          for (let i = 0; i < n; i++) {
            let dot = 0;
            const base = i * v.dim;
            for (let j = 0; j < v.dim; j++) dot += v.vecs[base + j] * q[j];
            scored.push({ idx: offsets.get(d.id)! + i, cos: dot });
          }
        }
        vector = scored.sort((a, b) => b.cos - a.cos).slice(0, VEC_POOL);
        if (missing) note = `${missing} doc(s) have no vectors for ${embedder.id}; they were searched by keyword only`;
      } catch (e) {
        note = `semantic search unavailable (${errorMessage(e)}); used keyword only`;
      }
    } else note = 'no embedding model configured; keyword-only search (exact identifiers work, paraphrases may miss)';

    // Reciprocal-rank fusion: robust to the two scorers being on different scales.
    const fused = new Map<number, Hit>();
    const hit = (idx: number): Hit => {
      let h = fused.get(idx);
      if (!h) {
        const c = all[idx].c;
        const d = this.docs.find((x) => x.id === c.docId);
        h = { docId: c.docId, source: c.source, page: c.page, score: 0, excerpt: c.text, trust: d?.trust ?? classifyTrust(c.source), sha256: d?.sha256 };
        fused.set(idx, h);
      }
      return h;
    };
    keyword.slice(0, VEC_POOL).forEach((idx, r) => {
      const h = hit(idx);
      h.kwRank = r + 1;
      h.score += 1 / (RRF_K + r + 1);
    });
    vector.forEach((v, r) => {
      const h = hit(v.idx);
      h.vecRank = r + 1;
      h.cosine = v.cos;
      h.score += 1 / (RRF_K + r + 1);
    });
    const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
    return { mode: vector.length ? 'hybrid' : 'keyword', note, hits };
  }

  // Indices into `chunks`, best first. idf is squared so rare terms (register/peripheral names) beat common words.
  private keywordRank(query: string, chunks: Chunk[]): number[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const df = new Map<string, number>(q.map((t) => [t, chunks.reduce((n, c) => n + (c.tf.has(t) ? 1 : 0), 0)]));
    const scored: { idx: number; s: number }[] = [];
    chunks.forEach((c, idx) => {
      let s = 0;
      for (const t of q) {
        const tf = c.tf.get(t);
        if (tf) s += (1 + Math.log(tf)) * Math.log(1 + chunks.length / (df.get(t) || 1)) ** 2;
      }
      if (s > 0) scored.push({ idx, s });
    });
    return scored.sort((a, b) => b.s - a.s).map((x) => x.idx);
  }
}

export async function verifyUrl(url: string): Promise<{ ok: boolean; status: number | string }> {
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (r.status === 405 || r.status === 403) r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0' } });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: String(e) };
  }
}
