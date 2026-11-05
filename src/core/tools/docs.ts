// Datasheet indexing and page-cited search.
import { errorMessage } from '../util';
import { Tool, obj, resolveSource, str } from './context';

export const docTools: Tool[] = [
  {
    name: 'index_datasheet',
    description:
      'Download and index a datasheet/reference manual (PDF or HTML URL, or a local path) so it can be searched with page numbers. Required before making register/pin/electrical claims.',
    input_schema: obj({ source: str('https URL or local file path') }, ['source']),
    async run(a, ctx) {
      const src = resolveSource(ctx, a.source);
      const d = await ctx.docs.index(src);
      let sem = 'keyword-only (no embedding model configured)';
      const emb = await ctx.host.getEmbedder();
      if (emb) {
        try {
          const r = await ctx.docs.ensureEmbedded(emb, (m) => ctx.host.log(m));
          sem = `semantic index ready (${emb.id}, ${r.embedded} chunks embedded)`;
        } catch (err) {
          sem = `semantic index FAILED (${errorMessage(err)}); keyword-only`;
        }
      }
      const e = ctx.ledger.add('datasheet', src, `Indexed ${d.pages.length} pages (doc ${d.id}); ${sem}`, { trust: d.trust, sha256: d.sha256 });
      return `[${e.id}] indexed ${d.pages.length} pages from ${src}; ${sem}`;
    },
  },
  {
    name: 'search_datasheets',
    description:
      'Search indexed datasheets (hybrid keyword + semantic when an embedding model is configured). Each hit is a ~900-char passage recorded as evidence [E#] with its page number; cite it. Natural-language questions work, but verify the passage actually states the fact before citing it.',
    input_schema: obj({ query: str('registers, peripheral, pin names, etc.'), k: { type: 'number' } }, ['query']),
    async run(a, ctx) {
      const emb = await ctx.host.getEmbedder();
      let note = '';
      if (emb) {
        try {
          await ctx.docs.ensureEmbedded(emb, (m) => ctx.host.log(m)); // no-op when vectors are current
        } catch (err) {
          note = `semantic index could not be built (${errorMessage(err)}). `;
        }
      }
      const res = await ctx.docs.search(a.query, Math.min(a.k ?? 4, 8), emb);
      if (!res.hits.length)
        return 'No hits. Either nothing is indexed (call index_datasheet) or the datasheet does not contain this. Do not guess; report UNVERIFIED.';
      const head = `[search mode: ${res.mode}${note || res.note ? '; ' + note + (res.note ?? '') : ''}]`;
      return (
        head +
        '\n\n' +
        res.hits
          .map((h) => {
            const e = ctx.ledger.add('datasheet', `${h.source} p.${h.page}`, h.excerpt, { trust: h.trust, sha256: h.sha256 });
            return `[${e.id}] ${h.source} page ${h.page}:\n${h.excerpt}`;
          })
          .join('\n\n')
      );
    },
  },
];
