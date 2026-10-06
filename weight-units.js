// Kilograms and pounds share one rounding, so a figure and the line under it
// cannot disagree. The browser gets this via a plain script tag; Node tests
// require it.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.WeightUnits = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LB_PER_KG = 2.20462

  // The number of kilograms actually printed: one decimal, half-up via toFixed.
  function displayedKg(kg) {
    const n = Math.abs(parseFloat(kg))
    if (!Number.isFinite(n)) return null
    return Number(n.toFixed(1))
  }

  function lbFromKg(kg) {
    const shown = displayedKg(kg)
    if (shown == null) return null
    return (shown * LB_PER_KG).toFixed(1)
  }

  function kgFromLb(lb) {
    const n = Math.abs(parseFloat(lb))
    if (!Number.isFinite(n)) return null
    const shownLb = Number(n.toFixed(1))
    return (shownLb / LB_PER_KG).toFixed(1)
  }

  // Pace chip. Both lines come from the kilograms the chip prints, not the raw rate.
  function paceLines(weeklyKg) {
    const raw = parseFloat(weeklyKg)
    if (!Number.isFinite(raw)) return null
    const kg = displayedKg(raw)
    const arrow = raw < 0 ? '↓' : raw > 0 ? '↑' : '='
    return {
      raw,
      kg,
      lb: (kg * LB_PER_KG).toFixed(1),
      kgText: `${arrow} ${kg.toFixed(1)} KG/WK`,
      lbText: `${(kg * LB_PER_KG).toFixed(1)} LB/WK`,
    }
  }

  return { LB_PER_KG, displayedKg, lbFromKg, kgFromLb, paceLines }
})
