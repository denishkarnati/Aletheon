import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Board, Toolchain } from '../boards';
import { DocStore } from '../docs';
import type { Embedder } from '../embeddings';
import { Ledger } from '../evidence';
import { SvdStore } from '../svd';

export interface Host {
  root: string;
  storeDir: string;
  getBoard(): Board | undefined;
  getToolchain(): 'auto' | Toolchain;
  getEmbedder(): Promise<Embedder | undefined>; // undefined => keyword-only search
  confirm(message: string): Promise<boolean>;
  log(line: string): void;
}

export interface ToolCtx {
  host: Host;
  ledger: Ledger;
  docs: DocStore;
  svd: SvdStore;
}

// One store set per workspace, under <root>/.aletheon (host.storeDir).
export function createToolCtx(host: Host): ToolCtx {
  return {
    host,
    ledger: new Ledger(path.join(host.storeDir, 'ledger.json')),
    docs: new DocStore(path.join(host.storeDir, 'docs')),
    svd: new SvdStore(path.join(host.storeDir, 'svd')),
  };
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run(args: any, ctx: ToolCtx): Promise<string>;
}

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
export const str = (description: string) => ({ type: 'string', description });

const outside = (rel: string): boolean => rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);

export function inRoot(ctx: ToolCtx, p: string): string {
  const full = path.resolve(ctx.host.root, p);
  if (outside(path.relative(ctx.host.root, full))) throw new Error(`path escapes the workspace: ${p}`);
  // Symlinks and Windows junctions: the deepest part of the path that exists must still resolve inside the real workspace root.
  let probe = full;
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  let realProbe: string;
  let realRoot: string;
  try {
    realProbe = fs.realpathSync(probe);
    realRoot = fs.realpathSync(ctx.host.root);
  } catch {
    throw new Error(`refusing a link that points nowhere: ${p}`);
  }
  if (outside(path.relative(realRoot, realProbe))) throw new Error(`path escapes the workspace through a link: ${p}`);
  return full;
}

// Files that commonly hold credentials. The model never needs them, and anything it reads can be sent on (prompt injection).
const SECRET_DIRS = /(^|[\\/])(\.git|\.ssh|\.aws|\.gnupg|\.azure|\.kube)([\\/]|$)/i;
const SECRET_FILES =
  /(^|[\\/])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^\\/]*\.(pem|key|p12|pfx|kdbx|keystore|jks))$/i;
export const isSecretPath = (rel: string): boolean => SECRET_DIRS.test(rel) || SECRET_FILES.test(rel);
export function assertNotSecret(ctx: ToolCtx, full: string): void {
  if (isSecretPath(path.relative(ctx.host.root, full)))
    throw new Error(`refused: ${path.basename(full)} looks like a credentials file, which tools never read`);
}

// Paths tools may never write: git internals and Aletheon's own store (a forged evidence ledger would defeat the grounding guarantees).
export function assertWritable(ctx: ToolCtx, full: string): void {
  const rel = path.relative(ctx.host.root, full);
  if (/(^|[\\/])\.git([\\/]|$)/i.test(rel) || /^\.aletheon([\\/]|$)/i.test(rel))
    throw new Error(`refused: ${rel} is managed by git or Aletheon and cannot be written by tools`);
  assertNotSecret(ctx, full);
}

// Files that execute code when the project is built or opened. Writing one is a bigger decision than writing a source file.
export const runsCodeWhenBuilt = (rel: string): boolean =>
  /(^|[\\/])(platformio\.ini|CMakeLists\.txt|Makefile|GNUmakefile|package\.json|[^\\/]*\.(cmake|mk|py|sh|bat|cmd|ps1)|\.vscode[\\/].*|sdkconfig[^\\/]*)$/i.test(
    rel,
  );

// Tool `source` arguments: URLs pass through (net.ts guards them); paths must stay in the workspace and must not be credential files.
export function resolveSource(ctx: ToolCtx, s: string): string {
  if (/^https?:\/\//i.test(s)) return s;
  const full = inRoot(ctx, s);
  assertNotSecret(ctx, full);
  return full;
}

export function writeFile(full: string, text: string): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
