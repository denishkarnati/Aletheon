# Aletheon engineering notes (architecture, measurements, limits)

*aletheia* (Greek): truth, "that which is not hidden". Aletheon is an AI firmware engineer for VS Code
(and any MCP-capable IDE) that refuses to work from assumptions: every register, pin, voltage or timing
claim must cite an **evidence ledger** entry `[E#]` — a datasheet page, a real build log, a real serial
capture, or a reverse-engineering result from [REA](https://github.com/morluto/rea).

> Name is a working title. Run trademark/domain checks before launch.

## How it works

```
 VS Code extension (sidebar chat, board picker)      MCP server (dist/mcp.js)
            \                                         /  Claude Code, Cursor, Codex, Gemini CLI, ...
             +----------------  src/core  -----------+
   boards registry · evidence ledger + grounding check · datasheet index/search (page-cited)
   tools: detect_boards, index/search_datasheets, build, flash*, serial_capture, rea_run, files*
   providers: Anthropic (Claude) · OpenAI-compatible (OpenAI, Ollama, OpenRouter, Gemini endpoint)
                                              * asks the user before acting
```

The agent loop (`src/core/agent.ts`) gives the model the tools plus grounding rules, then runs
`auditClaims()` (`src/core/audit.ts`) on the answer and warns about uncited or unsupported hardware claims and invented `[E#]` ids.
Evidence persists in `<workspace>/.aletheon/ledger.json`.

## Run it

```bash
npm install
npm run build        # dist/extension.js + dist/mcp.js
```
- **VS Code**: open this folder, press F5. Run *Aletheon: Set AI Provider API Key*, pick a board, open the sidebar.
- **Other IDEs / agents (MCP)**: `ALETHEON_ROOT=<project> ALETHEON_BOARD=rpi-pico node dist/mcp.js`
  (add `ALETHEON_ALLOW_WRITE=1` to permit write_file/flash).
- **Package**: `npm i -g @vscode/vsce && npm run package` → `.vsix` (works in VS Code, Cursor, Windsurf, Arduino IDE 2).
- Toolchains must be installed separately: PlatformIO (`pio`), `arduino-cli`, or ESP-IDF (`idf.py`); serial capture needs Python + pyserial.

## Is the output legitimate? Provenance, claim audit, cross-check, benchmark
- **Provenance**: every ledger entry carries a trust class (`measured` > `vendor-official` > `derived` > `user-supplied` > `community-mirror` > `unknown`)
  and, for indexed files, the SHA-256 of the exact bytes. Vendor status is an allow-list of vendor domains/GitHub orgs, so a lookalike
  host is not trusted. The nRF52840 SVD in the registry is a community mirror and is labelled as such.
- **`audit_claims`** (also the MCP `ground_check`): every sentence that states a hardware value (hex address, V/mA/MHz/ns/baud, pin) must cite
  an `[E#]` whose excerpt actually contains that value. Catches uncited values, unknown ids, and "citation laundering" (a real id whose
  passage does not support the claim); notes claims resting only on community/unknown sources.
- **`cross_check_register`**: compares an SVD register's offset/address with the datasheet's own register table and returns agree / conflict /
  name-only / not-found with the page as evidence. On the real RP2040 files (91 registers across 20 peripherals): **87 agree, 1 false conflict,
  1 name-only, 2 not-found; with every offset deliberately shifted by 0x40, 0 agreed and 88 were flagged as conflicts.** Heuristic: tested on one
  vendor's datasheet layout only (RP2040), where the datasheet and SVD share an origin, so expect lower agreement on other vendors' PDFs.
- **Aletheon-Bench** (`npm run bench:grounding`): 20 questions built from the vendor SVD (10 known addresses, 6 invented registers, 4 peripherals
  the chip lacks). `--list` prints the questions for use with any assistant you are allowed to test; `answers.json` scores the replies. The built-in
  self-test proves the scorer separates grounded answers from hallucinated, citation-laundered and uncited ones (it is a test of the scorer, with
  canned answers; no real LLM has been scored yet because that needs an API key).

## Datasheet retrieval (hybrid keyword + semantic)
Datasheets are split into ~900-char passages (whitespace-aligned, 150 overlap, page number kept). `search_datasheets` fuses a
keyword ranking (exact identifiers like `UARTFBRD`) with an embedding ranking (paraphrases like "how fast can the cores run")
using reciprocal-rank fusion, so neither side's weakness sinks a query. Vectors are cached in `.aletheon/docs/*.emb`, keyed by
model id and chunking parameters, so changing either re-embeds. If no embedder works, search silently falls back to keyword and
the result says so (`[search mode: keyword; …]`), so the agent can tell the user retrieval was lexical-only.

Backends (`aletheon.embeddings.provider`, or MCP env `ALETHEON_EMBED[_MODEL|_URL|_KEY]`):
`ollama` (local; `nomic-embed-text`, with the model's task prefixes), `openai-compatible` (`/v1/embeddings`), `local`
(optional `@huggingface/transformers`, MiniLM; not bundled, so it suits the MCP/CLI install, not the `.vsix`), `auto`, `off`.

Measured so far: keyword-only baseline on 12 paraphrased questions over the real RP2040 datasheet (`npm run bench:retrieval`):
**hit@1 4/12, hit@5 7/12, MRR 0.419.** `npm run test:embeddings` (17 checks: chunk integrity, persistence, invalidation, fusion,
fallbacks, partial-failure cleanup) passes using fake embedders. **No real embedding model was available on this machine, so the
semantic improvement is not yet measured**; run `BENCH_EMBED=ollama npm run bench:retrieval` (or `local`) to get the number.

## Register maps (SVD / CMSIS-Pack)
`index_svd` parses a CMSIS-SVD file (URL, path, or a `.pack`/`.zip` with an `entry` to pick the SVD inside) into exact
peripheral base addresses, register offsets, reset values, access and bit fields, handling `derivedFrom`, `dim` arrays and
clusters. `lookup_register` answers "what is the address/bit layout of X" from that data, with each result recorded as `[E#]`.
The agent is instructed to use SVD for addresses/bit positions and the datasheet for electrical/timing, and to report a conflict
rather than pick one. Boards in the registry carry a default SVD URL (not Arduino Uno: AVR has no common SVD source).

## Driver workflow (SVD-grounded)
`generate_regs_header` deterministically emits a C header per peripheral from the SVD: `_BASE`, per-register
`_OFFSET/_ADDR/_REG/_RESET`, field `_Pos/_Msk`, enum values, a `volatile` struct view (`<P>_REGS`) and `offsetof` static asserts.
The model never types an address or bit position; it writes only driver logic on top of those macros. The agent follows:
index SVD -> datasheet search (init sequence, clocks, pin-mux, errata) -> generate header -> `check_header` -> write driver
(approval) -> `build` (real compiler output) -> optional flash + `serial_capture`. Command: *Aletheon: Generate Driver*.
`npm run test:headers` generates headers for every peripheral of four real SVDs and checks them.

Results: 210 peripherals / 8,264 registers / 27,904 fields from the RP2040, STM32F401, nRF52840 and ESP32-S3 SVDs.
Compiled with `zig cc` (clang, `-Wall -Werror`): all 210 headers standalone as C11, each device as one combined C11 and C++17
translation unit, and RP2040/STM32F401/nRF52840 for `thumb-freestanding` ARM targets: all clean. A negative control
(a corrupted offset) is rejected by the layout assert, and `check_header` fails on a tampered header. 18 overlapping registers
are kept as `_ADDR/_REG` macros but left out of the struct. This testing found and fixed a real bug: a bare `POWER` instance
macro rewrote the `POWER` struct member of nRF52840 RADIO, so instances are now `<P>_REGS`.
Not covered: GCC/ARMCC specifics (only clang tested), and that the *driver logic* an LLM writes is correct; that still needs
`build` plus flash and serial evidence on a real board. `check_header` finds gcc, clang, cc, `zig cc` or `python -m ziglang cc`.

## Verified so far
SVD: parsed RP2040 (1181 registers), STM32F401 (660), nRF52840 (2140), ESP32-S3 (4283) from the real vendor/community files;
11/11 smoke checks passed, including UART0/UART1 (`derivedFrom`), STM32 GPIOA/GPIOB ODR, and a real zip-format `.pack`.
Not checked: the SVD parser against every vendor's quirks (enumerated-value `derivedFrom`, nested `dim` in clusters).

Typecheck and bundle pass. MCP server smoke-tested over stdio: indexed the real RP2040 datasheet (642 pages),
search returned page-cited evidence, and `ground_check` flagged an uncited `0x…` claim and a fabricated `[E99]`.
**Not yet verified**: the VS Code UI (needs F5 + API key), the LLM agent loop end to end, and build/flash/serial
on real hardware. ST and Nordic doc links may block automated fetches — index a downloaded PDF instead.

## Known limits (MVP)
- Datasheet search is keyword/TF-IDF; page-level hits can miss the exact table. Next: embeddings + SVD/CMSIS-pack register maps.
- The grounding check is a heuristic safety net, not a proof; the build/flash/serial evidence is the real verification.
- Board registry has 6 boards; add more in `src/core/boards.ts`.

## Roadmap to a product
1. Register-map extraction (SVD) and driver generation with generated tests.
2. Hardware-in-the-loop test runner and logic-analyzer/pcap evidence via REA.
3. Shared team ledgers, SSO, usage billing; hosted model gateway (bring-your-own-key stays free).
4. JetBrains/Eclipse plugins on top of the MCP server.

## Legal
Original implementation built from publicly described capabilities of tools in this space. No code, branding, or UI from
any other product is used. REA is MIT-licensed; its optional native backends (IDA, Hopper, JEB) need their own licenses.
Datasheets are fetched from vendors at the user's request and cached locally only.
