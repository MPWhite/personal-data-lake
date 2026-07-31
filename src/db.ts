import fs from 'node:fs/promises';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { paths } from './config.js';

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
  date        DATE PRIMARY KEY,
  steps       INTEGER,
  resting_hr  INTEGER,
  raw         JSON
);

CREATE TABLE IF NOT EXISTS garmin_sleep (
  date          DATE PRIMARY KEY,
  sleep_s       INTEGER,
  deep_s        INTEGER,
  light_s       INTEGER,
  rem_s         INTEGER,
  awake_s       INTEGER,
  score         INTEGER,
  raw           JSON
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
    await fs.mkdir(paths.lake, { recursive: true });
    const instance = await DuckDBInstance.create(paths.db);
    conn = await instance.connect();
    await conn.run(SCHEMA);
  }
  return conn;
}

/** Max value of a column (as JS value) or undefined if the table is empty. */
export async function maxValue<T>(table: string, column: string): Promise<T | undefined> {
  const db = await getDb();
  const reader = await db.runAndReadAll(`SELECT max(${column}) AS m FROM ${table}`);
  const rows = reader.getRowObjects();
  const m = rows[0]?.m;
  return m === null || m === undefined ? undefined : (m as unknown as T);
}
