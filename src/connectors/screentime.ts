import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { intEnv } from '../env.js';
import { getDb, maxValue, writeRaw } from '../lake.js';

/**
 * Screen Time has no export API. With "Share Across Devices" enabled, every
 * device's per-app usage syncs into a Core Data SQLite store on this Mac
 * (RMAdminStore-Cloud.sqlite), which we snapshot and read via DuckDB's
 * sqlite extension. Apple only retains a few weeks of fine-grained history
 * there, so the lake is the long-term archive — sync at least weekly.
 */

const HINT =
  'Reading the Screen Time database requires (1) Screen Time "Share Across Devices" enabled on this Mac and ' +
  'your iPhone, and (2) Full Disk Access for the app running this sync (System Settings → Privacy & Security → ' +
  'Full Disk Access), then restarting that app.';

// Core Data timestamps count seconds from 2001-01-01 UTC.
const APPLE_EPOCH_OFFSET_S = 978307200;

// Cloud store holds all devices' usage; Local is the Mac-only fallback.
const STORE_FILES = ['RMAdminStore-Cloud.sqlite', 'RMAdminStore-Local.sqlite'];

function storeDir(): string {
  const userDir = execFileSync('getconf', ['DARWIN_USER_DIR'], { encoding: 'utf8' }).trim();
  return path.join(userDir, 'com.apple.ScreenTimeAgent', 'Store');
}

/** Copy the store (+ WAL/SHM) to a temp dir — the Screen Time agent keeps it open. */
async function snapshotStore(): Promise<{ dir: string; file: string }> {
  const src = storeDir();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'screentime-'));
  for (const file of STORE_FILES) {
    try {
      await fs.copyFile(path.join(src, file), path.join(tmp, file));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') throw new Error(`macOS blocked reading ${src}. ${HINT}`);
      if (code === 'ENOENT') continue;
      throw err;
    }
    for (const suffix of ['-wal', '-shm']) {
      await fs.copyFile(path.join(src, file + suffix), path.join(tmp, file + suffix)).catch(() => {});
    }
    return { dir: tmp, file };
  }
  throw new Error(`No RMAdminStore-*.sqlite found in ${src}. ${HINT}`);
}

