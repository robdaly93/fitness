# FITLOG

A single-user fitness tracker for a cut: bodyweight against a goal line, a lifting log
with progression targets, a daily calorie budget that moves with your steps, and a
readiness verdict from resting heart rate, HRV and sleep.

It is deliberately small. One Express server, one HTML file, one SQLite database. No
build step, no framework, no bundler. You can read the whole thing in an evening.

## What it does

- **The cut.** Start weight, goal weight, a plan line at your chosen kg/week, and a
  projection from your actual 14-day trend. Says whether you are on track or behind.
- **Lifting log.** Sessions of Push / Pull / Legs / Upper, working sets only, with
  per-exercise history, PRs and progression targets pulled from your last matching
  session.
- **Calorie budget.** Mifflin-St Jeor BMR from your height, age and current weight,
  plus a step allowance and a heart-rate bonus for cardio, minus the deficit your plan
  needs. Walking more raises the day's budget, which is the point.
- **Readiness.** RHR against a 7-day baseline, HRV against 75% of it, and last night's
  sleep, into GREEN / AMBER / RED with a concrete training adjustment.
- **Four daily pillars** (weigh-in, food, steps, sleep) into a day score and a streak.

Everything works with manual entry. The wearable integrations below are optional.

## Quick start

```bash
git clone <your fork> fitlog && cd fitlog
npm install
npm run dev          # http://localhost:7779
```

Then open the app, go to **Goals → EDIT GOALS**, and fill in:

| Field | What it does |
| --- | --- |
| START KG / GOAL KG | The cut. Drives the hero, the plan line and every percentage. |
| CUT START | Day 1. Session numbers and the day counter count from here. |
| HEIGHT CM / BIRTH DATE | Only used for the BMR in the calorie budget. |
| STEP TARGET / SLEEP TARGET | Defaults 10,000 and 7h. |
| PLAN KG/WEEK | Default 1.0. The dashed line on the cut chart. |
| BENCH GOAL KG | One headline strength goal on the Goals page. |

One more profile key has no field in the modal: `milestone_labels`, a JSON object like
`{"105":"HALFWAY"}`, names the round-number marks on the hero scale. Set it through
`POST /api/goals` if you want words instead of numbers there.

The embed score card shows a Styku scan when these goals are set (EDIT GOALS, or
`POST /api/goals`). They are data, not part of the page:

| Key | Example |
| --- | --- |
| `styku_date` | `2026-09-21` |
| `styku_bf_pct` | `19.7` |
| `styku_weight_lb` | `199.0` |
| `styku_lean_lb` | `159.8` |

Weight and lean mass are stored in pounds. The row prints kilograms from those
pounds, then the pounds underneath.

Log a bodyweight, log a session, and the app has everything it needs. Until height and
birth date are set, the calorie budget tile says so rather than guessing.

Set your timezone if you are not in the Gulf: `FITLOG_TZ=Europe/Dublin npm run dev`.
The server writes local dates, so a wrong zone logs things on the wrong day before
dawn.

## Making it yours

Two arrays near the top of the `<script>` block in `index.html`:

- **`PROGRAMS`** - your training split and the exercises in each day, with set counts
  and default reps. Edit these to match your gym. The names are matched as plain text
  against your history, so keep them stable once you start logging.
- **`ROUTINE`** - day of week to session type, `null` for a rest day. Used only to fill
  future placeholders; the app suggests the next session by rotation (least recently
  trained), not by weekday.

`TYPE_COLOR` in the same block sets the colour per day type, and the colour rules the
rest of the UI follows are written down in `CLAUDE.md`.

## Optional: wearable sync

Both integrations are genuinely optional and the app degrades to manual entry without
them. Both need you to register your own developer app, because the credentials are
per-person.

### Weight from a Withings scale

