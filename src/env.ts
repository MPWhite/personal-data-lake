/**
 * .env loading and typed accessors, standalone so any module — storage,
 * connectors, messaging, scripts — can read config without pulling in the
 * rest of the system.
 */
import 'dotenv/config';

export function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function intEnv(name: string, fallback: number): number {
  const v = env(name);
  return v ? Number.parseInt(v, 10) : fallback;
}

export function requireEnv(names: string[], hint: string): Record<string, string> {
  const missing = names.filter((n) => !env(n));
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(', ')}. ${hint}`);
  return Object.fromEntries(names.map((n) => [n, env(n)!]));
}
