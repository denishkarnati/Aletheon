// Register maps: SVD indexing, lookup, SVD-vs-datasheet cross-check, header generation and compile check.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { crossCheckRegister } from '../audit';
import { generateRegsHeader } from '../driver';
import { run, tail } from '../proc';
import { Tool, inRoot, obj, resolveSource, str, writeFile } from './context';

export const registerTools: Tool[] = [
  {
    name: 'index_svd',
    description:
      "Download and parse a CMSIS-SVD register map (.svd URL/path, or a CMSIS .pack/.zip with an optional `entry` substring to pick the SVD inside). Gives exact peripheral base addresses, register offsets, reset values and bit fields. Prefer the selected board's svd URL from the system prompt.",
    input_schema: obj({ source: str('https URL or local path to .svd/.pack'), entry: str('substring of the .svd name inside a .pack') }, ['source']),
    async run(a, ctx) {
      const src = resolveSource(ctx, a.source);
      const d = await ctx.svd.index(src, a.entry);
      const regs = d.peripherals.reduce((n, p) => n + p.registers.length, 0);
      const e = ctx.ledger.add('svd', d.source, `Parsed ${d.name}: ${d.peripherals.length} peripherals, ${regs} registers`, {
        trust: d.trust,
        sha256: d.sha256,
      });
      return `[${e.id}] parsed ${d.name}: ${d.peripherals.length} peripherals, ${regs} registers`;
    },
  },
  {
    name: 'lookup_register',
    description:
      'Look up exact register addresses, reset values, access and bit fields in indexed SVD files. Authoritative source for addresses/offsets/bit positions: use this instead of memory. With no peripheral/register, lists all peripherals and base addresses. Results are recorded as evidence [E#].',
    input_schema: obj({
      device: str('device name filter, optional'),
      peripheral: str('e.g. UART0'),
      register: str('e.g. UARTDR or a substring'),
      field: str('field name, optional'),
    }),
    async run(a, ctx) {
      if (!ctx.svd.list().length)
        return 'No SVD indexed. Call index_svd (see the board svd URL in the system prompt). Do not state register addresses from memory; report UNVERIFIED.';
      if (!a.peripheral && !a.register && !a.field) {
        const listing = ctx.svd.listPeripherals(a.device);
        const e = ctx.ledger.add('svd', 'peripheral list', listing);
        return `[${e.id}]\n${listing}`;
      }
      const hits = ctx.svd.lookup(a);
      if (!hits.length) return 'No matching register in the indexed SVDs. Check names with a no-argument call, or report UNVERIFIED.';
      return hits
        .map((h) => `[${ctx.ledger.add('svd', h.source, h.text, { trust: h.trust, sha256: h.sha256 }).id}] (${h.trust ?? 'unknown'} source) ${h.text}`)
        .join('\n\n');
    },
  },
  {
    name: 'generate_regs_header',
    description:
      'Generate a C register header for one peripheral straight from the indexed SVD: base address, per-register OFFSET/ADDR/_REG/RESET macros, field _Pos/_Msk macros, enum values, a struct view, and compile-time layout asserts. Write driver code using ONLY these macros so addresses and bit positions are never typed by hand. The user approves the file write.',
    input_schema: obj(
      {
        peripheral: str('exact SVD peripheral name, e.g. UART0'),
        device: str('device filter if several SVDs are indexed'),
        path: str('output path, default include/gen/<peripheral>_regs.h'),
      },
      ['peripheral'],
    ),
    async run(a, ctx) {
      const m = ctx.svd.findPeripherals(a.peripheral, a.device);
      if (!m.length) return `No peripheral named ${a.peripheral} in the indexed SVDs. Call lookup_register with no arguments to list names.`;
      if (m.length > 1) return `Ambiguous: ${a.peripheral} exists in ${m.map((x) => x.dev.name).join(', ')}. Pass device.`;
      const { dev, p } = m[0];
      const rel = a.path ?? `include/gen/${p.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_regs.h`;
      const full = inRoot(ctx, rel);
      const e = ctx.ledger.add('svd', `${dev.source}#${p.name}`, 'pending', { trust: 'derived', sha256: dev.sha256 });
      const g = generateRegsHeader(dev, p, e.id);
      const summary = `Generated ${rel} for ${dev.name} ${p.name} @ 0x${p.base.toString(16).toUpperCase()}: ${g.registers} registers, ${g.fields} fields, ${g.structMembers} struct members${g.skipped.length ? `, ${g.skipped.length} left out of struct (overlap)` : ''}`;
      if (!(await ctx.host.confirm(`Write generated register header ${rel} (${g.text.length} bytes)?`))) {
        ctx.ledger.setExcerpt(e.id, `User declined writing ${rel}`);
        return 'User declined the write.';
      }
      writeFile(full, g.text);
      ctx.ledger.setExcerpt(e.id, summary);
      return `[${e.id}] ${summary}. Include it as #include "${rel.replace(/^include\//, '')}". Run check_header, then write the driver using only its macros.`;
    },
  },
  {
    name: 'check_header',
    description:
      'Compile-check a C header with a host compiler (gcc/clang/cc/zig cc, or `python -m ziglang cc`), including the generated struct-layout static asserts. Output recorded as evidence.',
    input_schema: obj({ path: str('workspace-relative header path') }, ['path']),
    async run(a, ctx) {
      const file = inRoot(ctx, a.path);
      // Compiler errors quote the offending source line, so a header that includes /etc/passwd or ../../.ssh/id_rsa would leak it into the
      // model's context. Only system headers and files below the header's own folder are accepted.
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 2_000_000) return 'Refused: not a regular header file, or larger than 2 MB.';
      const hostile = /^\s*#\s*(?:include|include_next|import)\s*[<"]\s*(?:[a-zA-Z]:|[\\/]|\.\.)/m.exec(fs.readFileSync(file, 'utf8'));
      if (hostile)
        return `Refused: the header includes a file by absolute or parent-relative path (${hostile[0].trim().slice(0, 80)}). Use a path below the header's folder.`;
      const candidates: [string, string[]][] = [
        ['gcc', []],
        ['clang', []],
        ['cc', []],
        ['zig', ['cc']],
        ['python', ['-m', 'ziglang', 'cc']],
      ];
      for (const [cmd, pre] of candidates) {
        if ((await run(cmd, [...pre, '--version'], { timeoutMs: 15_000 })).code !== 0) continue;
        // Compile to an object, not -fsyntax-only: `zig cc` reports a spurious FileNotFound when no output is produced.
        fs.mkdirSync(ctx.host.storeDir, { recursive: true });
        const obj = path.join(ctx.host.storeDir, 'check_header.o');
        const r = await run(cmd, [...pre, '-c', '-o', obj, '-Wno-unused-command-line-argument', '-std=c11', '-Wall', '-Werror', '-x', 'c', file], {
          cwd: ctx.host.root,
          timeoutMs: 60_000,
        });
        const e = ctx.ledger.add('build', `${[cmd, ...pre].join(' ')} -c ${a.path}`, `exit ${r.code}\n${tail(r.out, 1200)}`);
        return `[${e.id}] ${cmd} compile+layout check exit ${r.code}\n${tail(r.out) || '(clean)'}`;
      }
      return 'No host C compiler found (gcc, clang, cc, zig). The header is UNVERIFIED by a compiler; the project `build` tool will check it with the board toolchain.';
    },
  },
  {
    name: 'cross_check_register',
    description:
      'Compare an SVD register (address/offset) against the indexed datasheet text. Returns agree / conflict / name-only / not-found with the datasheet passage as evidence. Use it before relying on a register address; if the sources conflict, report the conflict instead of choosing. Heuristic, not a proof.',
    input_schema: obj({ peripheral: str('e.g. UART0'), register: str('exact register name, e.g. UARTFR'), device: str('device filter, optional') }, [
      'peripheral',
      'register',
    ]),
    async run(a, ctx) {
      const f = ctx.svd.findRegister(a.peripheral, a.register, a.device);
      if (!f)
        return `No register ${a.peripheral}.${a.register} in the indexed SVDs (index_svd first, or the name is wrong). Do not assert it exists; report UNVERIFIED.`;
      const x = await crossCheckRegister(ctx.docs, f.p.name, f.r);
      const svdEv = ctx.ledger.add(
        'svd',
        `${f.dev.source}#${f.p.name}.${f.r.name}`,
        `${f.p.name}.${f.r.name}: address 0x${f.r.address.toString(16).toUpperCase()} (offset 0x${f.r.offset.toString(16).toUpperCase()})`,
        { trust: f.dev.trust, sha256: f.dev.sha256 },
      );
      const dsEv = x.passages.map((p) => ctx.ledger.add('datasheet', `${p.source} p.${p.page}`, p.excerpt, { trust: p.trust, sha256: p.sha256 }));
      const v = ctx.ledger.add('svd', 'cross_check_register', `${x.verdict}: ${x.detail}`, { trust: 'derived' });
      return `[${v.id}] ${x.verdict.toUpperCase()}: ${x.detail}\nSVD evidence [${svdEv.id}] (${f.dev.trust ?? 'unknown'} source)${dsEv.length ? '; datasheet evidence ' + dsEv.map((e) => `[${e.id}]`).join(', ') : ''}`;
    },
  },
];
