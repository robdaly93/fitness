const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')
const { publicOrigin, oauthCallback, frameAncestorsDirective, debugEnabled } = require('../http-guard')

function req(port, method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    r.on('error', reject)
    r.end()
  })
}

function startServer(port, extraEnv) {
  const db = `/tmp/fitlog-sec-${port}.db`
  for (const suffix of ['', '.lock', '-wal', '-shm']) {
    try { fs.rmSync(db + suffix, { recursive: true, force: true }) } catch { /* fresh */ }
  }
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: db,
      FITLOG_DEBUG: '',
      FRAME_ANCESTORS: '',
      PUBLIC_URL: '',
      FLY_APP_NAME: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server ${port} did not start`)), 10000)
    let log = ''
    const onData = buf => {
      log += buf.toString()
      if (log.includes('fitness on')) {
        clearTimeout(timer)
        resolve({ proc, db })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`server ${port} exited ${code}: ${log}`))
    })
  })
}

async function stop(proc) {
  if (!proc || proc.killed) return
  proc.kill('SIGTERM')
  await new Promise(resolve => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 1500)
    proc.on('exit', () => { clearTimeout(t); resolve() })
  })
}

test('public origin is the root host, with no trailing slash and no /fitlog path', () => {
  assert.equal(publicOrigin({ PUBLIC_URL: 'https://fitlog.example.com/' }), 'https://fitlog.example.com')
  assert.equal(publicOrigin({ PUBLIC_URL: 'https://fitlog.example.com' }), 'https://fitlog.example.com')
  assert.equal(
    oauthCallback(publicOrigin({ PUBLIC_URL: 'https://fitlog.example.com/' }), '/auth/google-health/callback'),
    'https://fitlog.example.com/auth/google-health/callback'
  )
  assert.equal(
    oauthCallback(publicOrigin({ PUBLIC_URL: 'https://fitlog.example.com' }), '/auth/withings/callback'),
    'https://fitlog.example.com/auth/withings/callback'
  )
  assert.equal(publicOrigin({ FLY_APP_NAME: 'fitlog', PORT: '7779' }), 'https://fitlog.fly.dev')
})

test('frame-ancestors defaults to self and quotes bare keywords', () => {
  assert.equal(frameAncestorsDirective(undefined), "'self'")
  assert.equal(frameAncestorsDirective(''), "'self'")
  assert.equal(frameAncestorsDirective('self'), "'self'")
  assert.equal(frameAncestorsDirective('https://hub.example.com'), 'https://hub.example.com')
  assert.equal(debugEnabled({}), false)
  assert.equal(debugEnabled({ FITLOG_DEBUG: '1' }), true)
})

test('oauth callbacks do not reflect query values, and security headers are set', async (t) => {
  const { proc } = await startServer(7791, { FRAME_ANCESTORS: 'https://hub.example.com' })
  t.after(() => stop(proc))

  const payloads = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
  ]
  for (const payload of payloads) {
    for (const path of [
      `/auth/google-health/callback?error=${encodeURIComponent(payload)}`,
      `/auth/withings/callback?error=${encodeURIComponent(payload)}`,
      `/auth/google-health/callback?code=${encodeURIComponent(payload)}`,
      `/auth/withings/callback?code=${encodeURIComponent(payload)}`,
    ]) {
      const res = await req(7791, 'GET', path)
      assert.equal(res.status, 400, path)
      assert.match(res.headers['content-type'], /text\/html/)
      assert.equal(res.body.includes(payload), false, path)
      assert.equal(res.body.toLowerCase().includes('<script'), false, path)
      assert.equal(res.body.toLowerCase().includes('onerror'), false, path)
      assert.match(res.body, /Sign-in failed/)
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.match(res.headers['content-security-policy'], /frame-ancestors https:\/\/hub\.example\.com/)
    }
  }

  const today = await req(7791, 'GET', '/api/today')
  assert.equal(today.status, 200)
  assert.equal(today.headers['x-content-type-options'], 'nosniff')
  assert.match(today.headers['content-security-policy'], /frame-ancestors https:\/\/hub\.example\.com/)
})

test('default CSP is frame-ancestors self', async (t) => {
  const { proc } = await startServer(7792, {})
  t.after(() => stop(proc))
  const res = await req(7792, 'GET', '/api/goals')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'self'/)
})

test('dev and raw routes are 404 unless FITLOG_DEBUG=1; sync POSTs stay open', async (t) => {
  const off = await startServer(7793, {})
  t.after(() => stop(off.proc))
  const on = await startServer(7794, { FITLOG_DEBUG: '1' })
  t.after(() => stop(on.proc))

  for (const [method, path] of [
    ['POST', '/api/dev/sync-prod'],
    ['GET', '/api/health/raw'],
    ['GET', '/api/health/raw?type=steps'],
  ]) {
    const blocked = await req(7793, method, path)
    assert.equal(blocked.status, 404, `${method} ${path} should be hidden`)
    assert.equal(fs.existsSync(off.db), true)
  }

  for (const [method, path] of [
    ['POST', '/api/fitbit/sync'],
    ['POST', '/api/withings/sync'],
  ]) {
    const open = await req(7793, method, path)
    assert.notEqual(open.status, 404, `${method} ${path} should not require FITLOG_DEBUG`)
  }

  const raw = await req(7794, 'GET', '/api/health/raw')
  assert.equal(raw.status, 401)
  const sync = await req(7794, 'POST', '/api/fitbit/sync')
  assert.equal(sync.status, 401)
  const withings = await req(7793, 'POST', '/api/withings/sync')
  assert.equal(withings.status, 401)
  const today = await req(7793, 'GET', '/api/today')
  assert.equal(today.status, 200)
  const status = await req(7793, 'GET', '/api/fitbit/status')
  assert.equal(status.status, 200)
})
