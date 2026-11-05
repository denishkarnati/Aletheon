# Contributing to Aletheon

Thank you. The most valuable contributions are **data and tests**, and you do not need to write TypeScript for them.

## Easiest ways to help
- **Failure report**: use the *Failure report* issue form. Attach the ledger (**Aletheon: Show Evidence Ledger** → copy) so we can reproduce it.
- **Add benchmark cases** (`bench/grounding.ts`): questions whose ground truth comes from a vendor file, for more vendors and failure modes.
- **Add or fix a board** (`src/core/boards.ts`): toolchain ids, baud, vendor document links and an SVD/CMSIS-Pack link. Prefer the vendor's own URL; mark
  nothing "official" by hand, trust classes are derived from the host.
- **Docs and translations.**

## Development
```bash
npm install
npm run typecheck && npm run build
npm run test:unit         # offline unit tests, about 1 s: run these constantly
npm test                  # unit + net guard, embeddings plumbing, audit, grounding bench (needs network)
npm run test:headers      # generates and checks headers for ~200 peripherals (needs network; see scripts/compile-headers.sh for compiling them)
npm run examples          # regenerates the worked examples in examples/ (needs a C compiler: gcc/clang or `pip install ziglang`)
npm run evidence          # runs everything and regenerates evidence/REPORT.md with raw logs
```
The [handbook](docs/HANDBOOK.md#8-working-on-aletheon) has the repo map, every test suite, and step-by-step guides for adding a board,
a tool, an example or a benchmark case.
Node 20+ (22 recommended). Python with Pillow only if you regenerate brand assets (`site/tools/make_assets.py`).

## Ground rules
1. **Sign your commits** (Developer Certificate of Origin): `git commit -s`. By doing so you certify you wrote the change or have the right to submit it
   under Apache-2.0 (https://developercertificate.org/). Unsigned commits cannot be merged.
2. **Clean room.** Do not copy code, prompts, tool descriptions or documentation text from proprietary products, and do not contribute anything
   learned by decompiling or scraping them or by breaching their terms. Describe behavior in your own words and implement it yourself.
3. **No vendor documents in the repo.** Do not commit datasheets, SVDs or packs. We link to them and fetch them on the user's machine.
4. **Claims need evidence.** If a change adds a capability, add a test or a measurement. If a claim in the README or site is not yet measured, say so.
5. **Safety defaults stay safe.** Anything that writes, flashes, runs external code or fetches a model-chosen URL needs approval or a guard, plus a test.
6. Keep PRs small and focused. Run `npm run typecheck` and the tests before pushing.

## Reporting security issues
Not here: see `SECURITY.md`.
