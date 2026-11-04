// GET /auth/x/callback — exchange the code, read the X profile, create/refresh the account, start a session.
// The X token is used once to learn who signed in, then revoked. Nothing from X is stored but the profile.
import { CALLBACK_PATH, OAUTH_COOKIE, admin, clearCookie, readCookie, redirect, sessionCookie, siteOrigin, unseal, xClient } from '../lib/server.mjs'

const MIN_AGE_DAYS = Number(process.env.X_MIN_ACCOUNT_AGE_DAYS ?? 0)

export default async (req) => {
  const url = new URL(req.url)
  const fail = (reason) => redirect(`${siteOrigin(req)}/?auth=error&reason=${reason}`, [clearCookie(req, OAUTH_COOKIE)])

  const saved = unseal(readCookie(req, OAUTH_COOKIE))
  const code = url.searchParams.get('code')
  if (url.searchParams.get('error')) return fail('cancelled')
  if (!saved) return fail('expired')
  if (!code || url.searchParams.get('state') !== saved.state) return fail('state')

  try {
    const { id, secret } = xClient()
    const basic = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
    const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${siteOrigin(req)}${CALLBACK_PATH}`,
        code_verifier: saved.verifier,
        client_id: id,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!tokenRes.ok) {
      console.error('X token exchange failed', tokenRes.status, await tokenRes.text())
      return fail('token')
    }
    const { access_token } = await tokenRes.json()

    const meRes = await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url,created_at,public_metrics', {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!meRes.ok) {
      console.error('X profile request failed', meRes.status, await meRes.text())
      return fail(meRes.status === 429 ? 'x_busy' : 'profile')
    }
    const { data: x } = await meRes.json()

    // We only needed the token to learn who signed in.
    fetch('https://api.x.com/2/oauth2/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic },
      body: new URLSearchParams({ token: access_token, token_type_hint: 'access_token', client_id: id }),
    }).catch(() => {})

    if (MIN_AGE_DAYS > 0 && x.created_at && Date.now() - Date.parse(x.created_at) < MIN_AGE_DAYS * 864e5) return fail('too_new')

    const { data: uid, error } = await admin().rpc('upsert_x_user', {
      p_x_id: x.id,
      p_username: x.username,
      p_name: x.name ?? x.username,
      p_avatar: x.profile_image_url?.replace('_normal', '_200x200') ?? null,
      p_x_created_at: x.created_at ?? null,
      p_followers: x.public_metrics?.followers_count ?? null,
      p_ref: saved.ref,
    })
    if (error) {
      console.error('upsert_x_user', error)
      return fail('database')
    }

    const ret = saved.ret ?? '/'
    return redirect(`${siteOrigin(req)}${ret}${ret.includes('?') ? '&' : '?'}auth=ok`, [clearCookie(req, OAUTH_COOKIE), sessionCookie(req, uid)])
  } catch (e) {
    console.error(e)
    return fail('server')
  }
}

export const config = {
  path: '/auth/x/callback',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
