import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  root: projectRoot,
  raw: path.join(projectRoot, 'data', 'raw'),
  lake: path.join(projectRoot, 'data', 'lake'),
  db: path.join(projectRoot, 'data', 'lake', 'lake.duckdb'),
};

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function requireEnv(names: string[], hint: string): Record<string, string> {
  const missing = names.filter((n) => !env(n));
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}. ${hint}`);
  }
  return Object.fromEntries(names.map((n) => [n, env(n)!]));
}

export function intEnv(name: string, fallback: number): number {
  const v = env(name);
  return v ? Number.parseInt(v, 10) : fallback;
}
