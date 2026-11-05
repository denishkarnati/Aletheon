// Retrieval benchmark on the real RP2040 datasheet. Queries are PARAPHRASES (little lexical overlap with the answer text);
// a hit is "relevant" when its passage matches every regex in `must` (ground truth written from the datasheet text).
// Usage: BENCH_EMBED=off|auto|ollama|openai-compatible|local|hash  npm run bench:retrieval
import * as os from 'node:os';
import * as path from 'node:path';
import { DocStore } from '../src/core/docs';
import { Embedder, hashEmbedder, resolveEmbedder } from '../src/core/embeddings';

const URL = 'https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf';

const QUERIES: { q: string; must: RegExp[] }[] = [
  { q: 'how fast can the processor cores be clocked at most', must: [/133\s?MHz/i] },
  { q: 'amount of on-chip static memory available to the chip', must: [/264\s?kB/i] },
  { q: 'which pins can carry the serial transmit line of the first UART', must: [/UART0 TX/] },
  { q: 'bit resolution and sampling speed of the analogue to digital converter', must: [/12.bit/i, /500\s?ksps/i] },
  { q: 'how many programmable I/O state machines exist', must: [/four.{0,40}state machines|4.{0,10}state machines/i] },
  { q: 'how many channels can the direct memory access engine run concurrently', must: [/12\s+(independent\s+)?channels|12 DMA channels/i] },
  { q: 'size of the cache that sits in front of external flash', must: [/16\s?kB/i, /cache/i] },
  { q: 'maximum data rate of the USB controller', must: [/12\s?Mbps|Full Speed/i] },
  { q: 'what frequency does the crystal oscillator expect', must: [/12\s?MHz/i, /XOSC|crystal/i] },
  { q: 'how is the microsecond tick for the timer produced', must: [/tick/i, /TIMER/i] },
  { q: 'which register holds the received character of the uart', must: [/UARTDR/] },
  { q: 'how does the chip enter the bootloader to be programmed over usb', must: [/BOOTSEL/] },
];

async function main(): Promise<void> {
  const store = new DocStore(path.join(os.tmpdir(), 'aletheon-bench-docs'));
  if (!store.list().length) {
    console.log('indexing RP2040 datasheet…');
    await store.index(URL);
  }
  const mode = process.env.BENCH_EMBED ?? 'off';
  const embedder: Embedder | undefined =
    mode === 'hash'
      ? hashEmbedder()
      : mode === 'off'
        ? undefined
        : await resolveEmbedder({ provider: mode as any, model: process.env.BENCH_MODEL, baseUrl: process.env.BENCH_URL, apiKey: process.env.OPENAI_API_KEY });
  if (mode !== 'off' && !embedder) {
    console.log(`embedder "${mode}" is not available on this machine; nothing to benchmark.`);
    process.exit(2);
  }
  if (embedder) {
    const t0 = Date.now();
    const r = await store.ensureEmbedded(embedder, () => undefined);
    console.log(`embedder ${embedder.id}: ${r.embedded} chunks embedded, ${r.reused} reused (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  let h1 = 0,
    h5 = 0,
    mrr = 0,
    usable = 0;
  for (const { q, must } of QUERIES) {
    const res = await store.search(q, 5, embedder);
    const rel = res.hits.map((h) => must.every((re) => re.test(h.excerpt)));
    const first = rel.indexOf(true);
    usable++;
    if (first === 0) h1++;
    if (first >= 0) h5++;
    if (first >= 0) mrr += 1 / (first + 1);
    console.log(
      `${first === 0 ? 'HIT@1' : first > 0 ? `HIT@${first + 1}` : 'MISS '} [${res.mode}] ${q}${first >= 0 ? `  (p.${res.hits[first].page})` : `  top: p.${res.hits[0]?.page ?? '-'}`}`,
    );
  }
  console.log(`\nmode=${mode}  hit@1 ${h1}/${usable}  hit@5 ${h5}/${usable}  MRR ${(mrr / usable).toFixed(3)}`);
}
main();