1. Register a free app at [developer.withings.com](https://developer.withings.com) with
   callback `http://localhost:7779/auth/withings/callback`.
2. Save `.withings-credentials.json` in the project root:
   `{"client_id":"...","client_secret":"..."}`
3. Visit `/auth/withings` once to authorise, then `POST /api/withings/sync?days=3`.

### Steps, sleep, runs and recovery from Fitbit

Fitbit data comes via the **Google Health API v4**, not the old Fitbit Web API.

1. Create a Google Cloud project, enable the Google Health API, and create an OAuth
   client with callback `http://localhost:7779/auth/google-health/callback`.
2. Save the downloaded client secret as `.google-credentials.json`.
3. Visit `/auth/google-health` to consent, then `POST /api/fitbit/sync?days=3`.
   The server also re-syncs every four hours in process.

Two things worth knowing before you invest in this path:

- While your Google Cloud project is in **Testing** mode, refresh tokens expire about
  weekly and you have to re-consent. Publishing the app avoids it but needs review.
- Steps are taken from `FITBIT` platform points only. `HEALTH_KIT` points are the same
  steps counted again by the iPhone, so including them roughly doubles your day.

Sync health is exposed at `GET /api/fitbit/status` and `GET /api/withings/status`, which
is what turns the header chip red when a sync has failed or gone stale.

## Deploying

The included `Dockerfile` runs anywhere with a persistent volume at `/data`.

`fly.toml` in this repo is the original author's deployment. For your own:

```bash
flyctl launch          # generates your own fly.toml and app name
flyctl volumes create fitlog_data --size 1
flyctl deploy
```

Set `DB_PATH=/data/fitness.db` (already in `fly.toml`) so the database survives
restarts, and the OAuth secrets as Fly secrets:

```bash
flyctl secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
                   WITHINGS_CLIENT_ID=... WITHINGS_CLIENT_SECRET=...
```

OAuth callbacks are derived from the public origin, with no path prefix:

- `https://<host>/auth/google-health/callback`
- `https://<host>/auth/withings/callback`

Fitlog is served at the **root** of its own hostname behind Cloudflare Access
(`https://fitlog.<hub-domain>`), not under `/fitlog/`. Set

```bash
PUBLIC_URL=https://fitlog.example.com
```

with no trailing slash and no `/fitlog`. `PUBLIC_URL` is that origin only. A
trailing slash is stripped, so the redirect URIs stay
`${PUBLIC_URL}/auth/google-health/callback` and
`${PUBLIC_URL}/auth/withings/callback`. Register those exact URLs in the Google
and Withings consoles.

The page still works if something mounts it under `/fitlog/`: the frontend
prefixes `/api` and `/auth` only when `location.pathname` starts with
`/fitlog`. At `/` the prefix is empty.

To let the hub frame this host, set `FRAME_ANCESTORS` to the hub origin
(space-separated if there is more than one). The default is `'self'`, which
blocks every other origin. Every response also sends
`X-Content-Type-Options: nosniff`.

`HUB_ORIGIN` is the one origin embed mode may talk to. Set it to the same hub
origin you allow in `FRAME_ANCESTORS` (that list can name more than one
source; this value is exactly one):

```bash
FRAME_ANCESTORS=https://hub.example.com
HUB_ORIGIN=https://hub.example.com
```

It must be a bare `https` origin. For local dev, `http://localhost` or
`http://127.0.0.1` must include a port (`http://localhost:4321`). No path,
query, hash, or trailing slash. A bare `http://localhost` is rejected.
`GET /api/config` returns `{ "hubOrigin": "https://hub.example.com" }`, or
`{ "hubOrigin": null }` when the variable is unset or invalid. The page posts
`fitlog:height` to that origin and accepts `fitlog:tab` only from it. It never
uses `*` and never uses fitlog's own origin. If the value is missing, invalid,
or equal to this page's origin, the page posts nothing and ignores parent
messages.

`POST /api/dev/sync-prod` and `GET /api/health/raw` answer 404 unless
`FITLOG_DEBUG=1`. Leave that flag unset on the public host. `POST /api/fitbit/sync`
and `POST /api/withings/sync` stay available. In production they sit behind
Cloudflare Access. The four-hour Fitbit refresh calls the sync function in process.

### There is no login

FITLOG has no authentication of any kind. Anyone who can reach the URL can read and
write your data. That is fine on localhost or a private network. If you deploy it to a
public URL, put something in front of it: Cloudflare Access, Tailscale, or a reverse
proxy with basic auth. Do not skip this and then connect your scale to it.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7779` | HTTP port |
| `DB_PATH` | `./fitness.db` | SQLite file location |
| `FITLOG_TZ` | `Asia/Dubai` | Timezone for "today" |
| `PUBLIC_URL` | derived | Origin only, for OAuth callbacks. Root custom domain, no `/fitlog` path |
| `FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` source list. Set to the hub origin so the hub can frame this host |
| `HUB_ORIGIN` | unset | Bare hub origin for embed `postMessage` (`fitlog:height` out, `fitlog:tab` in). `https://host`, or `http://localhost:port` |
| `FITLOG_DEBUG` | unset | `1` enables `/api/dev/*` and `/api/health/raw`. Sync POSTs stay on without it |
| `FLY_APP` | from `fly.toml` | Target app for the dev prod-DB pull |
| `GOOGLE_CLIENT_ID` / `_SECRET` | - | Google Health OAuth, production only |
| `WITHINGS_CLIENT_ID` / `_SECRET` | - | Withings OAuth, production only |

## API

The frontend is a client of the same HTTP API you can script against. Read and write
through it rather than opening the SQLite file, since the running server holds it.

```
GET  /api/today                    everything the Today screen needs, in one call
POST /api/log                      a whole session: exercises and sets in one body
GET  /api/sessions?detail=4        session list, N newest expanded with sets
GET  /api/exercise-history/:name   one lift over time
GET  /api/prs?since=YYYY-MM-DD     best set per lift
GET|POST /api/body-weight          weigh-ins
GET|POST /api/steps /api/sleep /api/diet /api/runs
GET|POST /api/goals                the key/value profile described above
GET  /api/recovery                 daily RHR and HRV
GET|POST /api/notes                insight notes, categorised
POST /api/withings/sync?days=N     pull weight
POST /api/fitbit/sync?days=N       pull steps, sleep, workouts, RHR, HRV
GET  /api/health/raw               raw Health API response (FITLOG_DEBUG=1)
POST /api/dev/sync-prod            replace the local db from prod (FITLOG_DEBUG=1, not on Fly)
GET  /api/fitbit/status /api/withings/status
GET  /api/config                    `{ hubOrigin }` for embed postMessage, or null
```

`POST /api/log` is the one worth knowing:

```json
{
  "date": "2026-09-29", "name": "PUSH", "type": "PUSH", "color": "#f4a800",
  "note": "left shoulder fine today",
  "exercises": [
    { "name": "Bench Press", "weight_kg": 70,
      "sets": [ { "reps": 8 }, { "reps": 8 }, { "reps": 6 } ] }
  ]
}
```

## Data model

SQLite, created on first run, migrated forward with `ALTER TABLE` guards in
`server.js`. One row per day for the daily tables.

```
sessions ─┬─ exercises ─── sets
          └─ (date, type, colour, note)
body_weight   daily_steps   daily_sleep   daily_diet   daily_recovery
runs          goals         exercise_notes              insight_notes
```

`goals` is a plain key/value table and holds the entire profile, which is why nothing
personal needs to live in the source.

## A note on the author's workflow

`CLAUDE.md` and `.claude/commands/daily.md` describe one specific way of using this app:
recording lifts in an Apple Note and having Claude Code sync them into FITLOG each
morning. That is personal to the original author and entirely optional. The app has a
full in-app session logger and does not need it.

The parts of `CLAUDE.md` worth keeping if you fork are the UI rules: fonts, borders,
colour meanings and the code conventions the frontend follows.
