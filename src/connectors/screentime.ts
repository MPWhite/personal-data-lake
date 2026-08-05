import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { intEnv } from '../env.js';
import { getDb, maxValue, writeRaw } from '../lake.js';

/**
 * Screen Time has no export API, so this reads Apple's two on-disk usage
 * stores directly:
 *
 *   Mac      knowledgeC.db, stream `/app/usage` — one row per focus session.
 *   iPhone   ~/Library/Biome/streams/restricted/App.InFocus/remote/<device>/
 *            — SEGB segment files synced from the phone (this is the only
 *            readable iPhone source: the ScreenTimeAgent store that Screen
 *            Time itself uses is sealed by macOS beyond Full Disk Access).
 *
 * Both retain only ~4 weeks, so the lake is the long-term archive — sync at
 * least weekly.
 */

const HINT =
  'Reading Screen Time data requires Full Disk Access for the app running this sync ' +
  '(System Settings → Privacy & Security → Full Disk Access), then restarting that app.';

// Core Data / Biome timestamps count seconds from 2001-01-01 UTC.
const APPLE_EPOCH_OFFSET_S = 978307200;

const home = os.homedir();
const KNOWLEDGE_DB = path.join(home, 'Library', 'Application Support', 'Knowledge', 'knowledgeC.db');
const BIOME_FOCUS = path.join(home, 'Library', 'Biome', 'streams', 'restricted', 'App.InFocus', 'remote');
const BIOME_SYNC_DB = path.join(home, 'Library', 'Biome', 'sync', 'sync.db');

