const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { kgFromLb } = require('../weight-units')

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function start(port) {
  const db = `/tmp/fitlog-styku-${port}.db`
  try { fs.rmSync(db, { force: true }) } catch { /* fresh */ }
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
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

test('POST /api/goals stores the four Styku fields and GET returns them', async (t) => {
  const proc = await start(7799)
  t.after(() => new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGTERM'); setTimeout(resolve, 1500) }))

  const payload = {
    styku_date: '2000-01-01',
    styku_bf_pct: 25.0,
    styku_weight_lb: 180.0,
    styku_lean_lb: 135.0,
  }
  const saved = await request(7799, 'POST', '/api/goals', payload)
  assert.equal(saved.status, 200)
  const wrote = JSON.parse(saved.body)
  assert.equal(wrote.styku_date, '2000-01-01')
  assert.equal(wrote.styku_bf_pct, 25)
  assert.equal(wrote.styku_weight_lb, 180)
  assert.equal(wrote.styku_lean_lb, 135)

  const got = await request(7799, 'GET', '/api/goals')
  assert.equal(got.status, 200)
  assert.deepEqual(JSON.parse(got.body), wrote)
  assert.equal(kgFromLb(wrote.styku_weight_lb), '81.6')
  assert.equal(kgFromLb(wrote.styku_lean_lb), '61.2')
})
