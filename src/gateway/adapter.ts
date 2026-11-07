import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../identity.ts';
import { writeAtomic } from '../smart/store.ts';

type Payload = Record<string, unknown>;
type Entry = { payload: Payload; expiresAt?: number };

// oidc-provider adapter storing each model under <dir>/oidc/<Model>/<sha256(id)>.json.
// shortcut: no locking or indexes, single process only; move to Redis if the gateway ever runs several.
export class FileAdapter {
  model: string;
  root: string;
  now: () => number;

  constructor(model: string, dir: string, now: () => number = Date.now) {
    this.model = model;
    this.root = join(dir, 'oidc');
    this.now = now;
  }

  file(id: string, model = this.model): string {
    return join(this.root, model, `${sha256(id)}.json`);
  }

  read(file: string): Payload | undefined {
    if (!existsSync(file)) return undefined;
    const e = JSON.parse(readFileSync(file, 'utf8')) as Entry;
    if (e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      rmSync(file, { force: true });
      return undefined;
    }
    return e.payload;
  }

  // Every live payload of the given models, with its file.
  scan(models: string[]): [string, Payload][] {
    return models.flatMap((m) => {
      const d = join(this.root, m);
      if (!existsSync(d)) return [];
      return readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f): [string, Payload][] => {
          const p = this.read(join(d, f));
          return p ? [[join(d, f), p]] : [];
        });
    });
  }

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
    const e: Entry = { payload, expiresAt: expiresIn === undefined ? undefined : this.now() + expiresIn * 1000 };
    writeAtomic(this.file(id), JSON.stringify(e), 0o600);
  }

  async find(id: string): Promise<Payload | undefined> {
    return this.read(this.file(id));
  }

  async findByUid(uid: string): Promise<Payload | undefined> {
    return this.scan([this.model]).find(([, p]) => p.uid === uid)?.[1];
  }

  async consume(id: string): Promise<void> {
    const f = this.file(id);
    if (!existsSync(f)) return;
    const e = JSON.parse(readFileSync(f, 'utf8')) as Entry;
    e.payload.consumed = Math.floor(this.now() / 1000);
    writeAtomic(f, JSON.stringify(e), 0o600);
  }

  async destroy(id: string): Promise<void> {
    rmSync(this.file(id), { force: true });
  }

  // Like oidc-provider's memory adapter: removes every token of the grant, whatever its model.
  async revokeByGrantId(grantId: string): Promise<void> {
    const models = existsSync(this.root) ? readdirSync(this.root) : [];
    for (const [f, p] of this.scan(models)) if (p.grantId === grantId) rmSync(f, { force: true });
  }
}

// Expired records are only deleted when read; sweep the rest (tokens nobody presents again).
export function sweepExpired(dir: string, now: number = Date.now()): void {
  const root = join(dir, 'oidc');
  if (!existsSync(root)) return;
  // A sweep must never throw (stray files like .DS_Store, races with deletes): it runs at startup and on an interval.
  try {
    for (const m of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()))
      for (const f of readdirSync(join(root, m.name)).filter((f) => f.endsWith('.json'))) {
        const file = join(root, m.name, f);
        try {
          const e = JSON.parse(readFileSync(file, 'utf8')) as Entry;
          if (e.expiresAt !== undefined && e.expiresAt <= now) rmSync(file, { force: true });
        } catch {} // unreadable or half-written: leave it
      }
  } catch {}
}
