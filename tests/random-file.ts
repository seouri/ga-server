import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

export async function writeRandomFile(path: string, mib: number): Promise<void> {
  const w = createWriteStream(path);
  for (let i = 0; i < mib; i++) if (!w.write(randomBytes(1024 ** 2))) await once(w, 'drain');
  w.end();
  await once(w, 'finish');
}
