// Pluggable text embedders. All return raw vectors; callers normalize.
//  - ollama:  local server, free/private/offline (default model nomic-embed-text)
//  - openai-compatible: any /v1/embeddings endpoint (OpenAI, OpenRouter, vLLM, LM Studio, ...)
//  - local:   in-process via the OPTIONAL package @huggingface/transformers (not bundled; npm i it next to dist/mcp.js)

export interface Embedder {
  id: string; // provider:model, stored with the vectors so a model change invalidates them
  embed(texts: string[], kind: 'doc' | 'query'): Promise<Float32Array[]>;
}

export interface EmbeddingConfig {
  provider: 'auto' | 'off' | 'ollama' | 'openai-compatible' | 'local';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

const BATCH = 32;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 120_000): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`embedding HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

// Models like nomic-embed-text are trained with task prefixes; omitting them measurably hurts retrieval.
function prefixes(model: string): { doc: string; query: string } {
  if (/nomic-embed/i.test(model)) return { doc: 'search_document: ', query: 'search_query: ' };
  if (/e5/i.test(model)) return { doc: 'passage: ', query: 'query: ' };
  return { doc: '', query: '' };
}

// Sends `texts` in batches with the model's task prefix; `run` returns one vector per input, in order.
async function batched(
  texts: string[],
  kind: 'doc' | 'query',
  model: string,
  size: number,
  run: (input: string[]) => Promise<number[][]>,
): Promise<Float32Array[]> {
  const px = prefixes(model)[kind];
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += size) {
    for (const v of await run(texts.slice(i, i + size).map((t) => px + t))) out.push(Float32Array.from(v));
  }
  return out;
}

export function ollamaEmbedder(model = 'nomic-embed-text', baseUrl = 'http://localhost:11434'): Embedder {
  return {
    id: `ollama:${model}`,
    embed: (texts, kind) => batched(texts, kind, model, BATCH, async (input) => (await postJson(`${baseUrl}/api/embed`, { model, input })).embeddings),
  };
}

export function openaiEmbedder(model = 'text-embedding-3-small', baseUrl = 'https://api.openai.com/v1', apiKey?: string): Embedder {
  return {
    id: `openai-compatible:${model}`,
    embed: (texts, kind) =>
      batched(texts, kind, model, BATCH, async (input) => {
        const j = await postJson(`${baseUrl}/embeddings`, { model, input }, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
        return (j.data as { index: number; embedding: number[] }[]).sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }),
  };
}

export async function localEmbedder(model = 'Xenova/all-MiniLM-L6-v2'): Promise<Embedder> {
  const pkg = '@huggingface/transformers'; // variable specifier: kept out of the bundle on purpose
  const mod: any = await import(pkg);
  const extractor = await mod.pipeline('feature-extraction', model);
  return {
    id: `local:${model}`,
    embed: (texts, kind) => batched(texts, kind, model, 16, async (input) => (await extractor(input, { pooling: 'mean', normalize: true })).tolist()),
  };
}

async function ollamaReady(model: string, baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j: any = await r.json();
    return (j.models ?? []).some((m: any) => String(m.name).startsWith(model));
  } catch {
    return false;
  }
}

// Returns undefined (=> keyword-only search) when nothing usable is configured. Never throws.
export async function resolveEmbedder(cfg: EmbeddingConfig): Promise<Embedder | undefined> {
  try {
    switch (cfg.provider) {
      case 'off':
        return undefined;
      case 'ollama':
        return ollamaEmbedder(cfg.model, cfg.baseUrl);
      case 'openai-compatible':
        return openaiEmbedder(cfg.model, cfg.baseUrl, cfg.apiKey);
      case 'local':
        return await localEmbedder(cfg.model);
      case 'auto': {
        const m = cfg.model ?? 'nomic-embed-text';
        const url = cfg.baseUrl ?? 'http://localhost:11434';
        if (await ollamaReady(m, url)) return ollamaEmbedder(m, url);
        try {
          return await localEmbedder();
        } catch {
          return undefined;
        }
      }
    }
  } catch {
    return undefined;
  }
}

// Dependency-free hashing-trick embedder: a weak lexical baseline used only for tests and offline plumbing checks.
export function hashEmbedder(dim = 256): Embedder {
  return {
    id: `hash:${dim}`,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(dim);
        for (const w of t.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
          v[(h >>> 0) % dim] += (h & 0x80000000) === 0 ? 1 : -1;
        }
        return v;
      });
    },
  };
}
