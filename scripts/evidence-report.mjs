// Runs every test suite and benchmark, keeps the full raw output of each, and writes evidence/REPORT.md:
// environment, per-suite exit code, duration, PASS/FAIL counts and the SHA-256 of each raw log.
// The logs are the evidence; the report only summarises them, so anyone can check a number against its log.
//   npm run evidence            (needs network for the vendor-file suites, and a C compiler for the header compile)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'evidence');
const logDir = path.join(outDir, 'logs');
const hdrDir = path.join(root, 'hdrs'); // gitignored; relative paths keep machine-specific paths out of the logs

const SUITES = [
  { id: 'typecheck', what: 'TypeScript strict typecheck of src, test, bench', cmd: 'npm run typecheck' },
  { id: 'build', what: 'Bundle the VS Code extension and the MCP server', cmd: 'npm run build' },
  { id: 'unit', what: 'Offline unit tests: SVD parser, CMSIS-Pack reader, header generator, argument safety, provider backoff', cmd: 'npm run test:unit' },
  { id: 'net', what: 'SSRF guard: private, link-local and metadata addresses blocked, redirects re-checked', cmd: 'npm run test:net' },
  { id: 'embeddings', what: 'Semantic index build, staleness and failure handling', cmd: 'npm run test:embeddings' },
  { id: 'audit', what: 'Trust classes, claim audit with forged evidence, SVD vs datasheet cross-check on 91 real RP2040 registers', cmd: 'npm run test:audit' },
  { id: 'grounding', what: 'Benchmark scorer self-test: grounded vs hallucinated, laundered and uncited answers', cmd: 'npm run bench:grounding' },
  {
    id: 'headers',
    what: 'Generate a header for every peripheral of four real SVDs and re-simulate every struct layout',
    cmd: 'npm run test:headers',
    env: { HDR_OUT: 'hdrs' },
  },
  { id: 'headers-compile', what: 'Compile all generated headers with clang -Wall -Werror as C11 and C++17', cmd: 'bash scripts/compile-headers.sh hdrs' },
  { id: 'retrieval', what: 'Datasheet search quality on 12 paraphrased questions (a measurement, not pass/fail)', cmd: 'npm run bench:retrieval' },
];

const sh = (cmd) => spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8' });
const version = (cmd) => {
  const r = sh(cmd);
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : 'not found';
};
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Logs are meant to be published: replace this machine's repo, temp and home paths (any slash style) with placeholders.
const pathPattern = (p) =>
  new RegExp(
    p
      .split(/[\\/]+/)
      .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]+'),
    'gi',
  );
const PRIVATE = [
  [pathPattern(root), '<repo>'],
  [pathPattern(os.tmpdir()), '<tmp>'],
  [pathPattern(os.homedir()), '~'],
  [/\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '~'], // 8.3 short forms (DKARNA~1) and other spellings of the home dir
  [/\/[a-z]\/Users\/[^/\s"']+/gi, '~'], // Git Bash style: /c/Users/<name>
];
export const scrub = (s) => PRIVATE.reduce((t, [re, r]) => t.replace(re, r), s);

if (process.argv[2] === '--scrub-selftest') {
  for (const t of [
    'C:/Users/SOMEON~1/AppData/Local/Temp/x',
    `${root}${path.sep}src${path.sep}a.ts`,
    path.join(os.tmpdir(), 'h'),
    '/c/Users/someone/x',
    'plain 0x40034018 C:/Program Files/x',
  ])
    console.log(JSON.stringify(t), '=>', JSON.stringify(scrub(t)));
  process.exit(0);
}

fs.rmSync(hdrDir, { recursive: true, force: true });
fs.mkdirSync(logDir, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const started = new Date();
const env = [
  ['Aletheon', pkg.version],
  ['Date (UTC)', started.toISOString().replace('T', ' ').slice(0, 19)],
  ['OS', `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`],
  ['CPU', `${os.cpus()[0]?.model.trim() ?? 'unknown'} x${os.cpus().length}`],
  ['Node', process.version],
  ['npm', version('npm --version')],
  [
    'C compiler',
    [version('gcc --version'), version('clang --version'), version('python -m ziglang cc --version')].find((v) => v !== 'not found') ?? 'not found',
  ],
];

const rows = [];
for (const s of SUITES) {
  process.stdout.write(`${s.id} ... `);
  const t0 = Date.now();
  const r = spawnSync(s.cmd, { cwd: root, shell: true, encoding: 'utf8', env: { ...process.env, ...(s.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 });
  const secs = (Date.now() - t0) / 1000;
  const log = scrub(`$ ${s.cmd}\n${r.stdout ?? ''}${r.stderr ? '\n--- stderr ---\n' + r.stderr : ''}\n--- exit ${r.status} after ${secs.toFixed(1)} s ---\n`);
  fs.writeFileSync(path.join(logDir, `${s.id}.log`), log);
  const pass = (log.match(/^PASS /gm) ?? []).length;
  const fail = (log.match(/^FAIL /gm) ?? []).length;
  const summary = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /ALL PASS|FAILED|SELF-TEST|peripherals \d|compiled \d+ headers|ADDR macros|hit@|failures:/.test(l))
    .slice(0, 3)
    .join('; ');
  rows.push({ ...s, status: r.status, secs, pass, fail, summary, sha: sha(log) });
  console.log(r.status === 0 ? `ok (${secs.toFixed(1)} s)` : `exit ${r.status}`);
}

const ok = rows.every((r) => r.status === 0);
const md = [
  '# Test evidence report',
  '',
  `> Generated by \`npm run evidence\`. Every number below is copied from a raw log in [logs/](logs/); each log's SHA-256 is listed so a`,
  '> reviewer can confirm the log was not edited after the run. Rerun the command on your machine to reproduce.',
  '',
  `**Result: ${ok ? 'all suites passed' : 'one or more suites FAILED'}.**`,
  '',
  '## Environment',
  '',
  '| | |',
  '|---|---|',
  ...env.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`),
  '',
  '## Suites',
  '',
  '| Suite | What it checks | Exit | Checks passed / failed | Time | Key output |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| [${r.id}](logs/${r.id}.log) | ${r.what} | ${r.status === 0 ? '0 ✅' : `${r.status} ❌`} | ${r.pass || r.fail ? `${r.pass} / ${r.fail}` : '–'} | ${r.secs.toFixed(1)} s | ${r.summary.replace(/\|/g, '\\|') || '–'} |`,
  ),
  '',
  `Total individual checks: **${rows.reduce((n, r) => n + r.pass, 0)} passed, ${rows.reduce((n, r) => n + r.fail, 0)} failed** (suites that print PASS/FAIL lines).`,
  '',
  '## Log hashes (SHA-256)',
  '',
  '```text',
  ...rows.map((r) => `${r.sha}  logs/${r.id}.log`),
  '```',
  '',
  '## What is not covered here',
  '',
  '- Behaviour on real boards: no `flash` or `serial_capture` run is part of this report.',
  '- A real LLM answering the grounding benchmark: only the scorer is self-tested.',
  '- Worked examples with full tool transcripts live in [examples/](../examples/) (`npm run examples`).',
  '',
];
fs.writeFileSync(path.join(outDir, 'REPORT.md'), md.join('\n'));
console.log(`\nwrote evidence/REPORT.md (${ok ? 'all passed' : 'FAILURES'})`);
process.exit(ok ? 0 : 1);
