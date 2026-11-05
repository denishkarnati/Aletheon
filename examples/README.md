# Worked examples

Each folder is a small firmware workspace that Aletheon's tools were run against, using real vendor files. The transcript in each
folder is generated, not written by hand: every output block is the actual return value of the tool named above it.

| Example | Board | What it shows |
|---|---|---|
| [rp2040-uart-driver](rp2040-uart-driver/TRANSCRIPT.md) | Raspberry Pi Pico | The full driver workflow: SVD lookup, SVD-vs-datasheet cross-check, datasheet search (including a miss and a refined query), three generated headers, a driver ([src/uart0.c](rp2040-uart-driver/src/uart0.c)) cross-compiled for Cortex-M0+, and three claim audits (correct, laundered, uncited) |
| [stm32f401-gpio-header](stm32f401-gpio-header/TRANSCRIPT.md) | Nucleo-F401RE | Trust classes: a community-mirror SVD is flagged weak; a voltage claim is refused when the cited passage lacks the value, then accepted with the right passage |
| [nrf52840-uarte-header](nrf52840-uarte-header/TRANSCRIPT.md) | nRF52840 DK | A sparse 34-register peripheral; every reserved gap is proven by a compile-time layout assert |
| [esp32s3-gpio-header](esp32s3-gpio-header/TRANSCRIPT.md) | ESP32-S3-DevKitC-1 | A 397-register peripheral from Espressif's SVD, compiled clean |

## Reproduce

```bash
npm install
pip install ziglang        # C compiler used for check_header and the Cortex-M0+ cross-compile (or have gcc/clang on PATH)
npm run examples           # all examples, a few minutes the first time (downloads the SVDs and datasheets)
npm run examples -- rp2040 # one example
```

The runner is [scripts/run-examples.ts](../scripts/run-examples.ts). It calls the same tool layer the VS Code extension and the MCP
server use, auto-approves file writes (the extension asks you instead) and calls no AI model, so the run is deterministic apart from
timestamps.

## What is in each folder

| Path | Committed | Contents |
|---|---|---|
| `TRANSCRIPT.md` | yes | Step-by-step tool calls and their real output. Datasheet passages are clipped to short quotes |
| `evidence.json` | yes | The evidence ledger from the run: id, kind, source URL, trust class, SHA-256 of the source file, timestamp |
| `src/` | yes | Hand-written code that uses the generated headers (RP2040 example only) |
| `include/gen/` | no (gitignored) | Generated register headers. They contain vendor description text, so they are regenerated rather than committed |
| `.aletheon/` | no (gitignored) | Downloaded vendor files, parsed register maps, the full ledger |

## What these examples do not show

No board was attached, so nothing here was flashed and no serial output was captured. The RP2040 driver compiles for the right CPU
with `-Wall -Wextra -Werror`, but whether it sends bytes on a real Pico is **not yet measured**. If you have a Pico, see
[docs/HANDBOOK.md](../docs/HANDBOOK.md#7-hardware-in-the-loop-adding-measured-evidence) for how to add that evidence.
