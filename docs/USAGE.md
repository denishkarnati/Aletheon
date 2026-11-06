# Using Aletheon

Aletheon is a firmware assistant that has to show its evidence. This guide covers install, first run, five workflows, configuration and
troubleshooting. Status: **alpha**. Register-map tooling is tested against real vendor files; it has not been run on real boards yet.

## 1. Install

### VS Code and compatible editors
1. Download `aletheon-<version>.vsix` from the repository's Releases page.
2. `code --install-extension aletheon-<version>.vsix` (or *Extensions: Install from VSIX…*). Requires VS Code 1.90+.
3. Run **Aletheon: Set AI Provider API Key**. Keys are kept in the editor's secret storage.
4. Click the status-bar board name (bottom left) and pick your target. Open the **Aletheon** view in the activity bar.

### Any MCP client
```bash
git clone https://github.com/denishkarnati/aletheon
cd aletheon && npm install && npm run build
```
Register `node /path/to/aletheon/dist/mcp.js` as a stdio MCP server with these environment variables. In OpenAI Codex (CLI or IDE extension) add it to
`~/.codex/config.toml`:
```toml
[mcp_servers.aletheon]
command = "node"
args = ["/path/to/aletheon/dist/mcp.js"]
env = { ALETHEON_ROOT = "/path/to/your/firmware", ALETHEON_BOARD = "rpi-pico" }
```
(Claude Code: `claude mcp add aletheon -- node /path/to/aletheon/dist/mcp.js`.) The server speaks MCP over stdio and has been driven end to end by the
test suite with a scripted client; it has not yet been tried inside Codex itself. In an MCP client, the model that writes the code is the client's own.
The environment variables are:

| Variable | Meaning |
|---|---|
| `ALETHEON_ROOT` | Your firmware project folder. The ledger and caches go in `ALETHEON_ROOT/.aletheon/`. Default: current directory |
| `ALETHEON_BOARD` | Board id (`rpi-pico`, `esp32-s3-devkitc-1`, `esp32-devkitc`, `nucleo-f401re`, `nrf52840-dk`, `arduino-uno`) |
| `ALETHEON_ALLOW_WRITE` | `1` lets `write_file`, `generate_regs_header` and `flash` proceed. Default: denied |
| `ALETHEON_EMBED` | Semantic search backend: `auto` (default), `off`, `ollama`, `openai-compatible`, `local` |
| `ALETHEON_EMBED_MODEL`, `_URL`, `_KEY` | Optional model, endpoint and key for the embedding backend |
| `ALETHEON_ALLOW_PRIVATE_URLS` | `1` allows fetching documents from private/internal addresses (default: blocked) |

### Other things you need
A toolchain for your board: PlatformIO (`pio`), `arduino-cli`, or ESP-IDF (`idf.py`). Serial capture needs Python with `pyserial`.
`check_header` uses the first of `gcc`, `clang`, `cc`, `zig cc` or `python -m ziglang cc` that it finds.

## 2. Five workflows

### A. Ask a register question and get proof
> "What is the address, reset value and BUSY bit of UART0's UARTFR on the Pico? Cite evidence."

The assistant indexes the register map if needed (`index_svd`), calls `lookup_register`, and answers with `[E#]` citations. Open
**Aletheon: Show Evidence Ledger** to see each entry's source, trust class and file hash.

### B. Bring up a peripheral driver
Run **Aletheon: Generate Driver (SVD-grounded)**, give a peripheral name (for example `UART0`) and a goal. The assistant:
1. indexes the register map and searches the datasheet for the init sequence, clocks, reset and pin-mux;
2. generates `include/gen/<peripheral>_regs.h` (base, offsets, field masks, struct view, layout asserts);
3. compiles the header with `check_header`;
4. writes the driver using only macros from that header, and builds it with your toolchain;
5. flashes and captures serial output only if you approve.

It reports which steps were actually done. A driver that compiles has not been shown to work until serial or other real output says so.

