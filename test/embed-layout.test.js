const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')

test('embed pages have no side inset, and the log pair can shrink', () => {
  assert.match(html, /html\.embed #view-today,\s*html\.embed #view-training,\s*html\.embed #view-goals,\s*html\.embed #view-notes\{ padding-left:0; padding-right:0 \}/)
  assert.match(html, /@media \(max-width:480px\)\{[\s\S]*padding-left:0; padding-right:0/)
  assert.match(html, /@media \(max-width:480px\)\{[\s\S]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[\s\S]*html\.embed \.pillar\{ min-width:0 \}/)
  assert.equal(/html\.embed \.pillars\.two\{ grid-template-columns:1fr 1fr \}/.test(html), false)
})

test('embed height is posted after render, resize, and tab change', () => {
  assert.match(html, /new ResizeObserver\(\(\) => postHeight\(\)\)\.observe\(document\.body\)/)
  assert.match(html, /window\.addEventListener\('resize', postHeight\)/)
  assert.match(html, /function render\(\) \{[\s\S]*postHeight\(\)/)
  assert.match(html, /function setTab\(t, pushHash = true\) \{[\s\S]*postHeight\(\)/)
  assert.match(html, /postMessage\(\{ type:'fitlog:height', height \}, target\)/)
})

test('Styku values are amber and kilograms come from the stored pounds', () => {
  assert.match(html, /html\.embed \.scan-row b\{[^}]*color:var\(--gold\)/)
  assert.match(html, /WeightUnits\.kgFromLb\(s\.weightLb\)/)
  assert.match(html, /WeightUnits\.kgFromLb\(s\.leanLb\)/)
  assert.match(html, /id="g-styku-date"/)
  assert.match(html, /id="g-styku-bf"/)
  assert.match(html, /id="g-styku-lb"/)
  assert.match(html, /id="g-styku-lean"/)
  assert.match(html, /numField\('g-styku-bf', 'styku_bf_pct'\)/)
  assert.match(html, /numField\('g-styku-lb', 'styku_weight_lb'\)/)
  assert.match(html, /numField\('g-styku-lean', 'styku_lean_lb'\)/)
  assert.match(html, /dateField\('g-styku-date', 'styku_date'\)/)
})
