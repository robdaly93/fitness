const test = require('node:test')
const assert = require('node:assert/strict')
const { paceLines, lbFromKg, kgFromLb } = require('../weight-units')

// Raw weekly of -1.05 kg/wk. The chip prints 1.1 because toFixed(1) rounds
// 1.05 up. The old pound line used the raw 1.05: 1.05 * 2.20462 = 2.31485,
// which prints 2.3. The printed kilogram is 1.1, and 1.1 * 2.20462 = 2.425,
// which prints 2.4.
test('pace pounds follow the rounded kilogram, not the raw rate', () => {
  const pace = paceLines(-1.05)
  assert.equal(pace.raw, -1.05)
  assert.equal(pace.kg, 1.1)
  assert.equal(pace.kgText, '↓ 1.1 KG/WK')
  assert.equal(pace.lbText, '2.4 LB/WK')
  assert.equal(pace.lb, '2.4')
})

test('a rate that is already one decimal is unchanged', () => {
  const pace = paceLines(-1.1)
  assert.equal(pace.kgText, '↓ 1.1 KG/WK')
  assert.equal(pace.lbText, '2.4 LB/WK')
})

test('body-weight pounds use the kilograms that are printed', () => {
  assert.equal(lbFromKg(88.8), '195.8')
  assert.equal(lbFromKg(106), '233.7')
  assert.equal(lbFromKg(17.24), lbFromKg(17.2))
})

test('example scan pounds convert to the kilograms on the scan row', () => {
  assert.equal(kgFromLb(180.0), '81.6')
  assert.equal(kgFromLb(135.0), '61.2')
})
