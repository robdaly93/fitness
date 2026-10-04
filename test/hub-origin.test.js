const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { hubOrigin, messageTarget } = require('../hub-origin')

test('hub origin is a bare https origin or http localhost', () => {
  assert.equal(hubOrigin('https://hub.example.com'), 'https://hub.example.com')
  assert.equal(hubOrigin('https://hub.example.com:8443'), 'https://hub.example.com:8443')
  assert.equal(hubOrigin('http://localhost'), 'http://localhost')
  assert.equal(hubOrigin('http://localhost:4321'), 'http://localhost:4321')
  assert.equal(hubOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
  assert.equal(hubOrigin('  https://hub.example.com  '), 'https://hub.example.com')

  for (const bad of [
    undefined, null, '', '*',
    'https://hub.example.com/',
    'https://hub.example.com/fitlog',
    'https://hub.example.com?x=1',
    'https://user:pass@hub.example.com',
    'http://hub.example.com',
    'http://evil.example',
    'javascript:alert(1)',
    '<script>alert(1)</script>',
  ]) {
    assert.equal(hubOrigin(bad), null, String(bad))
  }
})

test('postMessage target is never star and never this page origin', () => {
  assert.equal(messageTarget('https://hub.example.com', 'https://fitlog.example.com'), 'https://hub.example.com')
  assert.equal(messageTarget('https://fitlog.example.com', 'https://fitlog.example.com'), null)
  assert.equal(messageTarget('*', 'https://fitlog.example.com'), null)
  assert.equal(messageTarget('', 'https://fitlog.example.com'), null)
  assert.equal(messageTarget('http://localhost:4321', 'http://localhost:7779'), 'http://localhost:4321')
})

test('the page posts height to the configured target and checks the same origin', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /postMessage\(\{ type:'fitlog:height', height \}, target\)/)
  assert.equal(/postMessage\([^)]*location\.origin/.test(html), false)
  assert.equal(/postMessage\([^)]*'\*'/.test(html), false)
  assert.match(html, /e\.origin !== target/)
})

function req(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

function start(port, hub) {
  const db = `/tmp/fitlog-hub-${port}.db`
  try { fs.rmSync(db, { force: true }) } catch { /* fresh */ }
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: db,
      FITLOG_DEBUG: '',
      PUBLIC_URL: '',
      FLY_APP_NAME: '',
      HUB_ORIGIN: hub,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000)
    let log = ''
    proc.stdout.on('data', buf => {
      log += buf.toString()
      if (log.includes('fitness on')) { clearTimeout(timer); resolve(proc) }
    })
    proc.stderr.on('data', buf => { log += buf.toString() })
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${log}`)) })
  })
}

async function stop(proc) {
  proc.kill('SIGTERM')
  await new Promise(resolve => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 1500)
    proc.on('exit', () => { clearTimeout(t); resolve() })
  })
}

test('GET /api/config returns the validated origin and hides invalid values', async (t) => {
  const good = await start(7795, 'https://hub.example.com')
  const bad = await start(7796, 'https://hub.example.com/<script>')
  const local = await start(7797, 'http://localhost:4321')
  const unset = await start(7798, '')
  t.after(async () => { await stop(good); await stop(bad); await stop(local); await stop(unset) })

  const ok = await req(7795, '/api/config')
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), { hubOrigin: 'https://hub.example.com' })

  const hidden = await req(7796, '/api/config')
  assert.equal(hidden.status, 200)
  assert.deepEqual(JSON.parse(hidden.body), { hubOrigin: null })
  assert.equal(hidden.body.includes('<script'), false)
  assert.equal(hidden.body.includes('hub.example.com/<script>'), false)

  const dev = await req(7797, '/api/config')
  assert.deepEqual(JSON.parse(dev.body), { hubOrigin: 'http://localhost:4321' })

  const none = await req(7798, '/api/config')
  assert.deepEqual(JSON.parse(none.body), { hubOrigin: null })
})
