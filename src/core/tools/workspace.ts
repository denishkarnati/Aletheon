// Workspace files, confined to the project folder; writes need the user's approval.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tool, assertNotSecret, assertWritable, inRoot, obj, runsCodeWhenBuilt, str, writeFile } from './context';

const READ_LIMIT = 20_000;
// Printable preview of text for an approval prompt: control characters (which could hide or fake lines) become spaces.
// eslint-disable-next-line no-control-regex
const preview = (s: string, n: number): string => s.slice(0, n).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');

export const workspaceTools: Tool[] = [
  {
    name: 'list_dir',
    description: 'List files in a workspace directory.',
    input_schema: obj({ path: str('relative path, default .') }),
    async run(a, ctx) {
      const d = inRoot(ctx, a.path ?? '.');
      return fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => !['node_modules', '.git', '.pio', 'build'].includes(e.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .join('\n');
    },
  },
  {
    name: 'read_file',
    description: 'Read a workspace file.',
    input_schema: obj({ path: str('relative path') }, ['path']),
    async run(a, ctx) {
      const p = inRoot(ctx, a.path);
      assertNotSecret(ctx, p);
      const st = fs.statSync(p);
      if (!st.isFile()) throw new Error(`not a regular file: ${a.path}`); // no devices, FIFOs or directories
      // Read at most READ_LIMIT bytes (+1 to know whether it was cut), never the whole file.
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, READ_LIMIT + 1));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const text = buf.subarray(0, Math.min(n, READ_LIMIT)).toString('utf8');
        return n > READ_LIMIT || st.size > READ_LIMIT ? text + '\n…[truncated]' : text;
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a workspace file. The user is asked to approve every write.',
    input_schema: obj({ path: str('relative path'), content: str('full file content') }, ['path', 'content']),
    async run(a, ctx) {
      if (typeof a.path !== 'string' || typeof a.content !== 'string') throw new Error('write_file needs a string path and a string content');
      const p = inRoot(ctx, a.path);
      assertWritable(ctx, p);
      const rel = path.relative(ctx.host.root, p); // the normalised path that will really be written, not the raw argument
      const warn = runsCodeWhenBuilt(rel) ? '\n⚠ This file can run code when you build or open the project. Read it carefully.' : '';
      const shown = preview(a.content, 600);
      const more = a.content.length > 600 ? `\n…(${a.content.length - 600} more characters)` : '';
      if (!(await ctx.host.confirm(`Write ${rel} (${Buffer.byteLength(a.content)} bytes)?${warn}\n\n${shown}${more}`))) return 'User declined the write.';
      writeFile(p, a.content);
      return `Wrote ${rel}`;
    },
  },
];
