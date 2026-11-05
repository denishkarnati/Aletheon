// Offline tests for the agent loop and the provider adapters. fetch is replaced by a scripted fake that returns the providers'
// real streaming (SSE) formats, so parsing, prompt caching, retries, cloud auth, history compaction and the step limit are
// checked without a network or an API key.
// Run: npm run test:agent
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentEvent, compactHistory, runAgent } from '../src/core/agent';
import { ProviderConfig, Turn, anthropicBody, complete } from '../src/core/providers';
import { createToolCtx } from '../src/core/tools';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

interface Req {
  url: string;
  headers: Record<string, string>;
  body: any;
}
const requests: Req[] = [];
let script: (() => Response)[] = [];

const sseResponse = (events: unknown[], chunk = 7): Response => {
  // Split the byte stream at awkward offsets so the parser has to reassemble events across reads.
  const text = events.map((e) => `event: x\ndata: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

const anthropicTurn = (opts: { text?: string; tool?: { id: string; name: string; input: unknown }; usage?: Record<string, number> }): Response => {
  const ev: unknown[] = [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...opts.usage } },
    },
  ];
  let i = 0;
  if (opts.text) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    for (const part of opts.text.match(/.{1,5}/g) ?? []) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: part } });
    ev.push({ type: 'content_block_stop', index: i++ });
  }
  if (opts.tool) {
    const json = JSON.stringify(opts.tool.input);
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: opts.tool.id, name: opts.tool.name, input: {} } });
    ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json.slice(0, 3) } });
    ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json.slice(3) } });
    ev.push({ type: 'content_block_stop', index: i });
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: opts.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } });
  ev.push({ type: 'message_stop' });
  return sseResponse(ev);
};

globalThis.fetch = (async (url: string, init: RequestInit) => {
  requests.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  const next = script.shift();
  if (!next) throw new Error('fake fetch: no scripted response left');
  return next();
}) as typeof fetch;

const anth: ProviderConfig = { provider: 'anthropic', model: 'claude-test', apiKey: 'sk-test' };

async function main(): Promise<void> {
  // ---- Anthropic streaming: text + tool call split across deltas, usage including cache tokens
  script = [
    () =>
      anthropicTurn({
        text: 'Looking it up.',
        tool: { id: 'tu_1', name: 'lookup_register', input: { peripheral: 'UART0', register: 'UARTFR' } },
        usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
      }),
  ];
  const deltas: string[] = [];
  const c1 = await complete(anth, 'sys', [{ role: 'user', text: 'hi' }], [{ name: 't', description: 'd', input_schema: {} }], {
    onText: (d) => deltas.push(d),
  });
  check(
    'anthropic: streamed text reassembled',
    c1.text === 'Looking it up.' && deltas.join('') === 'Looking it up.' && deltas.length > 1,
    JSON.stringify(deltas),
  );
  check(
    'anthropic: tool call JSON reassembled from partial deltas',
    c1.calls.length === 1 && c1.calls[0].id === 'tu_1' && (c1.calls[0].args as any).register === 'UARTFR',
    JSON.stringify(c1.calls),
  );
  check(
    'anthropic: usage incl. cache tokens',
    c1.usage.input === 100 && c1.usage.output === 20 && c1.usage.cacheRead === 900 && c1.usage.cacheWrite === 50,
    JSON.stringify(c1.usage),
  );
  const r1 = requests.at(-1)!;
  check(
    'anthropic: x-api-key auth, streaming on',
    r1.headers['x-api-key'] === 'sk-test' && r1.body.stream === true && r1.url === 'https://api.anthropic.com/v1/messages',
  );

  // ---- prompt-cache breakpoints
  const tools = [
    { name: 'a', description: 'a', input_schema: {} },
    { name: 'b', description: 'b', input_schema: {} },
  ];
  const turns: Turn[] = [
    { role: 'user', text: 'q' },
    { role: 'assistant', text: '', calls: [{ id: 'x', name: 'a', args: {} }] },
    { role: 'tool', results: [{ id: 'x', name: 'a', content: 'result' }] },
  ];
  const body: any = anthropicBody(anth, 'system prompt', turns, tools);
  check('cache: system prompt marked', body.system[0].cache_control?.type === 'ephemeral');
  check('cache: last tool spec marked, others not', body.tools[1].cache_control?.type === 'ephemeral' && !body.tools[0].cache_control);
  check(
    'cache: last message block marked, earlier not',
    body.messages[2].content[0].cache_control?.type === 'ephemeral' && !body.messages[0].content[0].cache_control,
  );
  check('cache: input turns not mutated', !(turns[2] as any).results[0].cache_control);

  // ---- retry before the stream starts
  script = [() => new Response('{"error":"rate"}', { status: 429, headers: { 'retry-after': '0' } }), () => anthropicTurn({ text: 'ok' })];
  const before = requests.length;
  const c2 = await complete(anth, 's', [{ role: 'user', text: 'q' }], []);
  check('retry: 429 then success, two requests, one answer', c2.text === 'ok' && requests.length - before === 2);
  script = [() => new Response('bad key', { status: 401 })];
  let err = '';
  await complete(anth, 's', [{ role: 'user', text: 'q' }], []).catch((e) => (err = String(e)));
  check('retry: 401 fails fast with the provider message', err.includes('HTTP 401') && err.includes('bad key'));
  script = [
    () =>
      sseResponse([
        { type: 'message_start', message: { usage: {} } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ]),
  ];
  err = '';
  await complete(anth, 's', [{ role: 'user', text: 'q' }], []).catch((e) => (err = String(e)));
  check('stream error event surfaces as an error', err.includes('overloaded_error'));

  // ---- Aletheon Cloud: same wire format, bearer token, gateway URL
  script = [() => anthropicTurn({ text: 'cloud ok' })];
  const cloud: ProviderConfig = { provider: 'aletheon-cloud', model: 'claude-test', apiKey: 'session-jwt', baseUrl: 'https://gw.example' };
  const c3 = await complete(cloud, 's', [{ role: 'user', text: 'q' }], []);
  const r3 = requests.at(-1)!;
  check(
    'cloud: bearer session token, no api key header',
    c3.text === 'cloud ok' && r3.headers.authorization === 'Bearer session-jwt' && !r3.headers['x-api-key'] && r3.url === 'https://gw.example/v1/messages',
  );
  err = '';
  await complete({ ...cloud, apiKey: undefined }, 's', [{ role: 'user', text: 'q' }], []).catch((e) => (err = String(e)));
  check('cloud: not signed in is a clear error', err.includes('Sign In'));

  // ---- OpenAI-compatible streaming with chunked tool calls
  script = [
    () =>
      sseResponse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'list_', arguments: '{"a"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'boards', arguments: ':1}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } },
        '[DONE]',
      ]),
  ];
  const c4 = await complete({ provider: 'openai-compatible', model: 'gpt-test', apiKey: 'k' }, 's', [{ role: 'user', text: 'q' }], tools);
  check('openai: streamed text', c4.text === 'Hello');
  check(
    'openai: tool call name and args reassembled',
    c4.calls[0]?.name === 'list_boards' && (c4.calls[0].args as any).a === 1 && c4.calls[0].id === 'call_9',
    JSON.stringify(c4.calls),
  );
  check('openai: usage when the server sends it', c4.usage.input === 50 && c4.usage.output === 7);
  check('openai: stream_options only for api.openai.com', !!requests.at(-1)!.body.stream_options);
  script = [() => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, '[DONE]'])];
  await complete({ provider: 'openai-compatible', model: 'llama', baseUrl: 'http://localhost:11434/v1' }, 's', [{ role: 'user', text: 'q' }], []);
  check('openai: no stream_options for other servers (e.g. Ollama)', requests.at(-1)!.body.stream_options === undefined);

  // ---- agent loop: tool step then final answer
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-agent-'));
  const ctx = createToolCtx({
    root,
    storeDir: path.join(root, '.aletheon'),
    getBoard: () => undefined,
    getToolchain: () => 'auto',
    getEmbedder: async () => undefined,
    confirm: async () => false,
    log: () => {},
  });
  script = [
    () => anthropicTurn({ text: 'Checking boards.', tool: { id: 'tu_a', name: 'list_boards', input: {} } }),
    () => anthropicTurn({ text: 'The registry has six boards.' }),
  ];
  const events: AgentEvent[] = [];
  const history: Turn[] = [];
  const answer = await runAgent({ cfg: anth, ctx, history, userText: 'Which boards?', onEvent: (e) => events.push(e) });
  check('agent: final answer returned', answer === 'The registry has six boards.');
  check(
    'agent: tool actually ran',
    events.some((e) => e.type === 'tool' && e.name === 'list_boards' && e.result.includes('rpi-pico')),
  );
  check(
    'agent: text streamed as deltas and marked streamed',
    events.filter((e) => e.type === 'delta').length > 2 && events.every((e) => e.type !== 'text' || e.streamed),
  );
  const u = events.find((e) => e.type === 'usage');
  check('agent: usage summed over both steps', u?.type === 'usage' && u.steps === 2 && u.usage.input === 200 && u.usage.output === 40, JSON.stringify(u));
  check('agent: history is user, assistant, tool, assistant', history.map((t) => t.role).join(',') === 'user,assistant,tool,assistant');
  const sent = requests.at(-1)!.body;
  check(
    'agent: second step sends the tool result back with tool_use_id',
    sent.messages[2].content[0].type === 'tool_result' && sent.messages[2].content[0].tool_use_id === 'tu_a',
  );

  // ---- compaction of earlier answers
  const long: Turn[] = [
    { role: 'user', text: 'q1' },
    { role: 'assistant', text: '', calls: [{ id: 'c', name: 'search_datasheets', args: {} }] },
    {
      role: 'tool',
      results: [
        {
          id: 'c',
          name: 'search_datasheets',
          content: '[search mode: keyword]\n\n[E5] ds p.430:\n' + 'x'.repeat(2000) + '\n\n[E6] ds p.431:\n' + 'y'.repeat(2000),
        },
      ],
    },
    { role: 'tool', results: [{ id: 'd', name: 'list_boards', content: 'short result' }] },
  ];
  compactHistory(long);
  const compacted = (long[2] as any).results[0].content as string;
  check(
    'compact: long result cut, evidence ids kept',
    compacted.length < 400 && compacted.includes('[E5]') && compacted.includes('[E6]') && compacted.startsWith('[search mode: keyword]'),
    compacted,
  );
  check('compact: short result untouched', (long[3] as any).results[0].content === 'short result');
  script = [() => anthropicTurn({ text: 'second answer' })];
  const toolContentBefore = (history[2] as any).results[0].content as string;
  await runAgent({ cfg: anth, ctx, history, userText: 'And again?', onEvent: () => {} });
  const toolContentAfter = (history[2] as any).results[0].content as string;
  check(
    'compact: runs on earlier answers when a new question starts',
    toolContentBefore.length > 400 && toolContentAfter.includes('compacted') && toolContentAfter.length < 400,
    `${toolContentBefore.length} -> ${toolContentAfter.length}`,
  );

  // ---- step limit
  script = Array.from({ length: 14 }, (_, i) => () => anthropicTurn({ tool: { id: `loop_${i}`, name: 'list_boards', input: {} } }));
  const warns: string[] = [];
  const stopped = await runAgent({ cfg: anth, ctx, history: [], userText: 'loop', onEvent: (e) => e.type === 'warn' && warns.push(e.text) });
  check('agent: stops after 14 tool steps with a warning', stopped.includes('Stopped after 14') && warns.some((w) => w.includes('14')) && script.length === 0);

  // ---- abort
  const ac = new AbortController();
  ac.abort(new Error('user stopped'));
  script = [() => new Response('{}', { status: 529 })];
  err = '';
  await complete(anth, 's', [{ role: 'user', text: 'q' }], [], { signal: ac.signal }).catch((e) => (err = String(e)));
  check('abort: a stopped run does not keep retrying', err.includes('user stopped'), err);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main();
