# Personal Data Lake

A local-first data lake for personal data: Garmin, Strava, and Gmail, all in TypeScript.

## Architecture

```
                 ┌─────────────────────────────────────────────┐
  APIs           │  data/raw/<source>/<date>/*.json            │   RAW ZONE
  Garmin ──────▶ │  untouched API responses, append-only.      │   (source of truth,
  Strava ──────▶ │  Never edited — tables can always be        │    rebuildable)
  Gmail  ──────▶ │  rebuilt from these files.                  │
                 └──────────────────┬──────────────────────────┘
                                    │ typed upserts
                 ┌──────────────────▼──────────────────────────┐
                 │  data/lake/lake.duckdb                      │   QUERY ZONE
                 │  strava_activities, garmin_activities,      │   (clean tables,
                 │  garmin_daily, garmin_sleep, emails         │    ask anything in SQL)
                 └─────────────────────────────────────────────┘
```

Key ideas (standard data-lake practice, scaled to one person):

- **Raw zone first.** Every sync lands the exact API response as timestamped JSON before anything else happens. If a schema decision turns out wrong later, delete the DuckDB file and rebuild — the raw files are never touched.
- **Incremental syncs.** Each connector asks the lake "what's the newest record I have?" and only fetches newer data. Syncs are idempotent (`INSERT OR REPLACE`), so re-running is always safe.
- **One query engine.** [DuckDB](https://duckdb.org) is a single-file analytical database — no server to run. Each row also keeps the full original record in a `raw` JSON column, so fields not promoted to real columns are still queryable with `raw->>'$.field'`.

## Setup

```sh
npm install
cp .env.example .env
```

Then fill in credentials per source (each is optional — sync only what's configured):

| Source | Steps |
|---|---|
| **Strava** | Create an API app at [strava.com/settings/api](https://www.strava.com/settings/api) (callback domain: `localhost`), put client id/secret in `.env`, run `npm run auth:strava` |
| **Garmin** | Put your normal Garmin Connect username/password in `.env` (uses the unofficial API) |
| **Gmail** | Create a Google Cloud project, enable the Gmail API, create OAuth **Desktop app** credentials, put client id/secret in `.env`, run `npm run auth:gmail` |

## Usage

```sh
npm run sync              # sync all configured sources
npm run sync strava       # or one source: strava | garmin | gmail
npm run status            # row counts per table
npm run query -- "SELECT sport_type, count(*), round(sum(distance_m)/1000) AS km
                  FROM strava_activities GROUP BY 1 ORDER BY 3 DESC"
```

You can also open the lake directly with the DuckDB CLI or any DuckDB client: `duckdb data/lake/lake.duckdb`.

## Tables

- `strava_activities` — one row per activity (distance, times, HR, watts, + full `raw`)
- `garmin_activities` — one row per Garmin activity
- `garmin_daily` — one row per day: steps, resting HR
- `garmin_sleep` — one row per night: stage durations, sleep score
- `emails` — one row per message: headers, labels, snippet, plain-text body

## Adding a new source

1. Create `src/connectors/<source>.ts` exporting `sync<Source>()` that: fetches incrementally → `writeRaw(...)` → upserts into a table defined in `src/db.ts`.
2. Register it in the `SOURCES` map in `src/cli.ts`.
