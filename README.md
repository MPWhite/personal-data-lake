# Personal Data Lake

All my personal data — Garmin, Strava, Gmail, iPhone/Mac Screen Time — pulled into one place I can query with SQL. Local-first, TypeScript, no servers.

```sh
npm install
cp .env.example .env    # fill in credentials (see Setup)
npm run sync            # pull new data from every configured source
npm run query -- "SELECT sport_type, count(*) FROM strava_activities GROUP BY 1"
```

## How it works

Two layers, that's the whole design:

```
                 ┌────────────────────────────────────┐
  Garmin ──────▶ │  data/raw/<source>/<date>/*.json   │  RAW ZONE
  Strava ──────▶ │  untouched source payloads,        │  append-only,
  Gmail ───────▶ │  written before anything else      │  never edited
  Screen Time ─▶ │                                    │
                 └─────────────────┬──────────────────┘
                                   │ typed upserts
                 ┌─────────────────▼──────────────────┐
                 │  data/lake/lake.duckdb             │  QUERY ZONE
                 │  clean SQL tables                  │  rebuildable
                 └────────────────────────────────────┘
```

- **Raw zone first.** Every sync lands the exact source payload as timestamped JSON before touching the database. Wrong schema decision later? Delete `lake.duckdb` and rebuild — the raw files are the permanent source of truth.
- **Incremental + idempotent.** Each connector asks the lake "what's the newest record I have?" and fetches only newer data, upserting with `INSERT OR REPLACE`. Re-running `sync` is always safe.
- **One query engine.** [DuckDB](https://duckdb.org) is a single-file analytical database. Fields not promoted to real columns live in each row's `raw` JSON column: `raw->>'$.some_field'`. You can also open the lake with any DuckDB client: `duckdb data/lake/lake.duckdb`.

## The code

A handful of small files. Read them in this order and you know the entire system:

```
src/env.ts              .env loading + typed accessors, shared by everything below
src/lake.ts             the storage layer: paths, raw-zone writer, DuckDB schema + connection
src/connectors/*.ts     one per source, all the same shape: fetch → writeRaw() → upsert
src/messaging/linq.ts   outbound texting (iMessage via Linq): sendText() from anywhere
src/cli.ts              entrypoint: sync / query / status / text
scripts/*-auth.ts       one-time OAuth flows that print the refresh token for .env
```

Tables: `strava_activities`, `garmin_activities`, `garmin_daily` (steps, resting HR), `garmin_sleep`, `screentime_app_usage` (per-app seconds per day per device), `emails`. Schema is in `src/lake.ts`.

## Setup

Each source is independent — configure only what you want, in `.env`:

| Source | Steps |
|---|---|
| **Garmin** | Your normal Garmin Connect username/password (unofficial API, no dev account needed) |
| **Strava** | Create an API app at [strava.com/settings/api](https://www.strava.com/settings/api) (callback domain `localhost`), add client id/secret to `.env`, run `npm run auth:strava` |
| **Gmail** | Google Cloud project → enable Gmail API → OAuth **Desktop app** credentials → add to `.env`, run `npm run auth:gmail` |
| **Screen Time** | No credentials — reads Apple's local usage databases (there is no export API). Grant **Full Disk Access** to the app that runs `npm run sync`, then restart it. Turn on Screen Time **Share Across Devices** so the iPhone's usage reaches this Mac. Apple keeps only ~4 weeks, so sync at least weekly — the lake is the archive. |

First Gmail/Garmin sync backfills 30 days (`GMAIL_BACKFILL_DAYS` / `GARMIN_BACKFILL_DAYS`); Strava backfills everything.

## Commands

```sh
npm run sync [strava|garmin|gmail|screentime]   # sync one source, or all if omitted
npm run status                       # row counts per table
npm run query -- "SELECT ..."        # run SQL against the lake
npm run text -- "message"            # text yourself via Linq (iMessage)
```

## Texting

The lake can text you. `sendText()` in `src/messaging/linq.ts` sends iMessage (with RCS/SMS fallback) through [Linq](https://linqapp.com), so syncs and cron jobs can push results to your phone instead of waiting for you to look:

```ts
import { sendText } from './messaging/linq.js';

await sendText('morning sync done — 3 new activities');   // texts LINQ_DEFAULT_TO (you)
await sendText('new PR! 🎉', { effect: 'confetti' });     // iMessage effects
await sendText('hi', { to: '+15551234567' });             // anyone else
```

One-time setup: `npx @linqapp/cli signup`, put the printed API key and Linq Number in `.env` (`LINQ_API_KEY`, `LINQ_NUMBER`) along with your phone as `LINQ_DEFAULT_TO`, then `linq contacts add <your-phone>` and send one text from your phone to the Linq Number — the free tier is inbound-first (a contact must text the line before it can text them, max 20 contacts). Verify end-to-end with `npm run text -- "hi"`. When you outgrow one-liners, `getLinqClient()` exposes the full SDK: reactions, attachments, group chats, webhooks.

## Screen Time

Apple ships no Screen Time export, so this connector reads the two places macOS keeps the raw usage itself:

| Device | Source |
|---|---|
| **Mac** | `~/Library/Application Support/Knowledge/knowledgeC.db` — the `/app/usage` stream, one row per focus session. |
| **iPhone / iPad** | `~/Library/Biome/streams/restricted/App.InFocus/remote/<device>/` — usage synced from the phone, stored as SEGB segment files (a binary container of protobuf records, parsed in `screentime.ts`). |

The obvious-looking source — `com.apple.ScreenTimeAgent/Store/RMAdminStore-Cloud.sqlite`, what the Screen Time UI itself reads — is **not** usable: macOS 15 denies it even with Full Disk Access. Biome is the only readable path to iPhone numbers.

Because these are private Apple formats that shift between OS releases, the connector validates before trusting: it checks the tables it needs exist, and ignores any Biome record that doesn't carry a plausible timestamp and bundle id. Totals are aggregated per day, so they're expected to run slightly under the Screen Time UI, which counts a little differently (notifications, pickups, and locked-screen time).

```sh
npm run query -- "SELECT date, round(sum(usage_s)/3600.0,1) AS hours FROM screentime_app_usage WHERE device='iPhone' GROUP BY date ORDER BY date DESC LIMIT 7"
```

## Adding a source

1. `src/connectors/<source>.ts` — export a `sync` function: fetch incrementally → `writeRaw()` → upsert into a table you add to `SCHEMA` in `src/lake.ts`.
2. Add it to the `SOURCES` map in `src/cli.ts`.

That's it — no registration, no config files.
