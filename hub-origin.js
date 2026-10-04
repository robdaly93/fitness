// The only origin embed mode may postMessage to, or accept fitlog:tab from.
// A bare https origin, or http://localhost / http://127.0.0.1 (optional port) for dev.
// Anything else, including '*', a path, or fitlog's own origin, is not a target.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.HubOrigin = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hubOrigin(value) {
    if (typeof value !== 'string') return null
    const raw = value.trim()
    if (!raw || raw === '*') return null
    let url
    try { url = new URL(raw) } catch { return null }
    if (url.username || url.password) return null
    if (url.search || url.hash) return null
    if (url.pathname !== '/') return null
    if (url.origin !== raw) return null
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    if (url.protocol !== 'https:' && !local) return null
    return url.origin
  }

  // Null when unset, invalid, or the same origin as this page.
  function messageTarget(hub, selfOrigin) {
    const origin = hubOrigin(hub)
    if (!origin || origin === selfOrigin) return null
    return origin
  }

  return { hubOrigin, messageTarget }
})
