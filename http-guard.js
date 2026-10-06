// Shared by the server and the tests. No I/O.

function publicOrigin(env = process.env) {
  const raw = env.PUBLIC_URL
    || (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : `http://localhost:${env.PORT || 7779}`)
  return String(raw).replace(/\/+$/, '')
}

function oauthCallback(origin, path) {
  return `${origin}${path}`
}

// FRAME_ANCESTORS is a CSP source list. Bare self/none gain quotes.
// Default is 'self' so a stock install is not frameable by other origins.
function frameAncestorsDirective(value) {
  const raw = (value == null || String(value).trim() === '') ? "'self'" : String(value).trim()
  return raw.split(/\s+/).map(tok => (tok === 'self' || tok === 'none') ? `'${tok}'` : tok).join(' ')
}

// Destructive and raw-debug routes stay off unless FITLOG_DEBUG=1.
// Localhost is not enough: a proxy on the same machine would look local.
function debugEnabled(env = process.env) {
  return env.FITLOG_DEBUG === '1'
}

module.exports = { publicOrigin, oauthCallback, frameAncestorsDirective, debugEnabled }
