// Shared helpers for the Netlify functions: signed cookies, Supabase admin client, JSON replies, CSRF.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const PREFIX = 'signal'
export const SESSION_COOKIE = `${PREFIX}_session`
export const OAUTH_COOKIE = `${PREFIX}_oauth`
export const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days
// Sessions from the old typed-handle sign-in carry no version: they are no longer accepted, so
// everyone signs in again through X.
const SESSION_VERSION = 2
// Must match the Callback URI registered in the X app, character for character.
export const CALLBACK_PATH = '/auth/x/callback'

const REQUIRED = ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
export const missingEnv = () =>
  REQUIRED.filter((k) => !process.env[k]).concat(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32 ? ['SESSION_SECRET(>=32 chars)'] : [])
export const optionalMissing = () => (process.env.MODEL_API_KEY && process.env.MODEL_BASE_URL ? [] : ['MODEL_BASE_URL', 'MODEL_API_KEY'])

const env = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`Missing environment variable ${name}`)
  return v
}

export const xClient = () => ({ id: env('X_CLIENT_ID'), secret: env('X_CLIENT_SECRET') })

let client
// Service-role client: only ever used on the server.
export const admin = () =>
  (client ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } }))

const sign = (body) => createHmac('sha256', env('SESSION_SECRET')).update(body).digest('base64url')

/** Keyed hash for values we must recognise but never store raw (device tokens, IPs). */
export const keyed = (kind, value) => createHmac('sha256', env('SESSION_SECRET')).update(`${kind}:${value}`).digest('base64url').slice(0, 32)

/** Pack a payload into a tamper-proof, expiring token: base64url(json).hmac */
export function seal(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url')
  return `${body}.${sign(body)}`
}

export function unseal(token) {
  if (!token) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    return payload.exp > Date.now() / 1000 ? payload : null
  } catch {
    return null
  }
}

export function readCookie(req, name) {
  const header = req.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

/** Public origin. SITE_URL wins (custom domains); else https, except on localhost/127.0.0.1. */
export function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '')
  const { host, hostname, protocol } = new URL(req.url)
  const local = hostname === 'localhost' || hostname === '127.0.0.1'
  return `${local ? protocol : 'https:'}//${host}`
}

const secure = (req) => (siteOrigin(req).startsWith('https:') ? '; Secure' : '')
export const setCookie = (req, name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req)}`
export const clearCookie = (req, name) => setCookie(req, name, '', 0)

/** A session cookie for a signed-in uid. */
export const sessionCookie = (req, uid) => setCookie(req, SESSION_COOKIE, seal({ uid, v: SESSION_VERSION }, SESSION_TTL), SESSION_TTL)

/** The signed-in user ({ uid }) or null. */
export const session = (req) => {
  const s = unseal(readCookie(req, SESSION_COOKIE))
  return s && s.v === SESSION_VERSION ? s : null
}

/** Only same-site relative paths ("/x", not "//evil.com"). */
export const safeReturn = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/')

/**
 * Mutations must come from our own pages. A JSON body forces a CORS preflight for any other site,
 * and the Origin host must be ours (www or not).
 */
export function sameOrigin(req) {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return false
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.get('origin')
  if (!origin) return true
  const bare = (h) => h.replace(/^www\./, '')
  try {
    const host = bare(new URL(origin).hostname)
    const ours = [new URL(req.url).hostname, process.env.URL && new URL(process.env.URL).hostname, process.env.SITE_URL && new URL(process.env.SITE_URL).hostname]
      .filter(Boolean)
      .map(bare)
    return ours.includes(host)
  } catch {
    return false
  }
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })

export function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' })
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(null, { status: 302, headers })
}
