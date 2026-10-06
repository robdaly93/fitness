const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const root = path.join(__dirname, '..')

function req(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

function start(port) {
  const db = `/tmp/fitlog-static-${port}.db`
  try { fs.rmSync(db, { force: true }) } catch { /* fresh */ }
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: db, FITLOG_DEBUG: '', PUBLIC_URL: '', FLY_APP_NAME: '', HUB_ORIGIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000)
    let log = ''
    proc.stdout.on('data', buf => {
      log += buf.toString()
      if (log.includes('fitness on')) { clearTimeout(timer); resolve(proc) }
    })
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${log}`)) })
  })
}

test('only the page files are served; the database and source are not', async (t) => {
  const secretPath = path.join(root, '.env')
  const hadEnv = fs.existsSync(secretPath)
  const previous = hadEnv ? fs.readFileSync(secretPath) : null
  fs.writeFileSync(secretPath, 'SECRET-SHOULD-NOT-LEAK\n')
  let proc
  t.after(async () => {
    if (proc) {
      proc.kill('SIGTERM')
      await new Promise(resolve => { const timer = setTimeout(resolve, 1500); proc.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
    if (hadEnv) fs.writeFileSync(secretPath, previous)
    else fs.rmSync(secretPath, { force: true })
  })
  proc = await start(7801)

  for (const urlPath of ['/', '/index.html', '/weight-units.js', '/hub-origin.js', '/favicon.svg']) {
    const res = await req(7801, urlPath)
    assert.equal(res.status, 200, urlPath)
  }
  const page = await req(7801, '/')
  assert.match(page.body, /FITLOG/)

  for (const urlPath of ['/fitness.db', '/server.js', '/CLAUDE.md', '/package.json', '/.env', '/README.md']) {
    const res = await req(7801, urlPath)
    assert.equal(res.status, 404, urlPath)
    assert.equal(res.body.includes('SECRET-SHOULD-NOT-LEAK'), false, urlPath)
  }

  const today = await req(7801, '/api/today')
  assert.equal(today.status, 200)
})
