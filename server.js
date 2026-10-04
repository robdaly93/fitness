const express = require('express')
const { Database } = require('node-sqlite3-wasm')
const path = require('path')

const fs = require('fs')
const { execSync, spawn } = require('child_process')
const { publicOrigin, frameAncestorsDirective, debugEnabled } = require('./http-guard')
const { hubOrigin } = require('./hub-origin')
const PORT = process.env.PORT || 7779
// The Fly app this install deploys to, read from fly.toml so a fork changes one
// config line and nothing in the code.
const FLY_APP = process.env.FLY_APP || (() => {
  try { return (fs.readFileSync(path.join(__dirname, 'fly.toml'), 'utf8').match(/^app *= *['"]([^'"]+)/m) || [])[1] || null }
  catch { return null }
})()
// Base URL for OAuth callbacks. No path: fitlog is served at the root of its own
// host (https://fitlog.example.com). A trailing slash is stripped so the callback
// is ${PUBLIC_URL}/auth/... and not a double slash. On Fly it follows the app name.
const PUBLIC_URL = publicOrigin(process.env)
const dbPath = process.env.DB_PATH || path.join(__dirname, 'fitness.db')
// node-sqlite3-wasm uses a .lock directory — remove stale one from crashed previous run
try { fs.rmdirSync(dbPath + '.lock') } catch (e) {}
const db = new Database(dbPath)

// One date helper for the whole server. toISOString() gives the UTC date, which is
// the wrong local day for most of the world before dawn, so every default date goes
// through these. Set FITLOG_TZ to your own zone.
const TZ = process.env.FITLOG_TZ || 'Asia/Dubai'
const localDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ })
const todayIso = () => localDate(Date.now())

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,
    name       TEXT    NOT NULL DEFAULT 'Session',
    type       TEXT    DEFAULT 'lift',
    color      TEXT    DEFAULT '#f4a800',
    note       TEXT,
    ended_at   TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS exercises (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    weight_kg  REAL,
    order_idx  INTEGER DEFAULT 0,
    notes      TEXT
  );
  CREATE TABLE IF NOT EXISTS sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    set_num     INTEGER NOT NULL,
    reps        INTEGER NOT NULL,
    weight_kg   REAL
  );
  CREATE TABLE IF NOT EXISTS body_weight (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT    UNIQUE NOT NULL,
    weight_kg REAL    NOT NULL,
    created_at TEXT   DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT  NOT NULL,
    distance_km  REAL  NOT NULL,
    duration_sec INTEGER,
    notes        TEXT,
    created_at   TEXT  DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS goals (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exercise_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    date        TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_steps (
    date       TEXT PRIMARY KEY,
    steps      INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_diet (
    date       TEXT PRIMARY KEY,
    on_plan    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_sleep (
    date       TEXT PRIMARY KEY,
    slept_ok   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_recovery (
    date       TEXT PRIMARY KEY,
    rhr        REAL,
    hrv_ms     REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS insight_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    category   TEXT DEFAULT 'general',
    created_at TEXT DEFAULT (datetime('now'))
  );
`)

// Added Sep 2026: calorie total per day, alongside the older on_plan flag
try { db.exec(`ALTER TABLE daily_diet ADD COLUMN kcal INTEGER`) } catch { /* already present */ }
try { db.exec(`ALTER TABLE daily_diet ADD COLUMN items TEXT`) } catch { /* already present */ }
// Average heart rate on auto-imported sessions, so an incline walk can be costed
// properly instead of being under-read by its low step count.
try { db.exec(`ALTER TABLE runs ADD COLUMN avg_hr INTEGER`) } catch { /* already present */ }
// Sep 2026: Fitbit WALKING sessions land in `runs` too, so each row records what it
// was. Anything slower than 9:00/km is a walk and stays out of the run stats.
try { db.exec(`ALTER TABLE runs ADD COLUMN kind TEXT`) } catch { /* already present */ }
// Withings knows what time the weigh-in happened; keep it so the hero can say so.
try { db.exec(`ALTER TABLE body_weight ADD COLUMN measured_at TEXT`) } catch { /* already present */ }

const WALK_PACE_SEC_PER_KM = 540
db.exec(`UPDATE runs SET kind = CASE
  WHEN duration_sec IS NOT NULL AND distance_km > 0
       AND (duration_sec * 1.0 / distance_km) > ${WALK_PACE_SEC_PER_KM} THEN 'walk'
  WHEN notes LIKE '%Walk%' OR notes LIKE '%Hik%' THEN 'walk'
  ELSE 'run' END
WHERE kind IS NULL`)

function classifyRun(distanceKm, durationSec, label) {
  if (label && /walk|hik/i.test(label)) return 'walk'
  if (!durationSec || !distanceKm) return 'run'
  return durationSec / distanceKm > WALK_PACE_SEC_PER_KM ? 'walk' : 'run'
}

const app = express()
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestorsDirective(process.env.FRAME_ANCESTORS)}`)
  next()
})
app.use(express.json())
app.use(express.static(__dirname))

// Fixed pages only. Query values and provider errors are never written into HTML.
function authPage(title, message, retry) {
  const again = retry
    ? `<p><a href="${retry}">Try again</a></p>`
    : '<p><a href="/">Back to FITLOG</a></p>'
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h2>${title}</h2><p>${message}</p>${again}</body></html>`
}
function sendAuth(res, status, title, message, retry) {
  res.status(status).type('html').send(authPage(title, message, retry))
}

// Embed postMessage target. Invalid or unset HUB_ORIGIN is null, never echoed raw.
app.get('/api/config', (req, res) => {
  res.json({ hubOrigin: hubOrigin(process.env.HUB_ORIGIN) })
})

// node-sqlite3-wasm requires an array for multiple bind params
const q = (sql) => db.prepare(sql)

function getSession(id) {
  const session = q('SELECT * FROM sessions WHERE id = ?').get([id])
  if (!session) return null
  const exercises = q('SELECT * FROM exercises WHERE session_id = ? ORDER BY order_idx, id').all([id])
  for (const ex of exercises) {
    ex.sets = q('SELECT * FROM sets WHERE exercise_id = ? ORDER BY set_num').all([ex.id])
  }
  session.exercises = exercises
  return session
}

function sessionSummary(s) {
  const exs = q('SELECT id FROM exercises WHERE session_id = ?').all([s.id])
  const allSets = exs.flatMap(e => q('SELECT reps, weight_kg FROM sets WHERE exercise_id = ?').all([e.id]))
  return {
    ...s,
    exercise_count: exs.length,
    total_sets: allSets.length,
    total_reps: allSets.reduce((a, x) => a + (x.reps || 0), 0),
    volume_kg: Math.round(allSets.reduce((a, x) => a + (x.reps || 0) * (x.weight_kg || 0), 0))
  }
}

// Today snapshot
app.get('/api/today', (req, res) => {
  const today = todayIso()
  const row = q('SELECT id FROM sessions WHERE date = ? ORDER BY id DESC LIMIT 1').get([today])
  const bwAll = q('SELECT * FROM body_weight ORDER BY date DESC LIMIT 600').all([])
  const bwHistory = bwAll.slice().reverse()
  const stepsRow = q('SELECT steps FROM daily_steps WHERE date = ?').get([today])
  const dietRow = q('SELECT on_plan, kcal, items FROM daily_diet WHERE date = ?').get([today])
  const sleepRow = q('SELECT slept_ok FROM daily_sleep WHERE date = ?').get([today])
  res.json({
    session: row ? getSession(row.id) : null,
    bodyWeight: bwAll[0] || null,
    bwHistory,
    lastRun: q('SELECT * FROM runs ORDER BY date DESC, id DESC LIMIT 1').get([]) || null,
    todaySteps: stepsRow ? stepsRow.steps : null,
    todayDiet: dietRow ? !!dietRow.on_plan : null,
    todayKcal: dietRow ? dietRow.kcal : null,
    todayFoods: dietRow ? dietRow.items : null,
    todaySleepHours: sleepRow ? sleepRow.slept_ok : null
  })
})

// Create session
app.post('/api/sessions', (req, res) => {
  const { name, type, color, date } = req.body
  const d = date || todayIso()
  const r = q('INSERT INTO sessions (date, name, type, color) VALUES (?, ?, ?, ?)').run([d, name || 'Session', type || 'lift', color || '#f4a800'])
  res.json(getSession(r.lastInsertRowid))
})

// Batch log: create session + all exercises + all sets in one call
app.post('/api/log', (req, res) => {
  const { name, type, color, note, date, exercises } = req.body
  const d = date || todayIso()
  const sR = q('INSERT INTO sessions (date, name, type, color, note) VALUES (?, ?, ?, ?, ?)').run([d, name || 'Session', type || 'lift', color || '#f4a800', note || null])
  const sid = sR.lastInsertRowid
  let ord = 0
  for (const ex of (exercises || [])) {
    const eR = q('INSERT INTO exercises (session_id, name, weight_kg, notes, order_idx) VALUES (?, ?, ?, ?, ?)').run([sid, ex.name, ex.weight_kg || null, ex.notes || null, ord++])
    const eid = eR.lastInsertRowid
    let snum = 1
    for (const set of (ex.sets || [])) {
      const reps = parseInt(set.reps) || 0
      const wkg = parseFloat(set.weight_kg) || null
      if (reps > 0) {
        q('INSERT INTO sets (exercise_id, set_num, reps, weight_kg) VALUES (?, ?, ?, ?)').run([eid, snum++, reps, wkg])
      }
    }
    if (ex.note && ex.note.trim()) {
      q('INSERT INTO exercise_notes (name, date, text) VALUES (?, ?, ?)').run([ex.name, d, ex.note.trim()])
    }
  }
  q(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run([sid])
  res.json(getSession(sid))
})

// List sessions. `detail=N` expands the N newest sessions that actually carry sets,
// so the Training page can render one open table without a request per session.
app.get('/api/sessions', (req, res) => {
  const rows = q('SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 200').all([])
  const sessions = rows.map(sessionSummary)
  const detail = Math.min(parseInt(req.query.detail) || 0, 12)
  if (detail) {
    let filled = 0
    for (const s of sessions) {
      if (filled >= detail) break
      if (!s.total_sets) continue
      s.exercises = getSession(s.id).exercises
      filled++
    }
  }
  res.json(sessions)
})

// Get session
app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(+req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  res.json(s)
})

// Delete session
app.delete('/api/sessions/:id', (req, res) => {
  q('DELETE FROM sessions WHERE id = ?').run([+req.params.id])
  res.json({ ok: true })
})

// Body weight
app.post('/api/body-weight', (req, res) => {
  const { date, weight_kg, measured_at } = req.body
  const d = date || todayIso()
  const at = measured_at || new Date().toISOString()
  q(`INSERT INTO body_weight (date, weight_kg, measured_at) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, measured_at = excluded.measured_at`).run([d, weight_kg, at])
  res.json(q('SELECT * FROM body_weight WHERE date = ?').get([d]))
})

app.get('/api/body-weight', (req, res) => {
  res.json(q('SELECT * FROM body_weight ORDER BY date DESC LIMIT 60').all([]))
})

// Steps
app.post('/api/steps', (req, res) => {
  const { date, steps } = req.body
  const d = date || todayIso()
  q('INSERT INTO daily_steps (date, steps) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET steps = excluded.steps').run([d, steps])
  res.json(q('SELECT * FROM daily_steps WHERE date = ?').get([d]))
})

app.get('/api/steps', (req, res) => {
  res.json(q('SELECT * FROM daily_steps ORDER BY date DESC LIMIT 30').all([]))
})

// Diet
app.post('/api/diet', (req, res) => {
  const { date, on_plan, kcal, items } = req.body
  const d = date || todayIso()
  const val = on_plan ? 1 : 0
  q('INSERT INTO daily_diet (date, on_plan) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET on_plan = excluded.on_plan').run([d, val])
  // kcal and items are optional: only overwrite when this call actually carries them
  if (kcal != null) q('UPDATE daily_diet SET kcal = ? WHERE date = ?').run([parseInt(kcal) || 0, d])
  if (items != null) q('UPDATE daily_diet SET items = ? WHERE date = ?').run([String(items), d])
  res.json(q('SELECT date, on_plan, kcal, items FROM daily_diet WHERE date = ?').get([d]))
})

// Add a single food to today's running total, so one meal can be logged at a time
app.post('/api/diet/add', (req, res) => {
  const { date, name, kcal } = req.body
  const d = date || todayIso()
  const add = parseInt(kcal) || 0
  const row = q('SELECT kcal, items FROM daily_diet WHERE date = ?').get([d]) || {}
  const total = (row.kcal || 0) + add
  const items = [row.items, name ? `${name} ${add}` : null].filter(Boolean).join(' · ')
  q(`INSERT INTO daily_diet (date, on_plan, kcal, items) VALUES (?, 0, ?, ?)
     ON CONFLICT(date) DO UPDATE SET kcal = excluded.kcal, items = excluded.items`).run([d, total, items])
  res.json(q('SELECT date, on_plan, kcal, items FROM daily_diet WHERE date = ?').get([d]))
})

// Sleep (stores hours in slept_ok column; 0 = not logged)
app.post('/api/sleep', (req, res) => {
  const { date, hours } = req.body
  const d = date || todayIso()
  const h = parseFloat(hours) || 0
  q('INSERT INTO daily_sleep (date, slept_ok) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET slept_ok = excluded.slept_ok').run([d, h])
  res.json({ date: d, hours: h })
})

app.get('/api/sleep', (req, res) => {
  res.json(q('SELECT date, slept_ok as hours FROM daily_sleep ORDER BY date DESC LIMIT 60').all([]))
})

app.get('/api/diet', (req, res) => {
  res.json(q('SELECT date, on_plan, kcal, items FROM daily_diet ORDER BY date DESC LIMIT 60').all([]))
})

// Combined habits for heatmap (last 84 days = 12 weeks)
app.get('/api/habits', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 84, 365)
  const since = new Date(); since.setDate(since.getDate() - days + 1)
  const sinceStr = localDate(since)
  const sleeps  = q('SELECT date, slept_ok as hours FROM daily_sleep WHERE date >= ?').all([sinceStr])
  const diets   = q('SELECT date, on_plan FROM daily_diet WHERE date >= ?').all([sinceStr])
  const steps   = q('SELECT date, steps FROM daily_steps WHERE date >= ?').all([sinceStr])
  const workouts= q('SELECT DISTINCT date FROM sessions WHERE date >= ?').all([sinceStr])
  const sm = Object.fromEntries(sleeps.map(r => [r.date, r.hours]))
  const dm = Object.fromEntries(diets.map(r => [r.date, r.on_plan]))
  const stm= Object.fromEntries(steps.map(r => [r.date, r.steps]))
  const ws = new Set(workouts.map(r => r.date))
  const result = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const date = localDate(d)
    result.push({ date, sleep_h: sm[date] || 0, diet_ok: dm[date] || 0, steps: stm[date] || 0, workout: ws.has(date) ? 1 : 0 })
  }
  res.json(result)
})

// Runs
app.post('/api/runs', (req, res) => {
  const { date, distance_km, duration_sec, notes, kind } = req.body
  const d = date || todayIso()
  const k = kind || classifyRun(distance_km, duration_sec, notes)
  const r = q('INSERT INTO runs (date, distance_km, duration_sec, notes, kind) VALUES (?, ?, ?, ?, ?)').run([d, distance_km, duration_sec || null, notes || null, k])
  res.json(q('SELECT * FROM runs WHERE id = ?').get([r.lastInsertRowid]))
})

app.get('/api/runs', (req, res) => {
  res.json(q('SELECT * FROM runs ORDER BY date DESC, id DESC LIMIT 60').all([]))
})

app.patch('/api/runs/:id', (req, res) => {
  const { date, distance_km, duration_sec, notes } = req.body
  const run = q('SELECT * FROM runs WHERE id = ?').get([req.params.id])
  if (!run) return res.status(404).json({ error: 'Not found' })
  q('UPDATE runs SET date = ?, distance_km = ?, duration_sec = ?, notes = ? WHERE id = ?').run([
    date ?? run.date, distance_km ?? run.distance_km, duration_sec ?? run.duration_sec, notes ?? run.notes, req.params.id
  ])
  res.json(q('SELECT * FROM runs WHERE id = ?').get([req.params.id]))
})

app.delete('/api/runs/:id', (req, res) => {
  const run = q('SELECT * FROM runs WHERE id = ?').get([req.params.id])
  if (!run) return res.status(404).json({ error: 'Not found' })
  q('DELETE FROM runs WHERE id = ?').run([req.params.id])
  res.json({ deleted: req.params.id })
})

app.get('/api/prs', (req, res) => {
  const since = req.query.since
  const params = []
  let dateFilter = ''
  if (since) { dateFilter = 'AND sess.date >= ?'; params.push(since) }
  res.json(q(`
    SELECT e.name, MAX(s.weight_kg) as best_kg, MAX(s.reps) as best_reps
    FROM sets s
    JOIN exercises e ON e.id = s.exercise_id
    JOIN sessions sess ON sess.id = e.session_id
    WHERE s.weight_kg IS NOT NULL AND s.weight_kg > 0 ${dateFilter}
    GROUP BY LOWER(TRIM(e.name))
    ORDER BY best_kg DESC
  `).all(params))
})

app.patch('/api/sets/:id', (req, res) => {
  const { weight_kg, reps } = req.body
  const updates = []
  const vals = []
  if (weight_kg !== undefined) { updates.push('weight_kg = ?'); vals.push(weight_kg === null ? null : parseFloat(weight_kg)) }
  if (reps !== undefined) { updates.push('reps = ?'); vals.push(parseInt(reps)) }
  if (!updates.length) return res.status(400).json({ error: 'nothing to update' })
  vals.push(+req.params.id)
  q(`UPDATE sets SET ${updates.join(', ')} WHERE id = ?`).run(vals)
  res.json(q('SELECT * FROM sets WHERE id = ?').get([+req.params.id]))
})

// Goals (simple key/value store)
app.get('/api/goals', (req, res) => {
  const rows = q('SELECT key, value FROM goals').all([])
  const obj = {}
  rows.forEach(r => { obj[r.key] = isNaN(r.value) ? r.value : +r.value })
  res.json(obj)
})

app.post('/api/goals', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    q('INSERT INTO goals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run([key, String(value)])
  }
  const rows = q('SELECT key, value FROM goals').all([])
  const obj = {}
  rows.forEach(r => { obj[r.key] = isNaN(r.value) ? r.value : +r.value })
  res.json(obj)
})

// Exercise history (for drawer)
app.get('/api/exercise-history/:name', (req, res) => {
  const name = req.params.name
  const history = q(`
    SELECT s.date, s.name as session_name, e.id as exercise_id,
           e.name as exercise_name, e.weight_kg
    FROM exercises e JOIN sessions s ON s.id = e.session_id
    WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(?))
    ORDER BY s.date DESC LIMIT 10
  `).all([name])
  for (const h of history) {
    h.sets = q('SELECT reps, weight_kg FROM sets WHERE exercise_id = ? ORDER BY set_num').all([h.exercise_id])
  }
  const notes = q('SELECT * FROM exercise_notes WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY date DESC LIMIT 10').all([name])
  const prRow = q('SELECT MAX(s.weight_kg) as best_kg FROM sets s JOIN exercises e ON e.id = s.exercise_id WHERE LOWER(TRIM(e.name)) = LOWER(TRIM(?)) AND s.weight_kg IS NOT NULL').get([name])
  res.json({ history, notes, best_kg: prRow?.best_kg || null })
})

// Lift history for sparklines
app.get('/api/lift-history', (req, res) => {
  res.json(q(`
    SELECT TRIM(e.name) as name, s.date, MAX(st.weight_kg) as max_kg
    FROM sets st
    JOIN exercises e ON e.id = st.exercise_id
    JOIN sessions s ON s.id = e.session_id
    WHERE st.weight_kg IS NOT NULL AND st.weight_kg > 0
    GROUP BY LOWER(TRIM(e.name)), s.date
    ORDER BY s.date ASC
  `).all([]))
})

// ── IMPORT ──────────────────────────────────────────────────────────────────

app.post('/api/import/confirm', (req, res) => {
  const { sessions } = req.body
  if (!Array.isArray(sessions)) return res.status(400).json({ error: 'sessions must be array' })
  let imported = 0, skipped = 0
  for (const s of sessions) {
    try {
      const d = s.date
      if (!d) { skipped++; continue }
      // Dedup: skip if session with same date+type already exists
      const existing = q('SELECT id FROM sessions WHERE date = ? AND type = ?').get([d, s.type || 'lift'])
      if (existing) { skipped++; continue }
      const sR = q('INSERT INTO sessions (date, name, type, color, note) VALUES (?, ?, ?, ?, ?)').run([d, s.name || s.type || 'Session', s.type || 'lift', s.color || '#f4a800', s.note || null])
      const sid = sR.lastInsertRowid
      let ord = 0
      for (const ex of (s.exercises || [])) {
        const eR = q('INSERT INTO exercises (session_id, name, order_idx) VALUES (?, ?, ?)').run([sid, ex.name, ord++])
        const eid = eR.lastInsertRowid
        let snum = 1
        for (const set of (ex.sets || [])) {
          const reps = Math.round(parseFloat(set.reps)) || 0
          const wkg = set.weight_kg != null ? parseFloat(set.weight_kg) : null
          if (reps > 0) q('INSERT INTO sets (exercise_id, set_num, reps, weight_kg) VALUES (?, ?, ?, ?)').run([eid, snum++, reps, wkg])
        }
      }
      q(`UPDATE sessions SET ended_at = datetime('now') WHERE id = ?`).run([sid])
      if (s.bodyweight_kg) {
        q('INSERT OR IGNORE INTO body_weight (date, weight_kg) VALUES (?, ?)').run([d, s.bodyweight_kg])
      }
      imported++
    } catch (e) { skipped++ }
  }
  res.json({ imported, skipped })
})

// Insight notes
app.get('/api/notes', (req, res) => {
  res.json(q('SELECT * FROM insight_notes ORDER BY created_at DESC').all([]))
})

app.post('/api/notes', (req, res) => {
  const { content, category, created_at } = req.body
  if (!content?.trim()) return res.status(400).json({ error: 'content required' })
  // Optional backdate (UTC 'YYYY-MM-DD HH:MM:SS'), for a note about an earlier day.
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created_at || '') ? created_at : null
  const r = q(`INSERT INTO insight_notes (content, category, created_at) VALUES (?, ?, COALESCE(?, datetime('now')))`).run([content.trim(), category || 'general', at])
  res.json(q('SELECT * FROM insight_notes WHERE id = ?').get([r.lastInsertRowid]))
})

app.delete('/api/notes/:id', (req, res) => {
  q('DELETE FROM insight_notes WHERE id = ?').run([req.params.id])
  res.json({ ok: true })
})

// ── GOOGLE HEALTH / FITBIT SYNC ─────────────────────────────────────────────
const { google } = require('googleapis')
const TOKENS_PATH = process.env.FLY_APP_NAME
  ? '/data/.google-tokens.json'
  : path.join(__dirname, '.google-tokens.json')
const GOOGLE_REDIRECT = `${PUBLIC_URL}/auth/google-health/callback`
const CREDS = (process.env.GOOGLE_CLIENT_ID || process.env.FLY_APP_NAME)
  ? { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uris: [GOOGLE_REDIRECT] }
  : (() => {
      // Local patch: Google Health is optional, so start without credentials.
      // An explicit PUBLIC_URL (a root custom domain) replaces the file's redirect.
      try {
        const web = JSON.parse(fs.readFileSync(path.join(__dirname, '.google-credentials.json'))).web
        return process.env.PUBLIC_URL ? { ...web, redirect_uris: [GOOGLE_REDIRECT] } : web
      }
      catch { return { client_id: undefined, client_secret: undefined, redirect_uris: [GOOGLE_REDIRECT] } }
    })()

const oauth2Client = new google.auth.OAuth2(
  CREDS.client_id,
  CREDS.client_secret,
  CREDS.redirect_uris[0]
)

const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
]

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH)) } catch { return null }
}
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2))
}

const savedTokens = loadTokens()
if (savedTokens) oauth2Client.setCredentials(savedTokens)
oauth2Client.on('tokens', t => { saveTokens({ ...loadTokens(), ...t }) })

app.get('/auth/google-health', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' })
  res.redirect(url)
})

app.get('/auth/google-health/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  if (req.query.error || !code) {
    return sendAuth(res, 400, 'Sign-in failed', 'Google did not complete sign-in. You can close this tab and try again.', '/auth/google-health')
  }
  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)
    saveTokens(tokens)
    sendAuth(res, 200, 'Fitbit connected', 'You can close this tab.')
  } catch (e) {
    console.error('OAuth callback error:', e.message)
    sendAuth(res, 400, 'Sign-in failed', 'Fitbit could not be connected. You can close this tab and try again.', '/auth/google-health')
  }
})

// Testing-mode Google Cloud projects expire the refresh token weekly, so "connected"
// is not the same as "working". A recorded sync error, or a last_sync older than the
// 4h auto-sync can explain, both mean the header chip should ask for a reconnect.
const STALE_SYNC_HOURS = 30
function syncStatus(tokens, extra = {}) {
  const connected = !!tokens?.access_token
  const lastSync = tokens?.last_sync || null
  const ageH = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3600000 : null
  const stale = ageH == null || ageH > STALE_SYNC_HOURS
  return {
    connected,
    ok: connected && !tokens?.last_error && !stale,
    last_sync: lastSync,
    stale_hours: ageH == null ? null : Math.round(ageH * 10) / 10,
    last_error: tokens?.last_error || null,
    reconnect_url: extra.reconnect_url || null,
  }
}

app.get('/api/fitbit/status', (req, res) => {
  res.json(syncStatus(loadTokens(), { reconnect_url: '/auth/google-health' }))
})

// Google Health API (v4) — replaces the dead Google Fit REST API.
// Reads Fitbit device data directly: steps + sleep. Weight comes from Withings.
const HEALTH_BASE = 'https://health.googleapis.com/v4'

async function healthGet(pathPart, params) {
  const { token } = await oauth2Client.getAccessToken().then(t => ({ token: t.token || t }))
  const u = new URL(`${HEALTH_BASE}/${pathPart}`)
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v)
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } })
  const j = await r.json()
  if (!r.ok) throw new Error(`Health API ${r.status}: ${JSON.stringify(j.error || j).slice(0, 300)}`)
  return j
}

// Follow nextPageToken until exhausted (capped); returns all dataPoints
async function healthGetAll(pathPart, params, maxPages = 40) {
  const all = []
  let pageToken
  for (let i = 0; i < maxPages; i++) {
    const j = await healthGet(pathPart, pageToken ? { ...params, pageToken } : params)
    all.push(...(j.dataPoints || []))
    pageToken = j.nextPageToken
    if (!pageToken) break
  }
  return all
}

async function fitbitSyncHandler(req, res) {
  const tokens = loadTokens()
  if (!tokens?.access_token) return res.status(401).json({ error: 'Not connected. Visit /auth/google-health first.' })
  oauth2Client.setCredentials(tokens)

  const days = parseInt(req.query.days) || 7
  const startIso = new Date(Date.now() - days * 86400000).toISOString()
  const results = { synced: [], skipped: [] }

  try {
    // Steps: sum interval points per local day. Fitbit platform only —
    // HEALTH_KIT points are the iPhone counting the same walks twice.
    const stepPoints = await healthGetAll('users/me/dataTypes/steps/dataPoints', {
      filter: `steps.interval.start_time >= "${startIso}"`,
    })
    const stepsByDay = {}
    for (const p of stepPoints) {
      if (p.dataSource?.platform !== 'FITBIT') continue
      const s = p.steps
      if (!s) continue
      const date = localDate(s.interval?.startTime || s.sampleTime?.physicalTime)
      stepsByDay[date] = (stepsByDay[date] || 0) + Number(s.count ?? s.value ?? 0)
    }
    // The window's oldest local day is only partially covered by the fetch;
    // writing its partial sum would clobber a stored full-day count.
    const partialDay = localDate(startIso)
    for (const [date, steps] of Object.entries(stepsByDay).sort()) {
      if (date === partialDay) continue
      if (steps > 0) {
        q('INSERT INTO daily_steps (date, steps) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET steps = excluded.steps').run([date, Math.round(steps)])
        results.synced.push(`steps ${date}: ${Math.round(steps)}`)
      }
    }

    // Sleep: sessions credited to wake-up date. The sleep type rejects
    // server-side filters, so fetch unfiltered and window client-side.
    // Google can hold provisional fragments alongside the revised full-night
    // session, so per day: overlapping intervals keep the longest session only,
    // disjoint sessions (night + nap) sum.
    const sleepPoints = await healthGetAll('users/me/dataTypes/sleep/dataPoints', {})
    const windowStart = Date.now() - days * 86400000
    const sleepByDay = {}
    for (const p of sleepPoints) {
      if (p.dataSource?.platform && p.dataSource.platform !== 'FITBIT') continue
      const s = p.sleep
      if (!s?.interval?.endTime) continue
      if (new Date(s.interval.endTime).getTime() < windowStart) continue
      let mins = Number(s.summary?.minutesAsleep ?? s.summary?.minutesInSleepPeriod ?? 0)
      if (!mins && Array.isArray(s.stages)) {
        mins = s.stages
          .filter(st => st.type !== 'AWAKE')
          .reduce((a, st) => a + (new Date(st.endTime) - new Date(st.startTime)) / 60000, 0)
      }
      if (!mins) continue
      const date = localDate(s.interval.endTime)
      ;(sleepByDay[date] = sleepByDay[date] || []).push({
        start: new Date(s.interval.startTime || s.interval.endTime).getTime(),
        end: new Date(s.interval.endTime).getTime(),
        mins,
      })
    }
    for (const [date, sessions] of Object.entries(sleepByDay).sort()) {
      sessions.sort((a, b) => b.mins - a.mins)
      const kept = []
      for (const sess of sessions) {
        if (kept.some(k => sess.start < k.end && k.start < sess.end)) continue
        kept.push(sess)
      }
      const mins = kept.reduce((a, s) => a + s.mins, 0)
      const hours = Math.round((mins / 60) * 10) / 10
      q('INSERT INTO daily_sleep (date, slept_ok) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET slept_ok = excluded.slept_ok').run([date, hours])
      results.synced.push(`sleep ${date}: ${hours}h`)
    }

    // Walks/runs: auto-import Fitbit exercise sessions into the runs table.
    // Skip if a run already exists that day within 0.3km (manual entry wins).
    const exPoints = await healthGetAll('users/me/dataTypes/exercise/dataPoints', {})
    for (const p of exPoints) {
      if (p.dataSource?.platform !== 'FITBIT') continue
      const ex = p.exercise
      if (!ex?.interval?.endTime) continue
      if (!['WALKING', 'RUNNING', 'JOGGING', 'HIKING', 'TREADMILL'].includes(ex.exerciseType)) continue
      if (new Date(ex.interval.endTime).getTime() < windowStart) continue
      const km = Math.round((Number(ex.metricsSummary?.distanceMillimeters || 0) / 1e6) * 100) / 100
      if (km < 0.5) continue
      const date = localDate(ex.interval.endTime)
      const durSec = Math.round(parseFloat(ex.activeDuration || '0'))
      const existing = q('SELECT id, distance_km FROM runs WHERE date = ?').all([date])
      if (existing.some(r => Math.abs((r.distance_km || 0) - km) < 0.3)) continue
      const hr = ex.metricsSummary?.averageHeartRateBeatsPerMinute
      const note = `Auto: ${ex.displayName || ex.exerciseType}${hr ? ` · avg HR ${hr}` : ''}`
      const kind = classifyRun(km, durSec, `${ex.exerciseType} ${ex.displayName || ''}`)
      q('INSERT INTO runs (date, distance_km, duration_sec, notes, avg_hr, kind) VALUES (?, ?, ?, ?, ?, ?)').run([date, km, durSec || null, note, hr ? Math.round(hr) : null, kind])
      results.synced.push(`run ${date}: ${km}km (${ex.exerciseType.toLowerCase()})`)
    }

    // Recovery: daily resting HR + HRV. Needs the health_metrics scope —
    // degrade gracefully until it's granted.
    try {
      const rhrPoints = await healthGetAll('users/me/dataTypes/daily-resting-heart-rate/dataPoints', {})
      const hrvPoints = await healthGetAll('users/me/dataTypes/daily-heart-rate-variability/dataPoints', {})
      const rec = {}
      const pickDate = v => {
        if (v?.date) return `${v.date.year}-${String(v.date.month).padStart(2, '0')}-${String(v.date.day).padStart(2, '0')}`
        const t = v?.interval?.endTime || v?.interval?.startTime || v?.sampleTime?.physicalTime
        return t ? localDate(t) : null
      }
      for (const p of rhrPoints) {
        const v = p.dailyRestingHeartRate
        const date = pickDate(v)
        const bpm = Number(v?.beatsPerMinute ?? v?.value ?? 0)
        if (date && bpm) rec[date] = { ...rec[date], rhr: bpm }
      }
      for (const p of hrvPoints) {
        const v = p.dailyHeartRateVariability
        const date = pickDate(v)
        const ms = Number(v?.averageHeartRateVariabilityMilliseconds ?? v?.rmssdMilliseconds ?? v?.value ?? 0)
        if (date && ms) rec[date] = { ...rec[date], hrv: ms }
      }
      for (const [date, { rhr, hrv }] of Object.entries(rec).sort()) {
        if (new Date(date).getTime() < windowStart - 86400000) continue
        q(`INSERT INTO daily_recovery (date, rhr, hrv_ms) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET rhr = COALESCE(excluded.rhr, rhr), hrv_ms = COALESCE(excluded.hrv_ms, hrv_ms)`).run([date, rhr || null, hrv || null])
        results.synced.push(`recovery ${date}: rhr ${rhr || '-'} hrv ${hrv || '-'}`)
      }
    } catch (e) {
      if (e.message.includes('403')) results.skipped.push('recovery: needs health_metrics scope, re-consent at /auth/google-health')
      else throw e
    }
  } catch (e) {
    saveTokens({ ...loadTokens(), last_error: e.message })
    return res.status(502).json({ error: e.message, hint: 'If scope/permission error: re-consent at /auth/google-health. Inspect raw shapes at /api/health/raw?type=steps' })
  }

  saveTokens({ ...loadTokens(), last_sync: new Date().toISOString(), last_error: null })
  res.json(results)
}

app.post('/api/fitbit/sync', (req, res) => {
  if (!debugEnabled()) return res.status(404).json({ error: 'not found' })
  return fitbitSyncHandler(req, res)
})

app.get('/api/recovery', (req, res) => {
  res.json(q('SELECT date, rhr, hrv_ms FROM daily_recovery ORDER BY date').all([]))
})

// Debug: see the raw Health API response for a data type while we verify shapes
app.get('/api/health/raw', (req, res, next) => {
  if (!debugEnabled()) return res.status(404).json({ error: 'not found' })
  next()
}, async (req, res) => {
  const tokens = loadTokens()
  if (!tokens?.access_token) return res.status(401).json({ error: 'Not connected' })
  oauth2Client.setCredentials(tokens)
  const type = req.query.type || 'steps'
  const days = parseInt(req.query.days) || 2
  const startIso = new Date(Date.now() - days * 86400000).toISOString()
  try {
    const filter = req.query.filter !== undefined
      ? req.query.filter
      : `${type.replace(/-/g, '_')}.interval.start_time >= "${startIso}"`
    const params = filter ? { filter } : {}
    const j = await healthGet(`users/me/dataTypes/${type}/dataPoints`, params)
    res.json(j)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// ── WITHINGS SCALE SYNC ─────────────────────────────────────────────────────
// Weight goes scale → Withings cloud → here, bypassing the Fitbit/Google Fit pipe.
// Needs .withings-credentials.json: {"client_id":"...","client_secret":"..."}
// from a (free) app registered at developer.withings.com with callback
// http://localhost:7779/auth/withings/callback
const W_TOKENS_PATH = process.env.FLY_APP_NAME
  ? '/data/.withings-tokens.json'
  : path.join(__dirname, '.withings-tokens.json')
const W_CREDS_PATH = path.join(__dirname, '.withings-credentials.json')
const W_REDIRECT = `${PUBLIC_URL}/auth/withings/callback` // root host, no /fitlog prefix

function wCreds() {
  if (process.env.WITHINGS_CLIENT_ID) return { client_id: process.env.WITHINGS_CLIENT_ID, client_secret: process.env.WITHINGS_CLIENT_SECRET }
  try { return JSON.parse(fs.readFileSync(W_CREDS_PATH)) } catch { return null }
}
function wLoadTokens() {
  try { return JSON.parse(fs.readFileSync(W_TOKENS_PATH)) } catch { return null }
}
function wSaveTokens(t) { fs.writeFileSync(W_TOKENS_PATH, JSON.stringify(t, null, 2)) }

async function wRequestToken(params) {
  const creds = wCreds()
  const body = new URLSearchParams({ action: 'requesttoken', client_id: creds.client_id, client_secret: creds.client_secret, ...params })
  const r = await fetch('https://wbsapi.withings.net/v2/oauth2', { method: 'POST', body })
  const j = await r.json()
  if (j.status !== 0) throw new Error(`Withings token error (status ${j.status}): ${JSON.stringify(j.error || j)}`)
  return j.body
}

async function wAccessToken() {
  let t = wLoadTokens()
  if (!t?.access_token) throw new Error('Not connected. Visit /auth/withings first.')
  const expired = Date.now() > (t.obtained_at || 0) + ((t.expires_in || 0) - 60) * 1000
  if (expired) {
    const fresh = await wRequestToken({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
    t = { ...t, ...fresh, obtained_at: Date.now() }
    wSaveTokens(t)
  }
  return t.access_token
}

app.get('/auth/withings', (req, res) => {
  const creds = wCreds()
  if (!creds) return res.send('<h2>Missing Withings credentials</h2><p>Create .withings-credentials.json with {"client_id":"...","client_secret":"..."} from developer.withings.com</p>')
  const u = new URL('https://account.withings.com/oauth2_user/authorize2')
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', creds.client_id)
  u.searchParams.set('scope', 'user.metrics')
  u.searchParams.set('redirect_uri', W_REDIRECT)
  u.searchParams.set('state', 'fitlog')
  res.redirect(u.toString())
})

app.get('/auth/withings/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  if (req.query.error || !code) {
    return sendAuth(res, 400, 'Sign-in failed', 'Withings did not complete sign-in. You can close this tab and try again.', '/auth/withings')
  }
  try {
    const t = await wRequestToken({ grant_type: 'authorization_code', code, redirect_uri: W_REDIRECT })
    wSaveTokens({ ...t, obtained_at: Date.now() })
    sendAuth(res, 200, 'Withings connected', 'You can close this tab.')
  } catch (e) {
    console.error('Withings callback error:', e.message)
    sendAuth(res, 400, 'Sign-in failed', 'Withings could not be connected. You can close this tab and try again.', '/auth/withings')
  }
})

app.get('/api/withings/status', (req, res) => {
  res.json(syncStatus(wLoadTokens(), { reconnect_url: '/auth/withings' }))
})

app.post('/api/withings/sync', (req, res, next) => {
  if (!debugEnabled()) return res.status(404).json({ error: 'not found' })
  next()
}, async (req, res) => {
  try {
    const token = await wAccessToken()
    const days = parseInt(req.query.days) || 14
    const now = Math.floor(Date.now() / 1000)
    const body = new URLSearchParams({
      action: 'getmeas', meastype: '1', category: '1',
      startdate: String(now - days * 86400), enddate: String(now),
    })
    const r = await fetch('https://wbsapi.withings.net/measure', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
    })
    const j = await r.json()
    if (j.status !== 0) return res.status(502).json({ error: `Withings API status ${j.status}`, detail: j.error || j })

    // one reading per day: the earliest (the fasted morning weigh-in is the canonical number)
    const byDate = {}
    for (const g of (j.body?.measuregrps || [])) {
      const m = (g.measures || []).find(x => x.type === 1)
      if (!m) continue
      const date = localDate(g.date * 1000)
      if (!byDate[date] || g.date < byDate[date].ts) {
        byDate[date] = { ts: g.date, kg: Math.round(m.value * Math.pow(10, m.unit) * 10) / 10 }
      }
    }
    const synced = []
    for (const [date, { kg, ts }] of Object.entries(byDate).sort()) {
      const at = new Date(ts * 1000).toISOString()
      q(`INSERT INTO body_weight (date, weight_kg, measured_at) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, measured_at = excluded.measured_at`).run([date, kg, at])
      synced.push(`${date}: ${kg}kg`)
    }
    wSaveTokens({ ...wLoadTokens(), last_sync: new Date().toISOString(), last_error: null })
    res.json({ synced })
  } catch (e) {
    try { wSaveTokens({ ...wLoadTokens(), last_error: e.message }) } catch { /* no token file yet */ }
    res.status(e.message.includes('Not connected') ? 401 : 500).json({ error: e.message })
  }
})

// ── DEV ONLY ────────────────────────────────────────────────────────────────
if (!process.env.FLY_APP_NAME) {
  app.post('/api/dev/sync-prod', (req, res) => {
    if (!debugEnabled()) return res.status(404).json({ error: 'not found' })
    res.json({ ok: true })
    setTimeout(() => {
      try {
        const backup = dbPath + '.bak'
        if (fs.existsSync(backup)) fs.unlinkSync(backup)
        fs.renameSync(dbPath, backup)
        if (!FLY_APP) throw new Error('no Fly app configured (fly.toml or FLY_APP)')
        execSync(`flyctl ssh sftp get /data/fitness.db ${dbPath} --app ${FLY_APP}`, { stdio: 'inherit' })
        console.log('prod DB synced, restarting...')
      } catch (e) {
        console.error('sync failed:', e.message)
      }
      spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: 'inherit' }).unref()
      process.exit(0)
    }, 200)
  })
}

app.listen(PORT, '0.0.0.0', () => console.log(`fitness on http://0.0.0.0:${PORT}`))

// Google delivers Fitbit data late and revises it after the fact; re-syncing
// every 4h lets the upserts self-heal without a manual /daily run.
setInterval(() => {
  const fakeRes = {
    status() { return this },
    json(j) { console.log(`auto-sync: ${(j.synced || []).length} updates${j.error ? ` (${j.error})` : ''}`) },
  }
  Promise.resolve(fitbitSyncHandler({ query: { days: '3' } }, fakeRes))
    .catch(e => console.log('auto-sync failed:', e.message))
}, 4 * 3600 * 1000)
