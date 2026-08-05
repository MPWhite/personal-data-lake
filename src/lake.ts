/**
 * The lake itself: file paths, the raw zone, and the DuckDB query zone.
 * This file is the whole storage layer — everything else is either a
 * connector (fetch → writeRaw → upsert) or the CLI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

// ── paths ────────────────────────────────────────────────────

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  raw: path.join(root, 'data', 'raw'),
  db: path.join(root, 'data', 'lake', 'lake.duckdb'),
};

// ── raw zone ─────────────────────────────────────────────────

/**
 * Land an untouched API response in the raw zone:
 *   data/raw/<source>/<YYYY-MM-DD>/<timestamp>-<name>.json
 * Raw files are append-only and never modified — they are the source of
 * truth the DuckDB tables can always be rebuilt from.
 */
export async function writeRaw(source: string, name: string, data: unknown): Promise<void> {
  const now = new Date();
  const dir = path.join(paths.raw, source, now.toISOString().slice(0, 10));
  await fs.mkdir(dir, { recursive: true });
  const ts = now.toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(dir, `${ts}-${name}.json`), JSON.stringify(data, null, 2));
}

// ── query zone (DuckDB) ──────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS strava_activities (
  id            BIGINT PRIMARY KEY,
  name          VARCHAR,
  sport_type    VARCHAR,
  start_date    TIMESTAMP,
  distance_m    DOUBLE,
  moving_time_s INTEGER,
  elapsed_time_s INTEGER,
  elev_gain_m   DOUBLE,
  avg_hr        DOUBLE,
  max_hr        DOUBLE,
  avg_watts     DOUBLE,
  raw           JSON
);

CREATE TABLE IF NOT EXISTS garmin_activities (
  id         BIGINT PRIMARY KEY,
  name       VARCHAR,
  type       VARCHAR,
  start_time TIMESTAMP,
  distance_m DOUBLE,
  duration_s DOUBLE,
  calories   DOUBLE,
  avg_hr     DOUBLE,
  max_hr     DOUBLE,
  raw        JSON
);

CREATE TABLE IF NOT EXISTS garmin_daily (
  date       DATE PRIMARY KEY,
  steps      INTEGER,
  resting_hr INTEGER,
  raw        JSON
);

CREATE TABLE IF NOT EXISTS garmin_sleep (
  date    DATE PRIMARY KEY,
  sleep_s INTEGER,
  deep_s  INTEGER,
  light_s INTEGER,
  rem_s   INTEGER,
  awake_s INTEGER,
  score   INTEGER,
  raw     JSON
);

CREATE TABLE IF NOT EXISTS screentime_app_usage (
  date    DATE,
  device  VARCHAR,
  app     VARCHAR,
  usage_s INTEGER,
  PRIMARY KEY (date, device, app)
);

CREATE TABLE IF NOT EXISTS emails (
  id        VARCHAR PRIMARY KEY,
  thread_id VARCHAR,
  date      TIMESTAMP,
  from_addr VARCHAR,
  to_addr   VARCHAR,
  subject   VARCHAR,
  snippet   VARCHAR,
  labels    VARCHAR,
  body_text VARCHAR
);
`;

let conn: DuckDBConnection | undefined;

export async function getDb(): Promise<DuckDBConnection> {
  if (!conn) {
    await fs.mkdir(path.dirname(paths.db), { recursive: true });
    conn = await (await DuckDBInstance.create(paths.db)).connect();
    await conn.run(SCHEMA);
  }
  return conn;
}

/** Max value of a column, or undefined if the table is empty. Used by every
 * connector to sync incrementally: "what's the newest record I have?" */
export async function maxValue<T>(table: string, column: string): Promise<T | undefined> {
  const db = await getDb();
  const rows = (await db.runAndReadAll(`SELECT max(${column}) AS m FROM ${table}`)).getRowObjects();
  return (rows[0]?.m as T) ?? undefined;
}
