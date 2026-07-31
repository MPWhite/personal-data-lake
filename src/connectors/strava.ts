import { requireEnv } from '../config.js';
import { writeRaw } from '../raw.js';
import { getDb, maxValue } from '../db.js';

const HINT = 'Set up a Strava API app at https://www.strava.com/settings/api, put the client id/secret in .env, then run `npm run auth:strava`.';

interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  [key: string]: unknown;
}

async function getAccessToken(): Promise<string> {
  const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN } = requireEnv(
    ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN'],
    HINT,
  );
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function syncStrava(): Promise<void> {
  const token = await getAccessToken();

  // Incremental: only fetch activities that started after the newest one we have.
  const newest = await maxValue<Date>('strava_activities', 'start_date');
  const after = newest ? Math.floor(new Date(newest).getTime() / 1000) : 0;

  const db = await getDb();
  let page = 1;
  let total = 0;
  for (;;) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    if (after > 0) url.searchParams.set('after', String(after));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status} ${await res.text()}`);
    const activities = (await res.json()) as StravaActivity[];
    if (activities.length === 0) break;

    await writeRaw('strava', `activities-page-${page}`, activities);

    for (const a of activities) {
      await db.run(
        `INSERT OR REPLACE INTO strava_activities
         VALUES (?, ?, ?, CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.id,
          a.name,
          a.sport_type,
          a.start_date.replace('Z', ''),
          a.distance,
          a.moving_time,
          a.elapsed_time,
          a.total_elevation_gain,
          a.average_heartrate ?? null,
          a.max_heartrate ?? null,
          a.average_watts ?? null,
          JSON.stringify(a),
        ],
      );
    }
    total += activities.length;
    console.log(`strava: page ${page} → ${activities.length} activities`);
    page += 1;
  }
  console.log(`strava: synced ${total} new/updated activities`);
}
