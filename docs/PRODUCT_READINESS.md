# Product readiness: bottlenecks and organization plan

What stands between Aletheon today (alpha, 0.1.0) and a product people can rely on. Each item says how we know, how much it
matters, and the fix. Measurements were taken on 2026-10-26 (Windows 11, Node 24, AMD Ryzen AI 7 PRO 350). Re-measure before
quoting them.

Severity: **P0** blocks a credible public release · **P1** hurts users at scale · **P2** quality and maintainability.

## Summary

| # | Bottleneck | Area | Severity | Status |
|---|---|---|---|---|
| 1 | Nothing has been run on a real board | verification | P0 | open, needs hardware |
| 2 | The agent loop and VS Code UI have no automated tests, and no real LLM has been scored | verification | P0 | open |
| 3 | Agent resends the full history every step (~9x token overhead) | cost / latency | P1 | open |
| 4 | Keyword search misses paraphrased questions (hit@1 4/12) | answer quality | P1 | semantic search built, not measured |
| 5 | Evidence ledger rewrites the whole file on every entry (quadratic) | performance | P1 | open |
| 6 | No streaming: the user sees nothing until a model step finishes | UX | P1 | open |
| 7 | MCP server echoes any protocol version the client asks for | interoperability | P1 | open |
| 8 | `tools.ts` holds 17 tools plus toolchain logic in one file | organization | P2 | open |
| 9 | Boards are TypeScript code, not data | contribution | P2 | open |
| 10 | No linter or formatter in CI | code quality | P2 | open |
| 11 | Version number duplicated in two places | release | P2 | open |
| 12 | Release setup: owner placeholders, Marketplace / Open VSX publisher, Pages | release | P0 for launch | open |

Fixed in this round: Windows timeouts left processes running; `%` expansion on Windows; Node 24 `DEP0190` warning; no retry on
rate limits; no unit tests for the parser and generator; no reproducible evidence or examples. See [CHANGELOG.md](../CHANGELOG.md).

## 1. Verification gaps (P0)