interface Session {
  start_s: number; // unix seconds
  usage_s: number;
  app: string;
  device: string;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Local-timezone YYYY-MM-DD for a unix-seconds timestamp. */
function localDay(epochS: number): string {
  const d = new Date(epochS * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Mac: knowledgeC.db ───────────────────────────────────────

async function macSessions(since: number): Promise<Session[]> {
  const db = await getDb();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'screentime-'));
  try {
    // Copy first — the system holds the DB open and mid-write.
    try {
      await fs.copyFile(KNOWLEDGE_DB, path.join(tmp, 'k.db'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') throw new Error(`macOS blocked reading ${KNOWLEDGE_DB}. ${HINT}`);
      throw err;
    }
    for (const suffix of ['-wal', '-shm']) {
      await fs.copyFile(KNOWLEDGE_DB + suffix, path.join(tmp, 'k.db' + suffix)).catch(() => {});
    }

    await db.run(`ATTACH '${path.join(tmp, 'k.db').replaceAll("'", "''")}' AS k (TYPE sqlite)`);
    try {
      const rows = (
        await db.runAndReadAll(
          `SELECT CAST(ZSTARTDATE AS DOUBLE) + ${APPLE_EPOCH_OFFSET_S} AS start_s,
                  CAST(ZENDDATE AS DOUBLE) - CAST(ZSTARTDATE AS DOUBLE) AS usage_s,
                  ZVALUESTRING AS app
           FROM k.ZOBJECT
           WHERE ZSTREAMNAME = '/app/usage' AND CAST(ZSTARTDATE AS DOUBLE) >= ?`,
          [since - APPLE_EPOCH_OFFSET_S],
        )
      ).getRowObjects();
      const device = os.hostname().split('.')[0];
      return rows
        .map((r) => ({ start_s: num(r.start_s)!, usage_s: num(r.usage_s) ?? 0, app: str(r.app) ?? '', device }))
        .filter((s) => s.app && s.usage_s > 0);
    } finally {
      await db.run('DETACH k').catch(() => {});
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ── iPhone/iPad: Biome App.InFocus segments ──────────────────

/**
 * SEGB v2 framing: a 32-byte file header, then records of
 * [checksum:4][state:4][protobuf][padding to 4-byte alignment]. Record
 * lengths aren't stored and the padding isn't reliably zeroed, so anchor on
 * the state marker (10) at aligned offsets and validate each candidate.
 */
function parseSegment(buf: Buffer): { flag: number | null; ts: number; app: string }[] {
  if (buf.length < 32 || buf.subarray(0, 4).toString() !== 'SEGB') return [];
  const out: { flag: number | null; ts: number; app: string }[] = [];
  const marker = Buffer.from([0x0a, 0x00, 0x00, 0x00]);

  for (let idx = buf.indexOf(marker, 0x20); idx >= 0; idx = buf.indexOf(marker, idx + 4)) {
    if (idx < 4 || idx % 4 !== 0) continue;
    let i = idx + 4;
    const end = Math.min(i + 4096, buf.length);
    let flag: number | null = null;
    let ts: number | null = null;
    let app: string | null = null;

    // Fields used: 3 = start(1)/end(0), 4 = Apple-epoch double, 6 = bundle id.
    try {
      while (i < end && buf[i] !== 0) {
        let shift = 0;
        let tag = 0;
        for (;;) {
          const c = buf[i++];
          tag |= (c & 0x7f) << shift;
          if ((c & 0x80) === 0) break;
          shift += 7;
          if (shift > 28 || i >= end) throw new Error('varint');
        }
        const field = tag >> 3;
        const wire = tag & 7;
        if (field === 0 || field > 20) break;
        if (wire === 0) {
          let v = 0;
          shift = 0;
          for (;;) {
            const c = buf[i++];
            v |= (c & 0x7f) << shift;
            if ((c & 0x80) === 0) break;
            shift += 7;
            if (shift > 28 || i >= end) throw new Error('varint');
          }
          if (field === 3) flag = v;
        } else if (wire === 1) {
          if (i + 8 > end) break;
          if (field === 4) ts = buf.readDoubleLE(i);
          i += 8;
        } else if (wire === 2) {
          let len = 0;
          shift = 0;
          for (;;) {
            const c = buf[i++];
            len |= (c & 0x7f) << shift;
            if ((c & 0x80) === 0) break;
            shift += 7;
            if (shift > 28 || i >= end) throw new Error('varint');
          }
          if (len > end - i) break;
          if (field === 6) app = buf.subarray(i, i + len).toString('utf8');
          i += len;
        } else if (wire === 5) {
          i += 4;
        } else {
          break;
        }
      }
    } catch {
      continue;
    }

    // Sanity-check before trusting a candidate: plausible date + a bundle id.
    if (ts == null || app == null || !app.includes('.')) continue;
    if (ts < 5e8 || ts > 1.5e9) continue;
    out.push({ flag, ts: ts + APPLE_EPOCH_OFFSET_S, app });
  }
  return out;
}

/** Map Biome's per-device directory UUIDs to friendly names via the sync
 * peer tables (Biome sync.db ↔ knowledgeC ZSYNCPEER share the Rapport ID). */
async function deviceNames(): Promise<Map<string, string>> {
  const db = await getDb();
  const names = new Map<string, string>();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'screentime-'));
  try {
    await fs.copyFile(BIOME_SYNC_DB, path.join(tmp, 's.db')).catch(() => {});
    await fs.copyFile(KNOWLEDGE_DB, path.join(tmp, 'k.db')).catch(() => {});
    for (const suffix of ['-wal', '-shm']) {
      await fs.copyFile(BIOME_SYNC_DB + suffix, path.join(tmp, 's.db' + suffix)).catch(() => {});
      await fs.copyFile(KNOWLEDGE_DB + suffix, path.join(tmp, 'k.db' + suffix)).catch(() => {});
    }
    await db.run(`ATTACH '${path.join(tmp, 's.db').replaceAll("'", "''")}' AS s (TYPE sqlite)`);
    await db.run(`ATTACH '${path.join(tmp, 'k.db').replaceAll("'", "''")}' AS k (TYPE sqlite)`);
    try {
      const rows = (
        await db.runAndReadAll(
          `SELECT p.device_identifier AS uuid, z.ZMODEL AS model
           FROM s.DevicePeer p
           LEFT JOIN k.ZSYNCPEER z ON z.ZRAPPORTID = p.ids_device_identifier`,
        )
      ).getRowObjects();
      for (const r of rows) {
        const uuid = str(r.uuid);
        if (!uuid) continue;
        // "iPhone18,1" → "iPhone"; unknown models keep a short uuid tag.
        const model = str(r.model);
        names.set(uuid, model?.match(/^[A-Za-z]+/)?.[0] ?? `device-${uuid.slice(0, 8)}`);
      }
    } finally {
      await db.run('DETACH s').catch(() => {});
      await db.run('DETACH k').catch(() => {});
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return names;
}

async function biomeSessions(since: number): Promise<Session[]> {
  const devices = await fs.readdir(BIOME_FOCUS, { withFileTypes: true }).catch((err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw new Error(`macOS blocked reading ${BIOME_FOCUS}. ${HINT}`);
    return [];
  });
  const names = await deviceNames();
  const sessions: Session[] = [];

  for (const dir of devices) {
    if (!dir.isDirectory()) continue;
    const device = names.get(dir.name) ?? `device-${dir.name.slice(0, 8)}`;
    const segDir = path.join(BIOME_FOCUS, dir.name);
    const files = await fs.readdir(segDir, { withFileTypes: true }).catch(() => []);

    const events: { flag: number | null; ts: number; app: string }[] = [];
    for (const f of files) {
      if (!f.isFile() || f.name === 'lock') continue;
      const buf = await fs.readFile(path.join(segDir, f.name)).catch(() => null);
      if (buf) events.push(...parseSegment(buf));
    }
    events.sort((a, b) => a.ts - b.ts);

    // Records pair up: flag 1 opens an app's focus session, flag 0 closes it.
    const open = new Map<string, number>();
    for (const e of events) {
      if (e.flag === 1) {
        open.set(e.app, e.ts);
      } else if (e.flag === 0) {
        const start = open.get(e.app);
        if (start == null) continue;
        open.delete(e.app);
        const usage_s = e.ts - start;
        // Drop implausible spans: a phone left open across a sync gap.
        if (usage_s > 0 && usage_s < 6 * 3600 && start >= since) {
          sessions.push({ start_s: start, usage_s, app: e.app, device });
        }
      }
    }
  }
  return sessions;
}

// ── sync ─────────────────────────────────────────────────────

export async function syncScreentime(): Promise<void> {
  const db = await getDb();
  await db.run('INSTALL sqlite');
  await db.run('LOAD sqlite');
  // Core Data stores dates as REAL Apple-epoch seconds; without this the
  // scanner sniffs them as TIMESTAMP and breaks the epoch arithmetic.
  await db.run('SET sqlite_all_varchar=true');

  // Re-pull a trailing window on top of the incremental cutoff: devices sync
  // late, so recent days keep filling in. Aggregating the whole window before
  // upserting makes INSERT OR REPLACE safe.
  const newest = await maxValue<{ toString(): string }>('screentime_app_usage', 'date');
  const lookbackDays = intEnv('SCREENTIME_RELOOKBACK_DAYS', 7);
  const sinceMs = newest ? new Date(newest.toString()).getTime() - lookbackDays * 24 * 3600 * 1000 : 0;
  const since = Math.max(0, sinceMs / 1000);

  const [mac, biome] = await Promise.all([macSessions(since), biomeSessions(since)]);
  const sessions = [...mac, ...biome];
  await writeRaw('screentime', 'sessions', sessions);

  const daily = new Map<string, { date: string; device: string; app: string; usage_s: number }>();
  for (const s of sessions) {
    const date = localDay(s.start_s);
    const key = `${date}|${s.device}|${s.app}`;
    const row = daily.get(key) ?? { date, device: s.device, app: s.app, usage_s: 0 };
    row.usage_s += s.usage_s;
    daily.set(key, row);
  }
  for (const row of daily.values()) {
    await db.run(`INSERT OR REPLACE INTO screentime_app_usage VALUES (CAST(? AS DATE), ?, ?, ?)`, [
      row.date,
      row.device,
      row.app,
      Math.round(row.usage_s),
    ]);
  }

  const perDevice = new Map<string, number>();
  for (const s of sessions) perDevice.set(s.device, (perDevice.get(s.device) ?? 0) + 1);
  const summary = [...perDevice].map(([d, n]) => `${d} (${n})`).join(', ');
  console.log(`screentime: ${sessions.length} sessions → ${daily.size} day×device×app rows`);
  console.log(`screentime: devices: ${summary || '(none)'}`);
}