const num = (v: unknown): number | null => (v == null ? null : typeof v === 'bigint' ? Number(v) : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Local-timezone YYYY-MM-DD for a unix-seconds timestamp. */
function localDay(epochS: number): string {
  const d = new Date(epochS * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface DailyRow {
  date: string;
  device: string;
  app: string;
  category: string | null;
  usage_s: number;
  pickups: number | null;
  notifications: number | null;
}

export async function syncScreentime(): Promise<void> {
  const db = await getDb();
  const snap = await snapshotStore();

  // Re-pull a trailing window on top of the incremental cutoff: devices sync
  // lazily, so recent days keep changing. INSERT OR REPLACE makes this safe.
  const newest = await maxValue<{ toString(): string }>('screentime_app_usage', 'date');
  const lookbackDays = intEnv('SCREENTIME_RELOOKBACK_DAYS', 7);
  const sinceMs = newest ? new Date(newest.toString()).getTime() - lookbackDays * 24 * 3600 * 1000 : 0;
  const sinceApple = Math.max(0, sinceMs / 1000 - APPLE_EPOCH_OFFSET_S);

  try {
    await db.run('INSTALL sqlite');
    await db.run('LOAD sqlite');
    const dbPath = path.join(snap.dir, snap.file).replaceAll("'", "''");
    await db.run(`ATTACH '${dbPath}' AS st (TYPE sqlite)`);

    // The Z-tables are Apple's private Core Data schema and can drift across
    // macOS versions — verify what we depend on and fail loudly otherwise.
    const found = (
      await db.runAndReadAll(`SELECT lower(table_name) AS t FROM information_schema.tables WHERE table_catalog = 'st'`)
    ).getRowObjects().map((r) => String(r.t));
    const missing = ['zusage', 'zusageblock', 'zusagecategory', 'zusagetimeditem'].filter((t) => !found.includes(t));
    if (missing.length > 0) {
      throw new Error(
        `Screen Time store is missing expected tables (${missing.join(', ')}) — Apple likely changed the schema in ` +
          `a macOS update. Tables present: ${found.join(', ')}`,
      );
    }

    // App usage seconds, one row per hourly block per app per device.
    const items = (
      await db.runAndReadAll(
        `SELECT b.ZSTARTDATE + ${APPLE_EPOCH_OFFSET_S} AS start_s,
                d.ZNAME AS device,
                t.ZBUNDLEIDENTIFIER AS app,
                c.ZIDENTIFIER AS category,
                t.ZTOTALTIMEINSECONDS AS usage_s
         FROM st.ZUSAGETIMEDITEM t
         JOIN st.ZUSAGECATEGORY c ON c.Z_PK = t.ZCATEGORY
         JOIN st.ZUSAGEBLOCK b ON b.Z_PK = c.ZBLOCK
         JOIN st.ZUSAGE u ON u.Z_PK = b.ZUSAGE
         LEFT JOIN st.ZCOREDEVICE d ON d.Z_PK = u.ZDEVICE
         WHERE b.ZSTARTDATE >= ?`,
        [sinceApple],
      )
    ).getRowObjects().map((r) => ({
      start_s: num(r.start_s)!,
      device: str(r.device),
      app: str(r.app),
      category: str(r.category),
      usage_s: num(r.usage_s),
    }));

    // Pickups + notification counts live in a sibling table (absent on some versions).
    let counted: { start_s: number; device: string | null; app: string | null; pickups: number | null; notifications: number | null }[] = [];
    if (found.includes('zusagecounteditem')) {
      counted = (
        await db.runAndReadAll(
          `SELECT b.ZSTARTDATE + ${APPLE_EPOCH_OFFSET_S} AS start_s,
                  d.ZNAME AS device,
                  i.ZBUNDLEIDENTIFIER AS app,
                  i.ZNUMBEROFPICKUPS AS pickups,
                  i.ZNUMBEROFNOTIFICATIONS AS notifications
           FROM st.ZUSAGECOUNTEDITEM i
           JOIN st.ZUSAGEBLOCK b ON b.Z_PK = i.ZBLOCK
           JOIN st.ZUSAGE u ON u.Z_PK = b.ZUSAGE
           LEFT JOIN st.ZCOREDEVICE d ON d.Z_PK = u.ZDEVICE
           WHERE b.ZSTARTDATE >= ?`,
          [sinceApple],
        )
      ).getRowObjects().map((r) => ({
        start_s: num(r.start_s)!,
        device: str(r.device),
        app: str(r.app),
        pickups: num(r.pickups),
        notifications: num(r.notifications),
      }));
    }

    // Raw zone keeps the hourly-block fidelity; the table gets daily rollups.
    await writeRaw('screentime', 'timed-items', items);
    if (counted.length > 0) await writeRaw('screentime', 'counted-items', counted);

    const daily = new Map<string, DailyRow>();
    const rowFor = (date: string, device: string | null, app: string): DailyRow => {
      const key = `${date}|${device}|${app}`;
      let row = daily.get(key);
      if (!row) {
        row = { date, device: device ?? 'unknown', app, category: null, usage_s: 0, pickups: null, notifications: null };
        daily.set(key, row);
      }
      return row;
    };
    for (const r of items) {
      if (!r.app || r.usage_s == null) continue;
      const row = rowFor(localDay(r.start_s), r.device, r.app);
      row.usage_s += r.usage_s;
      row.category ??= r.category;
    }
    for (const r of counted) {
      if (!r.app) continue;
      const row = rowFor(localDay(r.start_s), r.device, r.app);
      if (r.pickups != null) row.pickups = (row.pickups ?? 0) + r.pickups;
      if (r.notifications != null) row.notifications = (row.notifications ?? 0) + r.notifications;
    }

    for (const row of daily.values()) {
      await db.run(
        `INSERT OR REPLACE INTO screentime_app_usage VALUES (CAST(? AS DATE), ?, ?, ?, ?, ?, ?)`,
        [row.date, row.device, row.app, row.category, Math.round(row.usage_s), row.pickups, row.notifications],
      );
    }

    const devices = [...new Set([...daily.values()].map((r) => r.device))];
    console.log(`screentime: upserted ${daily.size} day×device×app rows from ${snap.file}`);
    console.log(`screentime: devices seen: ${devices.join(', ') || '(none — is Share Across Devices on?)'}`);
  } finally {
    await db.run('DETACH st').catch(() => {});
    await fs.rm(snap.dir, { recursive: true, force: true });
  }
}
