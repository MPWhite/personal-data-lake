import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './config.js';

/**
 * Land an untouched API response in the raw zone:
 *   data/raw/<source>/<YYYY-MM-DD>/<ISO-timestamp>-<name>.json
 * Raw files are append-only and never modified — they are the source of
 * truth the DuckDB tables can always be rebuilt from.
 */
export async function writeRaw(source: string, name: string, data: unknown): Promise<string> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(paths.raw, source, day);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${ts}-${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  return file;
}
