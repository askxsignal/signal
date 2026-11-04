// Single-process host for the VPS: routes requests to the Netlify-style handlers and serves dist/.
// Run from the repo root (nft.mjs reads netlify/fonts and the resvg wasm relative to cwd).
// nginx sits in front: TLS, rate limits, /nft/* cache, X-Real-IP.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import api from './netlify/functions/api.mjs'
import nft from './netlify/functions/nft.mjs'
import authStart from './netlify/functions/auth-start.mjs'
import authCallback from './netlify/functions/auth-callback.mjs'

const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '127.0.0.1'
const DIST = path.resolve('dist')
const MAX_BODY = 256 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
}

function route(p) {
  if (p.startsWith('/api/nft/') || p.startsWith('/nft/')) return nft
  if (p === '/api' || p.startsWith('/api/')) return api
  if (p === '/auth/x/start' || p === '/auth/x/start/') return authStart
  if (p === '/auth/x/callback' || p === '/auth/x/callback/') return authCallback
  return null
}

function clientIp(req) {
  return req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || ''
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

async function runHandler(handler, req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'http'
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`
  const url = `${proto}://${host}${req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v != null) headers.set(k, v)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const request = new Request(url, { method: req.method, headers, body: hasBody ? await readBody(req) : undefined })
  const response = await handler(request, { ip: clientIp(req) })

  const out = {}
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) out['set-cookie'] = cookies
  // On Netlify this header drove the CDN; nginx caches /nft/* by Cache-Control instead.
  delete out['netlify-cdn-cache-control']
  res.writeHead(response.status, out)
  if (!response.body || req.method === 'HEAD') return res.end()
  Readable.fromWeb(response.body).pipe(res)
}

function serveStatic(req, res, pathname) {
  let rel
  try { rel = decodeURIComponent(pathname) } catch { rel = '/' }
  let file = path.join(DIST, path.normalize(rel))
  if (!file.startsWith(DIST)) file = DIST
  let stat = null
  try { stat = fs.statSync(file) } catch {}
  if (stat?.isDirectory()) { file = path.join(file, 'index.html'); try { stat = fs.statSync(file) } catch { stat = null } }
  const isAsset = pathname.startsWith('/assets/')
  if (!stat) {
    // Missing hashed assets must 404, not fall back to HTML.
    if (isAsset || path.extname(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
    file = path.join(DIST, 'index.html')
    stat = fs.statSync(file)
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const cache = isAsset ? 'public, max-age=31536000, immutable' : file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': cache })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  const pathname = (req.url || '/').split('?')[0]
  try {
    const handler = route(pathname)
    if (handler) return await runHandler(handler, req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
    serveStatic(req, res, pathname)
  } catch (e) {
    console.error(new Date().toISOString(), req.method, pathname, e)
    if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.status === 413 ? 'too_large' : 'server_error' }))
  }
})

server.requestTimeout = 60_000
server.listen(PORT, HOST, () => console.log(`signal listening on http://${HOST}:${PORT}`))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
