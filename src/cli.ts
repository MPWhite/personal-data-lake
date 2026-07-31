import { getDb } from './db.js';
import { syncStrava } from './connectors/strava.js';
import { syncGarmin } from './connectors/garmin.js';
import { syncGmail } from './connectors/gmail.js';

const SOURCES: Record<string, () => Promise<void>> = {
  strava: syncStrava,
  garmin: syncGarmin,
  gmail: syncGmail,
};

async function sync(target: string): Promise<void> {
  const names = target === 'all' ? Object.keys(SOURCES) : [target];
  for (const name of names) {
    const fn = SOURCES[name];
    if (!fn) {
      console.error(`Unknown source "${name}". Available: ${Object.keys(SOURCES).join(', ')}, all`);
      process.exitCode = 1;
      return;
    }
    console.log(`── syncing ${name} ──`);
    try {
      await fn();
    } catch (err) {
      console.error(`${name}: sync failed —`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
}

async function query(sql: string): Promise<void> {
  const db = await getDb();
  const reader = await db.runAndReadAll(sql);
  console.table(reader.getRowObjects().map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' ? Number(v) : String(v ?? '');
    return out;
  }));
}

async function status(): Promise<void> {
  const db = await getDb();
  const tables = ['strava_activities', 'garmin_activities', 'garmin_daily', 'garmin_sleep', 'emails'];
  for (const t of tables) {
    const reader = await db.runAndReadAll(`SELECT count(*) AS n, max(1) FROM ${t}`);
    const n = reader.getRowObjects()[0]?.n;
    console.log(`${t.padEnd(20)} ${n} rows`);
  }
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case 'sync':
    await sync(arg ?? 'all');
    break;
  case 'query':
    if (!arg) {
      console.error('Usage: npm run query -- "SELECT ..."');
      process.exit(1);
    }
    await query(arg);
    break;
  case 'status':
    await status();
    break;
  default:
    console.log(`Usage:
  npm run sync [strava|garmin|gmail|all]   incrementally sync sources into the lake
  npm run query -- "SELECT ..."            run SQL against the lake
  npm run status                           row counts per table`);
}
