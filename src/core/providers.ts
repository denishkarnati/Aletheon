export interface ProviderConfig {
  // aletheon-cloud speaks the Anthropic Messages wire format to the Aletheon gateway, authenticated with the user's session token.
  provider: 'anthropic' | 'openai-compatible' | 'aletheon-cloud';
  model: string;
  baseUrl?: string;
  apiKey?: string; // for aletheon-cloud: the signed-in user's access token
  maxTokens?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Call {
  id: string;
  name: string;
  args: unknown;
}
export interface ToolResult {
  id: string;
  name: string;
  content: string;
}

export type Turn = { role: 'user'; text: string } | { role: 'assistant'; text: string; calls: Call[] } | { role: 'tool'; results: ToolResult[] };

// Tokens as reported by the provider. cacheRead/cacheWrite are Anthropic prompt-cache tokens (0 elsewhere).
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export interface Completion {
  text: string;
  calls: Call[];
  usage: Usage;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  onText?: (delta: string) => void; // streamed text as it arrives
}

export const DEFAULT_CLOUD_URL = 'https://api.aletheon.dev';

export async function complete(cfg: ProviderConfig, system: string, turns: Turn[], tools: ToolSpec[], opts: CompleteOptions = {}): Promise<Completion> {
  if (cfg.provider === 'aletheon-cloud') {
    if (!cfg.apiKey) throw new Error('Not signed in. Run "Aletheon: Sign In" to use Aletheon Cloud.');
    return anthropic(cfg, system, turns, tools, opts);
  }
  if (!cfg.apiKey && !(cfg.provider === 'openai-compatible' && cfg.baseUrl)) throw new Error('No API key set. Run "Aletheon: Set AI Provider API Key".');
  return cfg.provider === 'anthropic' ? anthropic(cfg, system, turns, tools, opts) : openai(cfg, system, turns, tools, opts);
}

// Rate limits (429), overload (529) and transient 5xx are retried with backoff, honouring retry-after; other errors fail fast.
// Retries happen only before a stream starts, so no output is ever duplicated.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 4;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  const s = Number(retryAfter);
  if (retryAfter && Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 250);
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (r.ok) return r;
    const text = await r.text();
    if (!RETRYABLE.has(r.status) || attempt >= MAX_RETRIES) throw new Error(`Provider HTTP ${r.status}: ${text.slice(0, 500)}`);
    await sleep(retryDelayMs(attempt, r.headers.get('retry-after')), signal);
  }
}

// Server-sent events: yields each `data:` payload (JSON-decoded); `[DONE]` ends the stream.
export async function* sse(r: Response): AsyncGenerator<any> {
  if (!r.body) return;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? '\n\n' : dec.decode(value, { stream: true });
    let m: RegExpExecArray | null;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const event = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
    if (done) return;
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

// ---- Anthropic Messages API (also the Aletheon Cloud gateway) ---------------------------------------------------

const EPHEMERAL = { type: 'ephemeral' } as const;

// Prompt-cache breakpoints: system prompt, the last tool spec (caches all tools), and the last message, so every step of
// an agent run re-reads the previous steps from cache instead of paying full input price for them again.
export function anthropicBody(cfg: ProviderConfig, system: string, turns: Turn[], tools: ToolSpec[]): Record<string, unknown> {
  const messages: any[] = turns.map((t) => {
    if (t.role === 'user') return { role: 'user', content: [{ type: 'text', text: t.text }] };
    if (t.role === 'assistant')
      return {
        role: 'assistant',
        content: [...(t.text ? [{ type: 'text', text: t.text }] : []), ...t.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))],
      };
    return { role: 'user', content: t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) };
  });
  const last = messages.at(-1)?.content?.at(-1);
  if (last) last.cache_control = EPHEMERAL;
  return {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 8192,
    stream: true,
    system: [{ type: 'text', text: system, cache_control: EPHEMERAL }],
    messages,
    tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t)),
  };
}

async function anthropic(cfg: ProviderConfig, system: string, turns: Turn[], tools: ToolSpec[], opts: CompleteOptions): Promise<Completion> {
  const cloud = cfg.provider === 'aletheon-cloud';
  const base = cfg.baseUrl || (cloud ? DEFAULT_CLOUD_URL : 'https://api.anthropic.com');
  const auth: Record<string, string> = cloud ? { authorization: `Bearer ${cfg.apiKey}` } : { 'x-api-key': cfg.apiKey ?? '' };
  const r = await post(`${base}/v1/messages`, { ...auth, 'anthropic-version': '2023-06-01' }, anthropicBody(cfg, system, turns, tools), opts.signal);
  const usage = emptyUsage();
  const blocks: { type: string; text?: string; id?: string; name?: string; json?: string }[] = [];
  for await (const ev of sse(r)) {
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage ?? {};
        usage.input = u.input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
        break;
      }
      case 'content_block_start':
        blocks[ev.index] =
          ev.content_block.type === 'tool_use'
            ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, json: '' }
            : { type: ev.content_block.type, text: '' };
        break;
      case 'content_block_delta': {
        const b = blocks[ev.index];
        if (ev.delta.type === 'text_delta' && b) {
          b.text += ev.delta.text;
          opts.onText?.(ev.delta.text);
        } else if (ev.delta.type === 'input_json_delta' && b) b.json += ev.delta.partial_json;
        break;
      }
      case 'message_delta':
        if (ev.usage?.output_tokens !== undefined) usage.output = ev.usage.output_tokens;
        break;
      case 'error':
        throw new Error(`Provider stream error: ${ev.error?.type ?? ''} ${ev.error?.message ?? ''}`.trim());
    }
  }
  return {
    text: blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join(''),
    calls: blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, args: safeJson(b.json!) })),
    usage,
  };
}

// ---- OpenAI-compatible chat completions (OpenAI, Ollama, OpenRouter, Gemini endpoint, ...) ----------------------

async function openai(cfg: ProviderConfig, system: string, turns: Turn[], tools: ToolSpec[], opts: CompleteOptions): Promise<Completion> {
  const messages: any[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') messages.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant')
      messages.push({
        role: 'assistant',
        content: t.text || null,
        ...(t.calls.length
          ? { tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    else for (const r of t.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
  }
  const base = cfg.baseUrl || 'https://api.openai.com/v1';
  const r = await post(
    `${base}/chat/completions`,
    cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    {
      model: cfg.model,
      messages,
      stream: true,
      // Not every compatible server accepts stream_options; only ask for usage where it is known to work.
      ...(base.includes('api.openai.com') ? { stream_options: { include_usage: true } } : {}),
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    },
    opts.signal,
  );
  const usage = emptyUsage();
  let text = '';
  const calls: { id: string; name: string; args: string }[] = [];
  for await (const ch of sse(r)) {
    if (ch.usage) {
      usage.input = ch.usage.prompt_tokens ?? 0;
      usage.output = ch.usage.completion_tokens ?? 0;
      usage.cacheRead = ch.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }
    const d = ch.choices?.[0]?.delta;
    if (!d) continue;
    if (d.content) {
      text += d.content;
      opts.onText?.(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
  }
  return { text, calls: calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: safeJson(c.args) })), usage };
}
