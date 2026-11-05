# Add a device model

A device model is a register-level description of one part, written from its datasheet, that the Device Lab can run your I2C code against.
Every register, address and formula in it carries a short quote and a page number, and a script checks each quote against the PDF.

**Rules that keep this legal and honest**

- You download the datasheet from the vendor yourself. PDFs are never added to this repo or hosted on the site.
- Write the model in your own words. Keep a quote only as evidence: **15 words or fewer**, copied from the cited page. The verifier rejects longer ones.
- Say what you leave out. Anything the model does not do goes in `notModeled`.
- A fact that is your own inference (for example a time derived from two numbers) is marked `"derived": true`.

## 1. Read the datasheet and collect facts

For each part you need: the I2C address options, every register you will model (address, name, access, reset value), the scaling of the
result registers (LSB size, formulas), the flags that clear on read, and at least one worked example from the datasheet to test against.
Write down the page number of each. Page numbers are the PDF's own page index, starting at 1.

## 2. Write `site/tools/devices/<id>.json`

Copy an existing file (`tmp117.json` is the simplest) and change it. The fields:

| Field                                         | Meaning                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`, `part`, `kind`, `vendor`, `summary`     | Names and a one-sentence description in your own words                                                     |
| `source`                                      | `doc` (document number), `rev`, `url` (the vendor's own copy), `sha256` and `bytes` of the PDF you used, `pages` |
| `bus`                                         | `"i2c"`                                                                                                    |
| `addresses`                                   | `{ strap, addr, bin? }` for each pin-strapping option, plus `addressCite`                                  |
| `registers`                                   | `{ addr, name, access: "R" or "R/W", reset, cite }` with `addr` like `0x0F` and `reset` like `0x0117`      |
| `facts`                                       | `{ id, text, cite, derived? }`: each behavior the simulator implements                                     |
| `notModeled`                                  | A list of things the model does not do                                                                     |
| `inputs`                                      | The physical quantities the user can set (`id`, `label`, `unit`, `min`, `max`, `step`, `default`)          |
| `sample`                                      | A short program that runs without error and prints something useful                                        |

A citation is `{ "p": 26, "q": "one quote" }` or `{ "p": 26, "all": ["short string", "another"] }`. Use `all` for tables: each string is checked
separately and each must be 15 words or fewer. Extra tables a model needs (for example `pga` or `cycleTable`) sit beside these fields.

Get the SHA-256 and size of your PDF with `node -e "const b=require('fs').readFileSync('ds.pdf');console.log(require('crypto').createHash('sha256').update(b).digest('hex'),b.length)"`.

## 3. Teach the simulator the behavior

Registers that only store values need nothing more. Behavior (a computed result, a flag that clears on read, a conversion that takes time)
lives in `site/assets/devicecore.js`: add a `make<Part>` function next to `makeTMP117` and register it in `FACTORY`. Use the constants from your JSON
(reset values, tables) rather than repeating numbers, and keep the file free of anything outside the `__aletheonDevCore` function: it is copied
into a Worker as text.

## 4. Verify, build, test

Put your PDF at `<some folder>/<id>/ds.pdf`, then from the project root:

```bash
node site/tools/verify-devices.mjs <some folder>   # every quote must be on its cited page; hash and size must match
node site/tools/build-devices.mjs                  # bundles the JSON into site/assets/devices-data.js
```

Add known-answer tests to `site/tools/test-devices.mjs`. Prefer values printed in the datasheet (a worked example, a code table) over values
you computed yourself. Then refresh the home-page numbers and run everything:

```bash
node site/tools/make-site-stats.mjs
node site/tools/test-devices.mjs
node site/tools/test-parts-data.mjs
```

If the part is in the Parts catalog, its "Simulate" button appears automatically: the catalog links a part to a model when the part name
starts with the model's `part`.

## 5. Open a pull request

Include the datasheet's document number and revision, which pages you used, and what you chose not to model.
