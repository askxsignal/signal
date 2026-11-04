// GET /auth/x/start?ref=CODE&return=/path — send the user to X to sign in (OAuth 2.0 with PKCE).
import { createHash, randomBytes } from 'node:crypto'
import { CALLBACK_PATH, OAUTH_COOKIE, missingEnv, redirect, safeReturn, seal, setCookie, siteOrigin, xClient } from '../lib/server.mjs'

export default async (req) => {
  if (missingEnv().length) return redirect(`${siteOrigin(req)}/?auth=error&reason=config`)
  const params = new URL(req.url).searchParams
  const state = randomBytes(16).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const ref = (params.get('ref') ?? '').slice(0, 40) || null

  const url = new URL('https://x.com/i/oauth2/authorize')
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: xClient().id,
    redirect_uri: `${siteOrigin(req)}${CALLBACK_PATH}`,
    scope: 'users.read tweet.read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()

  // State, PKCE verifier, invite code and return path travel in a signed, short-lived cookie.
  const cookie = seal({ state, verifier, ref, ret: safeReturn(params.get('return')) }, 600)
  return redirect(url.toString(), [setCookie(req, OAUTH_COOKIE, cookie, 600)])
}

export const config = {
  path: '/auth/x/start',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
