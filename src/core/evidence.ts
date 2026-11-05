import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrustClass, classifyTrust } from './provenance';

export type EvidenceKind = 'datasheet' | 'serial' | 'build' | 'flash' | 'web' | 'rea' | 'svd' | 'file' | 'user';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: string;
  excerpt: string;
  ts: string;
  trust: TrustClass; // how much this source deserves to be believed (see provenance.ts)
  sha256?: string; // hash of the exact source file/bytes the excerpt came from, when there is one
}

export interface EvidenceMeta {
  trust?: TrustClass;
  sha256?: string;
}

const DEFAULT_TRUST: Record<EvidenceKind, TrustClass | undefined> = {
  serial: 'measured',
  build: 'measured',
  flash: 'measured',
  rea: 'derived',
  user: 'user-supplied',
  file: 'user-supplied',
  datasheet: undefined,
  svd: undefined,
  web: undefined,
};

const clip = (s: string): string => (s.length > 1500 ? s.slice(0, 1500) + '…' : s);

// Stored as JSON Lines: one appended line per entry ({...Evidence}) or excerpt update ({"update": id, "excerpt": ...}).
// Appending keeps each write O(1); rewriting a whole JSON array was quadratic over a workspace's life
// (2,000 entries took 8.6 s, ~6 ms of blocked extension host per write). A legacy ledger.json is migrated once.
type Line = Evidence | { update: string; excerpt: string };

export class Ledger {
  items: Evidence[] = [];
  private byId = new Map<string, Evidence>();
  private file: string;

  constructor(file: string) {
    this.file = file.endsWith('.json') ? file + 'l' : file;
    try {
      for (const raw of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        let line: Line;
        try {
          line = JSON.parse(raw);
        } catch {
          continue; // a torn final line from a crash mid-write loses only that line
        }
        if ('update' in line) {
          const e = this.byId.get(line.update);
          if (e) e.excerpt = line.excerpt;
        } else this.index(line);
      }
    } catch {
      this.migrate(file);
    }
  }

  private index(e: Evidence): void {
    this.items.push(e);
    this.byId.set(e.id, e);
  }

  private migrate(legacy: string): void {
    if (legacy === this.file || !fs.existsSync(legacy)) return;
    try {
      const old: Evidence[] = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      old.forEach((e) => this.index(e));
      fs.writeFileSync(this.file, old.map((e) => JSON.stringify(e) + '\n').join(''));
      fs.renameSync(legacy, legacy + '.migrated');
    } catch {
      this.items = [];
      this.byId.clear();
    }
  }

  add(kind: EvidenceKind, source: string, excerpt: string, meta: EvidenceMeta = {}): Evidence {
    const e: Evidence = {
      id: `E${this.items.length + 1}`,
      kind,
      source,
      excerpt: clip(excerpt),
      ts: new Date().toISOString(),
      trust: meta.trust ?? DEFAULT_TRUST[kind] ?? classifyTrust(source),
      ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
    };
    this.index(e);
    this.append(e);
    return e;
  }

  // For entries whose content is only known after the action finishes (e.g. a generated file).
  setExcerpt(id: string, excerpt: string): void {
    const e = this.get(id);
    if (!e) return;
    e.excerpt = clip(excerpt);
    this.append({ update: id, excerpt: e.excerpt });
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  private dirReady = false;

  private append(line: Line): void {
    if (!this.dirReady) fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.dirReady = true;
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
  }
}
