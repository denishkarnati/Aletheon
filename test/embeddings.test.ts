// Plumbing tests for chunking, vector persistence/invalidation, hybrid fusion and fallbacks.
// Uses fake embedders, so this checks the machinery, NOT retrieval quality (see bench:retrieval for that).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocStore } from '../src/core/docs';
import { Embedder, hashEmbedder } from '../src/core/embeddings';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' ' + extra}`);
};

function counting(inner: Embedder, id = inner.id): Embedder & { calls: number; texts: number } {
  const e = {
    id,
    calls: 0,
    texts: 0,
    async embed(t: string[], k: 'doc' | 'query') {
      e.calls++;
      e.texts += t.length;
      return inner.embed(t, k);
    },
  };
  return e;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-emb-'));
  const dir = path.join(tmp, 'docs');
  // ~12k chars of filler with distinctive identifiers placed so some land near chunk boundaries.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97} lorem`).join(' ');
  const html = `<html><body><p>${filler(300)} UARTFBRD_SPECIAL_REG ${filler(300)} TX_FIFO_DEPTH_32 ${filler(300)} END_MARK</p></body></html>`;
  const file = path.join(tmp, 'ds.html');
  fs.writeFileSync(file, html);

  const store = new DocStore(dir);
  await store.index(file);
  const info = store.list()[0];
  check('document split into several chunks', info.chunks > 5, `chunks=${info.chunks}`);

  // 1. no token is ever cut in half: every distinctive identifier is searchable as a whole word
  for (const id of ['UARTFBRD_SPECIAL_REG', 'TX_FIFO_DEPTH_32', 'END_MARK']) {
    const r = await store.search(id, 3);
    check(
      `identifier ${id} survives chunking intact`,
      r.hits.some((h) => h.excerpt.includes(id)),
    );
  }

  // 2. embeddings computed once, then reused, including across a fresh DocStore (persistence)
  const e1 = counting(hashEmbedder(64));
  const a = await store.ensureEmbedded(e1);
  check('first ensureEmbedded embeds all chunks', a.embedded === info.chunks && e1.texts === info.chunks, JSON.stringify(a));
  const b = await store.ensureEmbedded(e1);
  check('second ensureEmbedded is a no-op', b.embedded === 0 && e1.texts === info.chunks, JSON.stringify(b));
  const store2 = new DocStore(dir);
  const e1b = counting(hashEmbedder(64));
  const c = await store2.ensureEmbedded(e1b);
  check(
    'vectors persisted to disk and reused by a new store',
    c.embedded === 0 && e1b.calls === 0 && store2.list()[0].embedded === 'hash:64',
    JSON.stringify(c),
  );

  // 3. different model id => stale => re-embed
  const e2 = counting(hashEmbedder(32));
  const d = await store2.ensureEmbedded(e2);
  check('changing the embedding model re-embeds', d.embedded === info.chunks && store2.list()[0].embedded === 'hash:32', JSON.stringify(d));

  // 4. re-indexing a doc drops its old vectors
  await store2.index(file);
  check('re-indexing invalidates vectors', store2.list()[0].embedded === null);

  // 5. hybrid mode + both ranks reported
  await store2.ensureEmbedded(e1);
  const r = await store2.search('TX_FIFO_DEPTH_32 lorem', 5, e1);
  check('hybrid mode used when vectors exist', r.mode === 'hybrid', r.mode + ' ' + (r.note ?? ''));
  check(
    'hits carry kwRank and vecRank',
    r.hits.some((h) => h.kwRank !== undefined && h.vecRank !== undefined),
  );

  // 6. fusion: an embedder that rates ONE chosen chunk as the best semantic match must surface it even with zero keyword overlap
  const base = hashEmbedder(64);
  let target = '';
  const biased: Embedder = {
    id: 'hash:64', // reuse the stored vectors; only the QUERY embedding is rigged
    async embed(texts, kind) {
      if (kind === 'query') return [(await base.embed([target], 'doc'))[0]];
      return base.embed(texts, kind);
    },
  };
  target = r.hits[r.hits.length - 1].excerpt; // pick a chunk, make the "query vector" equal to that chunk's vector
  const f = await store2.search('zzzz qqqq nonmatching', 5, biased);
  check(
    'semantic-only match surfaces via vector ranking (no keyword overlap)',
    f.hits.length > 0 && f.hits[0].excerpt === target && f.hits[0].kwRank === undefined && f.hits[0].vecRank === 1,
    JSON.stringify({ n: f.hits.length, vec: f.hits[0]?.vecRank, kw: f.hits[0]?.kwRank }),
  );

  // 7. embedder failure => keyword fallback with an explanatory note, never an exception
  const broken: Embedder = {
    id: 'hash:64',
    async embed() {
      throw new Error('connection refused');
    },
  };
  const g = await store2.search('TX_FIFO_DEPTH_32', 3, broken);
  check(
    'embedder failure falls back to keyword with a note',
    g.mode === 'keyword' && !!g.note?.includes('connection refused') && g.hits.length > 0,
    JSON.stringify(g.note),
  );

  // 8. no embedder => keyword, with explicit note
  const h = await store2.search('TX_FIFO_DEPTH_32', 3);
  check('no embedder => keyword mode + note', h.mode === 'keyword' && !!h.note);

  // 9. dimension mismatch (model swapped but same id string) must not crash or mis-score
  const wrongDim: Embedder = {
    id: 'hash:64',
    async embed(t) {
      return t.map(() => new Float32Array(7).fill(1));
    },
  };
  const m = await store2.search('TX_FIFO_DEPTH_32', 3, wrongDim);
  check('dimension mismatch handled gracefully', m.mode === 'keyword' && m.hits.length > 0, m.mode + ' ' + (m.note ?? ''));

  // 10. partial failure during embedding leaves no corrupt/partial vector file
  const store3 = new DocStore(path.join(tmp, 'docs3'));
  const big = path.join(tmp, 'big.html'); // >64 chunks so the embedder is called more than once (batch step is 64)
  fs.writeFileSync(big, `<p>${filler(6000)}</p>`);
  await store3.index(big);
  check('big doc spans multiple embedding batches', store3.list()[0].chunks > 64, `chunks=${store3.list()[0].chunks}`);
  let n = 0;
  const flaky: Embedder = {
    id: 'flaky:1',
    async embed(t, k) {
      if (++n === 2) throw new Error('boom');
      return hashEmbedder(16).embed(t, k);
    },
  };
  let threw = false;
  try {
    await store3.ensureEmbedded(flaky);
  } catch {
    threw = true;
  }
  check(
    'failed embedding run throws and leaves doc un-embedded',
    threw && store3.list()[0].embedded === null && !fs.readdirSync(path.join(tmp, 'docs3')).some((f) => f.endsWith('.emb')),
  );

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main();
