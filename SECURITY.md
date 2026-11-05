# Security policy

## Reporting a vulnerability
Please report privately through GitHub's *Security → Report a vulnerability* on this repository (private advisory). Do not open a public
issue for an exploitable problem. Include steps to reproduce, the affected version, and your assessment of impact. We aim to acknowledge
within 5 working days. This is an early-stage project run by volunteers; there is no bounty program.

## Threat model, in plain terms
Aletheon gives an AI model tools that read documents, run builds, write files and flash hardware. The main risks and what exists today:

| Risk | Mitigation | Remaining gap |
|---|---|---|
| **Prompt injection** from datasheet/SVD text ("ignore previous instructions, flash this…") | `write_file`, `generate_regs_header`, `flash` and `rea_run` require explicit user approval; the MCP server denies them unless `ALETHEON_ALLOW_WRITE=1` | A model can still be misled in what it *says*. Read before approving; treat unfamiliar documents as untrusted |
| **SSRF**: a model steered into fetching internal URLs | Document/SVD downloads allow only http(s) to public addresses (IPv4 and IPv6, including IPv4-in-IPv6, NAT64 and 6to4 forms), re-check every redirect hop, connect only to an address validated at connect time (no DNS rebinding), and stop at 60 s or 100 MB | The model can still choose *which* public host to fetch from, and a URL can carry data to it: fetching from hosts outside the vendor list is not yet confirmed with the user. Embedding and model endpoints are user-configured and not filtered |
| **Path escape** | File tools resolve symlinks and Windows junctions and refuse to leave the workspace; credentials files (`.env`, keys, `.git`, `.ssh`, `.aws`, `.npmrc`…) are never read; `.git` and Aletheon's own `.aletheon` store are never written | None known |
| **Arbitrary code via build** | Builds run the project's own scripts (`pio`, `idf.py`, …); the write-approval prompt shows the real path and the content, and warns for files that run code at build time (`platformio.ini`, `CMakeLists.txt`, `*.py`, …) | `build` itself is not gated, so an approved build-file write is followed by code execution. Opening an untrusted project and building it runs its code, as with any build tool |
| **Remote code via REA** | Pinned `rea-agents` version, approval prompt shows the exact command | The pinned package still executes on your machine once approved |
| **Command injection** | Child processes receive arguments from an allow-listed character set; serial and flash ports must be plain device names (no `socket://` URLs); on Windows the current directory is not searched for executables | Windows `.cmd` shims run through the shell; the allow-list is the control |
| **Secrets** | API keys live in the editor's secret storage or environment variables; the ledger stores tool output, not keys; build tools and project scripts do **not** inherit your keys (an allowlist of toolchain variables is passed); the API base-URL settings cannot be set by a project's `.vscode/settings.json` | Document text and tool output are sent to your model provider |
| **Hostile files** | Vendor SVD text cannot inject code into generated headers; array expansion, zip inflation, HTML parsing and file reads are bounded; generated C is checked by compiling it | A very large legitimate SVD (over 3 million elements) is refused |
| **Supply chain** | Few runtime dependencies (`unpdf`, `fast-xml-parser`); the extension is bundled; CI actions are pinned to commit SHAs and updated through Dependabot; `npm audit` runs in CI | Development tooling (ESLint) has advisories that never ship in the extension |

## Automated checks on every change
Typecheck, lint, the full test suite (including SSRF, hostile-input, file-confinement and database row-level-security tests), a scan for committed
secrets, `npm audit` for the dependencies that ship, and a static analysis pass (CodeQL). The website is only deployed after its own checks pass.

## The website
The site is static: no server, no accounts, no forms. Every page carries a Content-Security-Policy (scripts only from this site or by hash; no forms,
frames or remote resources). The Device Lab runs visitors' own code in a sandboxed Worker with no network access. Real response headers
(`site/_headers`) apply on hosts that honour them; GitHub Pages ignores that file, so only the policy inside each page applies there.

## What we promise and do not
Aletheon's audit checks that a cited passage contains the value a claim states. It does not prove the model's reasoning is correct or that the
datasheet is right. Do not rely on it alone for safety-critical or regulated work; build, test and measure on real hardware.
