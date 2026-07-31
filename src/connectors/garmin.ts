import garmin from 'garmin-connect';
import { getDb, intEnv, maxValue, requireEnv, writeRaw } from '../lake.js';

const { GarminConnect } = garmin; // CommonJS package — no named ESM exports
type GarminClient = InstanceType<typeof GarminConnect>;

const HINT = 'Set GARMIN_USERNAME and GARMIN_PASSWORD in .env (your normal Garmin Connect login).';

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function login(): Promise<GarminClient> {
  const { GARMIN_USERNAME, GARMIN_PASSWORD } = requireEnv(['GARMIN_USERNAME', 'GARMIN_PASSWORD'], HINT);
  const gc = new GarminConnect({ username: GARMIN_USERNAME, password: GARMIN_PASSWORD });
  await gc.login();
  return gc;
}

async function syncActivities(gc: GarminClient): Promise<void> {
  const db = await getDb();
  const newest = await maxValue<Date>('garmin_activities', 'start_time');
  const newestMs = newest ? new Date(newest).getTime() : 0;

  let start = 0;
  const pageSize = 50;
  let total = 0;
  outer: for (;;) {
    const activities = await gc.getActivities(start, pageSize);
    if (!activities || activities.length === 0) break;
    await writeRaw('garmin', `activities-${start}`, activities);

    for (const a of activities as any[]) {
      const startTime = (a.startTimeLocal ?? a.startTimeGMT ?? '').replace(' ', 'T');
      // Garmin returns newest first; stop once we reach already-synced data.
      if (newestMs && new Date(startTime).getTime() <= newestMs) break outer;
      await db.run(
        `INSERT OR REPLACE INTO garmin_activities
         VALUES (?, ?, ?, CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?)`,
        [
          a.activityId,
          a.activityName ?? null,
          a.activityType?.typeKey ?? null,
          startTime,
          a.distance ?? null,
          a.duration ?? null,
          a.calories ?? null,
          a.averageHR ?? null,
          a.maxHR ?? null,
          JSON.stringify(a),
        ],
      );
      total += 1;
    }
    start += pageSize;
  }
  console.log(`garmin: synced ${total} new activities`);
}

async function syncDailies(gc: GarminClient): Promise<void> {
  const db = await getDb();
  const newest = await maxValue<{ toString(): string }>('garmin_daily', 'date');
  const backfillDays = intEnv('GARMIN_BACKFILL_DAYS', 30);

  const startFrom = newest
    ? new Date(new Date(newest.toString()).getTime() + 24 * 3600 * 1000)
    : new Date(Date.now() - backfillDays * 24 * 3600 * 1000);

  const today = new Date();
  let synced = 0;
  for (let d = new Date(startFrom); d <= today; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
    const day = dateStr(d);
    try {
      const [steps, hr, sleep] = await Promise.all([
        gc.getSteps(d).catch(() => null),
        gc.getHeartRate(d).catch(() => null),
        gc.getSleepData(d).catch(() => null),
      ]);
      await writeRaw('garmin', `daily-${day}`, { steps, heartRate: hr, sleep });

      await db.run(
        `INSERT OR REPLACE INTO garmin_daily VALUES (CAST(? AS DATE), ?, ?, ?)`,
        [
          day,
          typeof steps === 'number' ? steps : null,
          (hr as any)?.restingHeartRate ?? null,
          JSON.stringify({ steps, heartRate: hr }),
        ],
      );

      const dto = (sleep as any)?.dailySleepDTO;
      if (dto?.sleepTimeSeconds) {
        await db.run(
          `INSERT OR REPLACE INTO garmin_sleep VALUES (CAST(? AS DATE), ?, ?, ?, ?, ?, ?, ?)`,
          [
            day,
            dto.sleepTimeSeconds ?? null,
            dto.deepSleepSeconds ?? null,
            dto.lightSleepSeconds ?? null,
            dto.remSleepSeconds ?? null,
            dto.awakeSleepSeconds ?? null,
            dto.sleepScores?.overall?.value ?? null,
            JSON.stringify(dto),
          ],
        );
      }
      synced += 1;
    } catch (err) {
      console.warn(`garmin: failed to sync daily data for ${day}:`, err);
    }
  }
  console.log(`garmin: synced ${synced} days of wellness data`);
}

export async function syncGarmin(): Promise<void> {
  const gc = await login();
  await syncActivities(gc);
  await syncDailies(gc);
}