**1. No real-board results.** Every build, flash and serial path has been exercised only up to "compiles". The RP2040 driver in
[examples/](../examples/rp2040-uart-driver/TRANSCRIPT.md) cross-compiles cleanly but has never sent a byte. A product that promises
evidence has to show `measured` evidence for its own registry boards.
*Fix:* one hardware-in-the-loop run per registry board (procedure in [HANDBOOK §7](HANDBOOK.md#7-hardware-in-the-loop-adding-measured-evidence)),
committed as an example with its ledger. Later: a self-hosted CI runner with a Pico and a Nucleo attached.

**2. Untested agent loop and UI.** `src/core/agent.ts`, `src/extension/*` and the provider adapters have no automated tests. The
grounding benchmark has scored only canned answers.
*Fix:* (a) agent-loop tests with a scripted fake provider: tool calls, audit warning, step limit, abort; (b) `@vscode/test-electron`
smoke test that activates the extension and runs each command; (c) run `bench:grounding` against at least two real models and
publish the scores with the answers.

## 2. Performance and cost

**3. Agent token overhead (P1, estimated).** `runAgent` sends the system prompt, all tool specs and the whole history on every step
(up to 14). With typical tool results of ~3.6k characters per step, one answer costs about **124k input tokens to carry ~14k tokens
of unique content**. That is a chars/4 estimate, not a billed measurement.
*Fix:* prompt caching on the system prompt and tool specs (Anthropic `cache_control`); replace tool results older than the last few
steps with their one-line summary plus the `[E#]` id (the full text stays in the ledger); measure real usage from the provider's
`usage` field and add it to the evidence report.

**4. Retrieval quality (P1, measured).** Keyword-only search: hit@1 4/12, hit@5 7/12, MRR 0.419
([log](../evidence/logs/retrieval.log)). The examples show the cost: the first search for the RP2040 divisor-latch rule and the
STM32 supply range both missed, and needed rephrasing. Hybrid search exists but its gain has never been measured.
*Fix:* run `BENCH_EMBED=ollama npm run bench:retrieval` and `BENCH_EMBED=local`, publish the numbers, and enable the better mode by
default if it helps. Grow the question set beyond 12 and beyond one datasheet.

**5. Ledger writes are quadratic (P1, measured).** `Ledger.add` rewrites the whole JSON file synchronously, on the editor's
extension-host thread. Adding 2,000 entries of ~900 characters each took **0.37 s for the first 200, 3.0 s for 1,000 and 8.6 s for
2,000**, with each later write costing ~6 ms of blocked UI. The ledger lives for the life of a workspace and every search adds up to 8
entries, so this grows without bound.
*Fix:* append-only JSON Lines (`ledger.jsonl`), one line per entry and an in-memory index, with a migration that reads the old file.
`setExcerpt` becomes an appended update record.

**6. No streaming (P1).** `providers.ts` waits for each complete response. On a 14-step run the chat shows nothing for long periods.
*Fix:* stream text deltas from both providers and show tool progress as it happens.

Not a bottleneck (checked): loading a 642-page indexed datasheet takes 6 ms; parsed SVDs are 1.2 MB and load at startup without
noticeable delay; header generation for all 210 peripherals takes under 3 s.

## 3. Interoperability

**7. MCP version handling (P1).** `src/mcp/server.ts` replies to `initialize` with whatever `protocolVersion` the client sent, so it
claims to support versions it has never been tested against. It also implements only `tools/*` and `ping`.
*Fix:* answer with the newest version from an explicit supported list (negotiation as the spec describes), add a stdio test that
drives `initialize` → `tools/list` → `tools/call`, or move to the official MCP TypeScript SDK if the dependency is acceptable.

## 4. Code organization

The core split is already right: `src/core` has no VS Code dependency, so the extension and the MCP server share one tool layer. What
needs to change is inside it.

**8. Split `tools.ts` (P2).** It holds the tool schemas and implementations, toolchain command tables, the serial-capture script and
REA pinning. Target layout:

```
src/core/tools/
  index.ts        TOOLS registry + callTool (what tools.ts exports today)
  docs.ts         index_datasheet, search_datasheets
  registers.ts    index_svd, lookup_register, cross_check_register, generate_regs_header, check_header
  audit.ts        audit_claims
  workspace.ts    list_dir, read_file, write_file (+ inRoot)
  hardware.ts     detect_boards, build, flash, serial_capture (+ toolchain tables)
  rea.ts          rea_run
src/core/prompts/agent.md     system prompt, versioned and reviewed like code
```

No public behaviour changes. Tool names and schemas stay identical, so MCP clients are unaffected.

**9. Boards as data (P2).** `boards.ts` is code, so adding a board means writing TypeScript. Move the registry to
`boards/<id>.json`, validated by a JSON Schema in a unit test. A board pull request then becomes a single data file.

**10. Lint and format (P2).** There is only `.editorconfig`. Add ESLint (typescript-eslint, strict) and Prettier, run both in CI, and
format the tree once in a single commit.

**11. One version source (P2).** `0.1.0` appears in `package.json` and in `server.ts` (`serverInfo.version`). Inject it at build time
with an esbuild `define` from `package.json`.

## 5. Release (P0 for launch)

- Replace `denishkarnati`: `node scripts/set-owner.mjs <owner>`.
- Create the `aletheon` publisher on the VS Code Marketplace and on Open VSX (Cursor and Windsurf install from Open VSX), and add
  publish steps to `release.yml` with tokens stored as repository secrets.
- Enable GitHub Pages (Source: GitHub Actions) before the first push to `main`, or `pages.yml` fails.
- Turn on branch protection for `main`: CI required, DCO check, one review.
- Keep `docs/private/` out of the repository. It is gitignored. Check `git status` before the first push.

## 6. Suggested order

1. Release setup (§5) and the MCP version fix (#7). Small, and they unblock publishing.
2. Real-board runs (#1) and one real model on the benchmark (#2c). These turn "alpha, unmeasured" into numbers.
3. Agent cost and streaming (#3, #6). They directly affect every user and every bill.
4. Ledger JSONL (#5) and the semantic-search measurement (#4).
5. Organization (#8–#11), done as pure refactors with the unit and example suites as the safety net.
6. Then the new-audience features in the [roadmap](HANDBOOK.md#9-roadmap): SystemRDL / IP-XACT, UVM output, live debug-probe reads.