### C. Audit any answer
Paste text into a chat with the `audit_claims` tool available (MCP name: `ground_check`). Each sentence with a hardware value (hex address,
voltage, current, frequency, timing, pin) needs an `[E#]` whose excerpt contains that value. You get a list of unsupported, uncited and
unknown-citation claims, and a note for claims that rest only on community-mirror sources.

### C2. Start from a part number (sensor / I2C drivers)
> "Write a driver for a TMP117 on my board. What is its I2C address and how do I read the temperature?"

The assistant calls `find_datasheet` (part number to the datasheet link), `index_datasheet` and `search_datasheets` to cite the address and register
passages, then `device_model` and `simulate_i2c` to check its planned sequence (address, register pointer, configuration word, result decoding)
against a datasheet-checked model before it tells you the driver is right. Modeled parts today: TMP117, INA219, INA226, ADS1115. For any other part
the simulator is not available and the assistant must cite the indexed datasheet or say `UNVERIFIED`. A simulation shows the sequence matches the
documented behaviour; it is not proof that the code works on a board. Only build, flash and serial capture show that.
`find_datasheet` fetches the website's parts catalog once (cached for 7 days in `.aletheon/cache`); set `ALETHEON_PARTS_URL` to use another https copy.

### D. Check a register map against a datasheet
Index both, then call `cross_check_register` with a peripheral and register. Verdicts: **agree**, **conflict**, **name-only**, **not-found**.
A conflict means "look at both sources", not "the datasheet is right". This is a heuristic tuned on one datasheet layout.

### E. Score any assistant
```bash
npm run bench:grounding -- --list           # prints 20 questions (ground truth is computed from the RP2040 SVD)
# ask them to any assistant you are allowed to test, then save replies:
#   [{ "id": "addr-UART0-UARTFR", "answer": "...", "ledger": [ {id,kind,source,excerpt,trust} ] }]
npm run bench:grounding -- answers.json
```
`ledger` is optional. Without it a correct address scores `pass-unaudited`; with it, citations are checked too.

## 3. VS Code commands
| Command | Purpose |
|---|---|
| Select Target Board / Detect Connected Boards | Pick the board; list attached boards and serial ports |
| Index Datasheet / Index Register Map (SVD / CMSIS-Pack) | Add documents; the board's default SVD is offered |
| Build Semantic Index for Indexed Datasheets | Embed passages for semantic search |
| Generate Driver (SVD-grounded) | Workflow B |
| Verify Board Documentation Links | Check that registry URLs still resolve |
| Show Evidence Ledger / New Conversation / Set API Key | Utilities |

Settings: `aletheon.provider` (`anthropic` or `openai-compatible`), `aletheon.model`, `aletheon.baseUrl` (for Ollama, OpenRouter and similar),
`aletheon.toolchain`, `aletheon.embeddings.provider|model|baseUrl`.

## 4. What it will and will not do on its own
Reads and searches run freely. **Writing files, generating headers, flashing a board and running REA ask for your approval first.**
Builds run your project's own build scripts, so open only projects you trust. Document text is untrusted input: see `SECURITY.md`.

## 5. Troubleshooting
| Symptom | Likely cause |
|---|---|
| "No API key set" | Run *Set AI Provider API Key*, or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `search mode: keyword` | No embedding backend. Start Ollama with `nomic-embed-text`, or configure `aletheon.embeddings.*` |
| `No host C compiler found` | Install gcc/clang, or `pip install ziglang` |
| `blocked private address` | The document URL points at an internal host. Set `ALETHEON_ALLOW_PRIVATE_URLS=1` if intended |
| ST or Nordic document links return 403 | Download the file and index it by path |
| Everything is `[E…]` with `community-mirror` | The register map came from a third-party mirror. Prefer the vendor's CMSIS pack |

## 6. Where your data lives
`<project>/.aletheon/` holds `ledger.json`, indexed documents (`docs/`), vectors (`*.emb`) and parsed register maps (`svd/`).
Delete the folder to reset. Add it to `.gitignore` unless you want to share a ledger; it can contain text from licensed datasheets.
