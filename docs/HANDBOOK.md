# The Aletheon Handbook

How to use Aletheon, how to read what it gives you, and how to work on it. For a quick install and settings reference, see
[USAGE.md](USAGE.md). For architecture and measurement details, see [ENGINEERING.md](ENGINEERING.md). For known bottlenecks and
the plan to a production release, see [PRODUCT_READINESS.md](PRODUCT_READINESS.md).

**Contents**

1. [What Aletheon is](#1-what-aletheon-is)
2. [Install and first run](#2-install-and-first-run)
3. [Core ideas: evidence, trust, audit](#3-core-ideas-evidence-trust-audit)
4. [Workflows by role](#4-workflows-by-role)
5. [Reading the evidence](#5-reading-the-evidence)
6. [Tool reference](#6-tool-reference)
7. [Hardware in the loop: adding measured evidence](#7-hardware-in-the-loop-adding-measured-evidence)
8. [Working on Aletheon](#8-working-on-aletheon)
9. [Roadmap](#9-roadmap)
10. [Glossary](#10-glossary)

---

## 1. What Aletheon is

Aletheon is a firmware assistant for VS Code and for any agent that speaks MCP (Model Context Protocol). The problem it solves:
AI models state register addresses, bit positions, voltages and timings from memory, and a wrong address does not raise an error.
It writes to the wrong place.

Aletheon makes **evidence** the product:

```
   vendor files                         tools                              you
 ┌──────────────┐    index_svd       ┌───────────────┐   [E3] UARTFR @   ┌──────────────────────┐
 │ CMSIS-SVD    │ ─────────────────▶ │ evidence      │   0x40034018      │ answer with [E#]     │
 │ datasheet PDF│  index_datasheet   │ ledger        │ ────────────────▶ │ citations, audited   │
 │ build output │  build / flash     │ (id, source,  │                   │ before you see it    │
 │ serial bytes │  serial_capture    │  trust, hash) │                   └──────────────────────┘
 └──────────────┘                    └───────────────┘
```

1. Every tool result is stored as a numbered evidence entry (`[E1]`, `[E2]` …) with its source, a **trust class**, and the SHA-256 of
   the exact file it came from.
2. Register addresses, offsets, reset values and bit fields come from the vendor's **CMSIS-SVD** register map, never from model memory.
3. Every hardware value in an answer must cite an entry whose text **contains that value**. `audit_claims` checks this and flags
   anything uncited, unsupported or cited with an invented id.
4. If the evidence is missing, the honest answer is `UNVERIFIED`, and that counts as a pass, not a failure.

The tools work with or without an AI model. Everything in [examples/](../examples/) was produced by calling the tools directly, with
no model involved.

## 2. Install and first run

### 2.1 What you need

| Need | For | Install |
|---|---|---|
| Node.js 20+ (22 recommended) | everything | nodejs.org |
| A C compiler | `check_header` (compile-checks generated headers) | gcc/clang on PATH, or `pip install ziglang` |
| A board toolchain | `build`, `flash` | PlatformIO (`pip install platformio`), `arduino-cli`, or ESP-IDF |
| Python + `pyserial` | `serial_capture`, `detect_boards` fallback | `pip install pyserial` |
| An AI provider key | the chat agent only | Anthropic, any OpenAI-compatible endpoint, or local Ollama |

### 2.2 VS Code

1. Install the `.vsix` from the Releases page: `code --install-extension aletheon-<version>.vsix`.
2. Run **Aletheon: Set AI Provider API Key**.
3. Click the board name in the status bar and pick your board.
4. Open the **Aletheon** view in the activity bar and ask a question.

### 2.3 Any MCP client (Claude Code, Cursor, Codex, Gemini CLI …)

```bash
git clone <this repository> aletheon && cd aletheon
npm install && npm run build
```

```json
{ "mcpServers": { "aletheon": {
    "command": "node", "args": ["/path/to/aletheon/dist/mcp.js"],
    "env": { "ALETHEON_ROOT": "/path/to/your/firmware", "ALETHEON_BOARD": "rpi-pico" } } } }
```

Writes and flashing are denied over MCP unless you set `ALETHEON_ALLOW_WRITE=1`. All variables are listed in [USAGE.md](USAGE.md#any-mcp-client).

### 2.4 Your first five minutes (no AI key needed)

```bash
npm install && npm run build
pip install ziglang
npm run examples -- rp2040
```

Then open [examples/rp2040-uart-driver/TRANSCRIPT.md](../examples/rp2040-uart-driver/TRANSCRIPT.md). It walks through what the agent does
during a driver bring-up, with the real output of every step.

## 3. Core ideas: evidence, trust, audit

### 3.1 Evidence entries

Each entry in `<project>/.aletheon/ledger.json` looks like this (a real entry from the RP2040 example):

```json
{
  "id": "E1",
  "kind": "svd",
  "source": "https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/rp2040/hardware_regs/RP2040.svd",
  "excerpt": "Parsed RP2040: 37 peripherals, 1181 registers",
  "ts": "2026-10-26T21:00:26.686Z",
  "trust": "vendor-official",
  "sha256": "1c72330127ae097c8c9a3661b509fcb9a94826d76a5c0d7e259eb605ddd7b0a6"
}
```

Ids exist only once a tool has returned them. An answer that cites `[E99]` when there is no E99 is caught as `unknown-citation`.

### 3.2 Trust classes

| Class | Meaning | Example |
|---|---|---|
| `measured` | Produced on your machine or board just now | build output, flash log, serial capture |
| `vendor-official` | Fetched from an allow-listed vendor domain or GitHub org | `datasheets.raspberrypi.com`, `github.com/espressif` |
| `derived` | Computed by Aletheon from other evidence | generated header, cross-check verdict, REA output |
| `user-supplied` | A file from your workspace | a PDF you downloaded yourself |
| `community-mirror` | Any other source | `cmsis-svd-data`, forum posts |

Vendor status comes from an allow-list, never from what a page says about itself. A lookalike host such as
`espressif.com.evil.example` is `community-mirror`. Claims that rest only on community sources pass the audit but are marked **weak**.

### 3.3 Claim audit verdicts

| Verdict | Meaning | What to do |
|---|---|---|
| `supported` | The cited entry contains the value (after normalising `0x040034018u` → `0x40034018`, `3.30V` → `3.3 V` …) | nothing |
| `unsupported` | The citation is real but its text does not contain the value. This catches **citation laundering** | find evidence that states it, or mark it UNVERIFIED |
| `uncited` | A hardware value with no `[E#]` | add a citation |
| `unknown-citation` | An `[E#]` that is not in the ledger | the id was invented |
| `declared-unverified` | The sentence says UNVERIFIED | honest. Counts as a pass |

Values checked: hex numbers (addresses, masks, reset values); quantities in V, mA, µA, MHz, kHz, GHz, ns, µs, ms, baud, kB, MB and
ksps; and pins written as `GPIO5` or `PA5`. Code blocks are not audited.

### 3.4 Cross-check verdicts (SVD vs datasheet)

`agree`: the datasheet lists the register with the SVD's offset or address. `conflict`: it lists a different one. Look at both
sources, because the datasheet is not automatically right. `name-only`: the register is named but no address is found nearby.
`not-found`: not in the indexed text. This is a heuristic tuned on the RP2040 layout (87 of 91 real registers agree).

### 3.5 Search modes

`search_datasheets` says which mode it ran in. **Keyword** mode needs exact terms: `UARTIBRD`, `LCR_H`. Paraphrases often miss it,
measured at hit@1 4/12 on paraphrased questions. **Hybrid** mode adds an embedding model (Ollama `nomic-embed-text`, an
OpenAI-compatible endpoint, or local MiniLM) and fuses both rankings. If a search misses, rephrase with the datasheet's own
vocabulary. The RP2040 example shows exactly that (steps 8 and 9).

## 4. Workflows by role

### 4.1 Firmware and IoT engineers

**Ask a register question with proof.**
> "Address, reset value and BUSY bit of UART0 UARTFR on the Pico? Cite evidence."

The agent runs `index_svd`, then `lookup_register`, then `cross_check_register`, answers with `[E#]` citations, and audits its own
answer before you see it.

**Bring up a peripheral driver.** Run *Aletheon: Generate Driver (SVD-grounded)*, or ask in chat. The agent follows this sequence and
reports which steps it actually completed:

| Step | Tool | Evidence produced |
|---|---|---|
| 1. Register map | `index_svd` | vendor-official, hashed |
| 2. Init sequence, clocks, reset, pin-mux, errata | `search_datasheets` | page-cited passages |
| 3. Header | `generate_regs_header` | derived; you approve the write |
| 4. Header compiles, layout proven | `check_header` | measured |
| 5. Driver using only header macros | `write_file` | you approve the write |
| 6. Real compiler output | `build` | measured |
| 7. Behaviour on the board | `flash`, then `serial_capture` | measured; you approve flashing |

A driver that compiles has **not** been shown to work. Only step 7 shows that. The full worked run is
[examples/rp2040-uart-driver](../examples/rp2040-uart-driver/TRANSCRIPT.md), and its driver is
[src/uart0.c](../examples/rp2040-uart-driver/src/uart0.c).

**Supported boards today:** Raspberry Pi Pico (RP2040), ESP32-S3-DevKitC-1, ESP32-DevKitC, STM32 Nucleo-F401RE, nRF52840 DK and
Arduino Uno (no SVD). For any other Cortex-M or RISC-V part, index its SVD or CMSIS pack by URL or path. Lookup, headers and audit
work without a registry entry. Only `build` and `flash` need the board in [src/core/boards.ts](../src/core/boards.ts).

### 4.2 Hardware and board engineers

- **Electrical values with sources.** Index the datasheet and ask for supply ranges, absolute maximums, pad drive or timing. The audit
  refuses a value unless the cited passage contains it. [examples/stm32f401-gpio-header](../examples/stm32f401-gpio-header/TRANSCRIPT.md)
  shows a refusal (the top search hit was the right table, but its excerpt did not contain "1.7 V") and then the accepted version.
- **Pin claims need evidence too.** "UART0 TX is on GPIO 0 [E1]" fails if E1 does not say so.
- **Register map vs document.** `cross_check_register` surfaces disagreements between the SVD and the PDF instead of silently picking one.
- **Not yet:** schematic or netlist checks (KiCad), and logic-analyzer captures as evidence. Both are on the [roadmap](#9-roadmap).

### 4.3 ASIC, SoC and VLSI engineers

What works today:

- **Your own IP's register map.** If your flow can export CMSIS-SVD, index the file by path (`index_svd` with
  `source: "regs/my_ip.svd"`). You get exact lookups, C headers with compile-time layout asserts for the firmware and DV teams, and
  audited answers about your own design. Files in your workspace are classed `user-supplied`.
- **Spec vs register map.** Index your spec PDF and run `cross_check_register` on registers to find places where the document and the
  machine-readable map disagree.
- **Header proof.** Every generated struct has an `offsetof` assert per register, so a reordered or resized register fails to compile
  instead of silently shifting every later register.

What does not work yet: SystemRDL and IP-XACT input, UVM register-model output, SystemVerilog register blocks, and RTL vs spec
checking. These are the first roadmap items for this audience.

### 4.4 Evaluating any AI assistant

```bash
npm run bench:grounding -- --list        # 20 questions with ground truth from the vendor SVD
npm run bench:grounding -- answers.json  # score the replies
```

The questions include 6 fabricated registers and 4 peripherals the chip does not have. A grounded assistant should say
`UNVERIFIED` or "does not exist" for those. Only the scorer has been self-tested so far. No real model has been scored yet, and
results from real models are a welcome contribution.

## 5. Reading the evidence

The repository ships three kinds of evidence. Each one can be checked independently.

| What | Where | How to check it |
|---|---|---|
| Test results | [evidence/REPORT.md](../evidence/REPORT.md) and raw logs in [evidence/logs/](../evidence/logs/) | run `npm run evidence` and compare. Each log's SHA-256 is in the report |
| Worked examples | [examples/*/TRANSCRIPT.md](../examples/) and `evidence.json` | run `npm run examples` |
| Source files used | `source` and `sha256` in each `evidence.json` entry | download the file and hash it (below) |

**Check a source hash yourself:**

```bash
curl -sL https://raw.githubusercontent.com/raspberrypi/pico-sdk/master/src/rp2040/hardware_regs/RP2040.svd | sha256sum
# 1c72330127ae097c8c9a3661b509fcb9a94826d76a5c0d7e259eb605ddd7b0a6  (matches E1 in examples/rp2040-uart-driver/evidence.json)
```

If a vendor updates a file, the hash changes. That is intended: the ledger records exactly which version an answer was based on.

**Where the numbers in the README come from:**

| README claim | Log |
|---|---|
| 210 / 210 headers compile clean (C11 and C++17) | `evidence/logs/headers-compile.log` |
| 210 peripherals, 8,264 registers, 27,904 fields, 0 layout failures | `evidence/logs/headers.log` |
| Cross-check: 87 agree / 1 conflict / 1 name-only / 2 not-found; 0 agree when tampered | `evidence/logs/audit.log` |
| Retrieval: hit@1 4/12, hit@5 7/12, MRR 0.419 (keyword only) | `evidence/logs/retrieval.log` |
| Scorer separates grounded from hallucinated, laundered and uncited answers | `evidence/logs/grounding.log` |

## 6. Tool reference

| Tool | Does | Asks first | Evidence kind |
|---|---|---|---|
| `list_boards` | Lists the board registry and the current selection | | |
| `detect_boards` | Finds boards and serial ports that are physically connected | | serial (measured) |
| `index_datasheet` | Downloads or reads a PDF/HTML file and indexes it with page numbers | | datasheet |
| `search_datasheets` | Returns ~900-character passages with page numbers | | datasheet |
| `index_svd` | Parses an SVD, or the SVD inside a CMSIS `.pack`/`.zip` | | svd |
| `lookup_register` | Address, reset value, access and bit fields from the SVD | | svd |
| `cross_check_register` | SVD vs datasheet: agree / conflict / name-only / not-found | | svd + datasheet |
| `generate_regs_header` | C header: macros, enums, struct view, layout asserts | **yes** | svd (derived) |
| `check_header` | Compiles a header with the host compiler | | build (measured) |
| `audit_claims` | Audits a draft answer (MCP name: `ground_check`) | | |
| `list_dir`, `read_file` | Workspace access, confined to the project folder | | |
| `write_file` | Writes a workspace file | **yes** | |
| `build` | Builds with PlatformIO, arduino-cli or ESP-IDF | | build (measured) |
| `flash` | Flashes the board | **yes** | flash (measured) |
| `serial_capture` | Reads serial output for N seconds (max 60) | | serial (measured) |
| `rea_run` | Runs the pinned REA reverse-engineering CLI | **yes** | rea (derived) |
| `show_ledger` (MCP only) | Returns the whole ledger | | |

Safety guards: workspace paths cannot escape the project folder. Arguments passed to toolchains are checked against a strict
character set (on Windows `%` is rejected too, because `cmd.exe` expands it). Document downloads refuse private, link-local and
cloud-metadata addresses and re-check every redirect. See [SECURITY.md](../SECURITY.md).

## 7. Hardware in the loop: adding measured evidence

Nothing in this repository has been run on a real board yet. This is the most valuable gap to close. If you have a supported board:

1. Create a PlatformIO project for it (`pio project init --board pico`), or use `arduino-cli`/ESP-IDF.
2. Open it in VS Code with Aletheon, select the board, and ask for a small driver, for example *"bring up UART0 at 115200 and print
   hello every second"*. Or copy [examples/rp2040-uart-driver/src/uart0.c](../examples/rp2040-uart-driver/src/uart0.c) together with its
   generated headers.
3. Let it `build`, approve `flash`, then `serial_capture` on the board's port.
4. Open **Aletheon: Show Evidence Ledger**. The `flash` and `serial` entries are `measured` evidence.
5. Contribute it: open a *Failure report* or pull request with the ledger, the board, toolchain versions and what you saw. Failures
   are as valuable as successes.

When reporting, include what was **not** checked (for example "TX only, RX not tested"). Do not upgrade a claim beyond the evidence.

## 8. Working on Aletheon

### 8.1 Repository map

```
src/core/          shared logic, no VS Code dependency
  agent.ts         agent loop + grounding rules (system prompt)
  tools.ts         every tool: schema + implementation
  svd.ts           CMSIS-SVD parser, CMSIS-Pack (zip) reader, register store
  driver.ts        SVD -> C header generator
  audit.ts         claim audit + SVD/datasheet cross-check
  evidence.ts      ledger;  provenance.ts  trust classes + hashing
  docs.ts          datasheet index + hybrid search;  embeddings.ts  embedding backends
  net.ts           SSRF-guarded fetch;  proc.ts  safe process runner;  providers.ts  Anthropic / OpenAI-compatible
  boards.ts        board registry
src/extension/     VS Code UI (commands, chat view)
src/mcp/server.ts  MCP stdio server
test/              test suites (see 8.3)
bench/             grounding benchmark
scripts/           run-examples.ts, evidence-report.mjs, compile-headers.sh, set-owner.mjs
examples/          worked examples (generated transcripts)
evidence/          generated test-evidence report and raw logs
docs/              USAGE, ENGINEERING, this handbook
site/              project website (GitHub Pages)
```

### 8.2 Development loop

```bash
npm install
npm run typecheck && npm run build
npm run test:unit          # offline, about 1 s. Run it constantly
npm test                   # unit + net + embeddings + audit + grounding (needs network)
npm run test:headers       # headers for all 210 peripherals of 4 real SVDs
npm run examples           # regenerate the worked examples
npm run evidence           # full run, regenerates evidence/REPORT.md
```

To try the extension, open the folder in VS Code and press F5. To try MCP:
`ALETHEON_ROOT=<project> ALETHEON_BOARD=rpi-pico node dist/mcp.js`.

### 8.3 Test suites

| Suite | File | Network | Covers |
|---|---|---|---|
| unit | `test/unit.test.ts` | no | SVD parsing (derivedFrom, dim, clusters, field formats, enums), pack reader, header generator, `safeArg`, retry backoff |
| net | `test/net.test.ts` | resolves DNS | SSRF guard |
| embeddings | `test/embeddings.test.ts` | no | chunking, persistence, invalidation, fusion, fallback |
| audit | `test/audit.test.ts` | yes | trust classes, audit with forged evidence, cross-check on real RP2040 files |
| grounding | `bench/grounding.ts` | yes | benchmark scorer self-test |
| headers | `test/headers.test.ts` | yes | every peripheral of 4 SVDs: macros, simulated layout, known answers |
| retrieval | `test/retrieval.bench.ts` | yes | search quality (a measurement) |

Tests are plain TypeScript scripts that print `PASS`/`FAIL` lines and exit non-zero on failure. There is no framework to learn.
Copy the `check()` helper from an existing suite.

### 8.4 Common contributions, step by step

**Add a board.** Add an entry to `BOARDS` in [src/core/boards.ts](../src/core/boards.ts) with id, MCU, architecture, toolchains,
PlatformIO board id or FQBN, baud rate, vendor document URLs and an SVD URL (prefer the vendor's own). Do not set trust by hand.
Then run `npm run test:unit` and **Verify Board Documentation Links** in VS Code. If you can, add an example to
`scripts/run-examples.ts`.

**Add a tool.** Add an object to `TOOLS` in [src/core/tools.ts](../src/core/tools.ts): `name`, `description` (the model reads it, so
say when to use it and what it must not be used for), `input_schema`, and `run`. Record results with `ctx.ledger.add(...)` and return the
`[E#]` id. Anything that writes, flashes, executes external code or fetches a URL the model chose must call `ctx.host.confirm` or go
through `net.ts`. It is then available in VS Code and over MCP automatically.

**Add an example.** Add an entry to `EXAMPLES` in [scripts/run-examples.ts](../scripts/run-examples.ts), run `npm run examples -- <name>`,
read the transcript, and fix anything that is not true. Step notes are the only hand-written text: they must describe what the
output actually shows, including misses.

**Add a benchmark case.** See `bench/grounding.ts`. Ground truth must come from a vendor file, never from memory.

### 8.5 Evidence rules for contributors

1. **Claims need evidence.** A new capability needs a test or a measurement. A number in the README needs a log.
2. **Say what was not checked.** Every example and README section has a "not covered" note. Keep it accurate.
3. **No vendor documents in the repo.** Link to them. Generated headers are gitignored for this reason. Transcripts keep only short quotes.
4. **Safe defaults stay safe.** Approval or a guard for anything with side effects, plus a test.
5. **Clean room.** Do not copy code, prompts or docs from proprietary products. See [CONTRIBUTING.md](../CONTRIBUTING.md).
6. **Sign your commits** (`git commit -s`, DCO).

### 8.6 Pull request checklist

- [ ] `npm run typecheck` and `npm run test:unit` pass
- [ ] `npm test` passes, or you say which suite you could not run and why
- [ ] New behaviour has a test. New claims have a log or example
- [ ] Side-effecting changes ask first or are guarded
- [ ] Docs updated (this handbook, USAGE, README) if behaviour changed

### 8.7 Releasing

1. Update the version in `package.json` and `src/mcp/server.ts` (`serverInfo.version`), and add a `CHANGELOG.md` entry.
2. Run `npm run evidence` and `npm run examples`, then commit the regenerated `evidence/` and `examples/*/TRANSCRIPT.md`.
3. Tag `vX.Y.Z` and push. The release workflow builds the `.vsix` and attaches it to a GitHub Release.

## 9. Roadmap

Ordered by how much each item closes a gap that real users hit. Engineering bottlenecks (cost, performance, code organization,
release) are tracked separately in [PRODUCT_READINESS.md](PRODUCT_READINESS.md).

| # | Item | For | Status |
|---|---|---|---|
| 1 | Real-board results (flash + serial) for each registry board | everyone | **needs hardware** |
| 2 | A real LLM scored on the grounding benchmark | everyone | needs an API key |
| 3 | Semantic search measured (`BENCH_EMBED=ollama npm run bench:retrieval`) | everyone | not measured |
| 4 | SystemRDL and IP-XACT input | ASIC / VLSI | planned |
| 5 | UVM register model and SystemVerilog register block output | DV / VLSI | planned |
| 6 | Live register reads over OpenOCD / probe-rs / J-Link as `measured` evidence | firmware | planned |
| 7 | More boards: RP2350, ESP32-C3/C6, more STM32 families, Zephyr/devicetree projects | firmware / IoT | planned |
| 8 | Errata documents searched during driver bring-up | firmware | planned |
| 9 | KiCad netlist vs pin-mux checks; sigrok captures as evidence | hardware | planned |
| 10 | AVR register maps from Microchip ATDF files (Arduino Uno) | hobbyist | planned |

## 10. Glossary

| Term | Meaning |
|---|---|
| CMSIS-SVD | Arm's XML format describing a chip's peripherals, registers and bit fields |
| CMSIS-Pack | A zip (`.pack`) that vendors ship with device support files, usually including the SVD |
| Evidence entry `[E#]` | One recorded tool result in the ledger |
| Trust class | How much a source deserves to be believed: measured > vendor-official > derived > user-supplied > community-mirror |
| Citation laundering | Citing a real evidence id whose text does not support the claim |
| Layout assert | A compile-time `offsetof` check that a struct member sits at the SVD's register offset |
| MCP | Model Context Protocol: a standard way for AI agents to call external tools |
| UNVERIFIED | The honest answer when evidence is missing. It passes the audit |
