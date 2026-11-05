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
| **SSRF**: a model steered into fetching internal URLs | Document/SVD downloads reject non-http(s), localhost, private, link-local and metadata addresses, and re-check every redirect hop | DNS rebinding between check and connect is not handled. Embedding and model endpoints are user-configured and not filtered |
| **Path escape** | File tools resolve inside the workspace and reject `..` | Symlinks inside the workspace are followed |
| **Arbitrary code via build** | Builds run the project's own scripts (`pio`, `idf.py`, …) | Opening an untrusted project and building it runs its code. Same as any build tool |
| **Remote code via REA** | Pinned `rea-agents` version, approval prompt shows the exact command | The pinned package still executes on your machine once approved |
| **Command injection** | Child processes receive arguments from an allow-listed character set | Windows `.cmd` shims run through the shell; the allow-list is the control |
| **Secrets** | API keys live in the editor's secret storage or environment variables; the ledger stores tool output, not keys | Document text and tool output are sent to your model provider |
| **Supply chain** | Few runtime dependencies (`unpdf`, `fast-xml-parser`); the extension is bundled | Pin and review updates; CI actions should be pinned by SHA before 1.0 |

## What we promise and do not
Aletheon's audit checks that a cited passage contains the value a claim states. It does not prove the model's reasoning is correct or that the
datasheet is right. Do not rely on it alone for safety-critical or regulated work; build, test and measure on real hardware.
