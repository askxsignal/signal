// The app's API. The browser never talks to the database: it calls these endpoints with the
// session cookie; rewards are decided by SQL functions on the server, never by the client or the model.
import { CALLBACK_PATH, SESSION_COOKIE, admin, clearCookie, json, keyed, missingEnv, optionalMissing, sameOrigin, session, siteOrigin } from '../lib/server.mjs'
import { brainInfo, chatTurn, loadMe, pingModel } from '../lib/agent.mjs'
import { NFT_QUOTE_TASK, brainState, codeReply, commandReply, isCommand, nftQuoteReply } from '../../shared/brain.mjs'

const POST_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i

/**
 * A pasted link meant for the NFT quote task? Once someone has minted, that task is the newest thing
 * offered, so a link goes there, unless they are clearly busy with another link task: they pressed its
 * "Open on X" after this one's, or (if they never opened this one) in the last 15 minutes.
 * People often quote straight from X without pressing anything here; the old rule then let the model
 * credit the generic bonus post (quote-1, +500) instead.
 */
function nftQuoteTarget(me) {
  const q = me?.tasks?.find((t) => t.id === NFT_QUOTE_TASK)
  if (!q || q.status === 'done') return null
  const now = me.serverNow ?? Date.now()
  const since = q.status === 'opened' ? q.openedAt ?? 0 : now - 15 * 60_000
  const busyElsewhere = me.tasks.some((t) => t.id !== q.id && t.status === 'opened' && (t.openedAt ?? 0) > since)
  return busyElsewhere ? null : q
}

// "I did it" on a task card sends "done — <title>"; plain "done" / "сделал" count too.
const DONE = /^\s*(done|did it|i did it|сделал|сделала|готово)\b/i

// What signal says when a limit hits. retryAfter is in seconds.
const LIMIT_COPY = {
  busy: () => 'one thing at a time. i am still answering your last message.',
  rate_minute: (n) => `slow down, operator. the dish needs a moment. try again in ${n}s.`,
  rate_hour: (n) => `you have talked a lot this hour. come back in ${Math.ceil(n / 60)} min.`,
  rate_day: () => 'that is enough talking for today. the uplink reopens tomorrow (utc).',
  rate_ip: (n) => `too many voices from your network. try again in ${Math.ceil(n / 60)} min.`,
}

/** Client IP, hashed so raw addresses never reach the database. */
function ipKey(req, context) {
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  return ip ? keyed('ip', ip).slice(0, 22) : null
}

export default async (req, context) => {
  const started = Date.now()
  const path = new URL(req.url).pathname.replace(/\/$/, '')
  try {
    // ---------------------------------------------------------- public
    if (path === '/api/health') {
      const missing = missingEnv()
      const info = { ok: missing.length === 0, missing, optional_missing: optionalMissing(), login: 'x', callback_url: `${siteOrigin(req)}${CALLBACK_PATH}`, ...brainInfo(),
        // NFT minting (details and the minting wallet's balance: /api/nft/health)
        nft_missing: ['NFT_RPC_URL', 'NFT_SECRET_KEY', 'NFT_TREE', 'SITE_URL'].filter((k) => !process.env[k]) }
      // ?llm=1 makes one tiny model call to show whether the key works and how fast it answers.
      if (new URL(req.url).searchParams.get('llm') === '1' && missing.length === 0) {
        const { data: n } = await admin().rpc('hit', { p_bucket: `llmping:${new Date().toISOString().slice(0, 13)}` })
        info.llm = n > 30 ? { ok: false, error: 'probe limit reached this hour' } : await pingModel()
      }
      return json(info)
    }
    if (path === '/api/leaderboard' && req.method === 'GET') {
      if (missingEnv().length) return json({ error: 'not_configured' }, 503)
      const { data, error } = await admin().rpc('api_leaderboard', { p_limit: 100 })
      if (error) throw error
      return json(data)
    }
    if (path === '/api/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json({ error: 'bad_origin' }, 403)
      return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(req, SESSION_COOKIE) })
    }
    if (missingEnv().length) return json({ error: 'not_configured', missing: missingEnv() }, 503)

    // ---------------------------------------------------------- signed in
    const s = session(req)
    if (!s) return json({ error: 'unauthorized' }, 401)
    const db = admin()
    const origin = siteOrigin(req)

    if (path === '/api/me' && req.method === 'GET') {
      const me = await loadMe(db, s.uid, origin)
      return me ? json(me) : json({ error: 'unauthorized' }, 401, { 'Set-Cookie': clearCookie(req, SESSION_COOKIE) })
    }
    if (path === '/api/history' && req.method === 'GET') {
      const { data, error } = await db.rpc('api_history', { p_user: s.uid, p_limit: 80 })
      if (error) throw error
      return json({ messages: data })
    }

    if (req.method !== 'POST') return json({ error: 'bad_request' }, 400)
    if (!sameOrigin(req)) return json({ error: 'bad_origin' }, 403)
    const raw = await req.text()
    if (raw.length > 8192) return json({ error: 'too_large' }, 413)
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      return json({ error: 'bad_json' }, 400)
    }

    if (path === '/api/task/open') {
      const { data, error } = await db.rpc('api_task_open', { p_user: s.uid, p_task: String(body.task_id ?? '').slice(0, 40) })
      if (error) throw error
      return json(data)
    }

    if (path === '/api/chat') {
      const text = String(body.text ?? '').trim().slice(0, 1000)
      if (!text) return json({ error: 'empty' }, 400)
      // Limits + store the user's message + recent history, in one round trip.
      const { data: begin, error } = await db.rpc('api_chat_begin', { p_user: s.uid, p_text: text, p_ip: ipKey(req, context) })
      if (error) throw error
      if (!begin.ok) {
        const retryAfter = Math.max(1, Number(begin.retryAfter) || 30)
        return json({ error: begin.error, retryAfter, message: (LIMIT_COPY[begin.error] ?? LIMIT_COPY.rate_minute)(retryAfter) }, 429, { 'Retry-After': String(retryAfter) })
      }

      // /uplink (the launch post's command) and /mintallo (the NFT window): fixed answers, no model call.
      if (isCommand(text)) {
        const me0 = await loadMe(db, s.uid, origin)
        const cmd = me0 && commandReply(text, brainState(me0))
        if (cmd) {
          const reply = { role: 'agent', text: cmd.text, events: cmd.events }
          const { error: endErr } = await db.rpc('api_chat_end', { p_user: s.uid, p_text: reply.text, p_events: reply.events, p_brain: 'command', p_calls: 0, p_tokens: 0 })
          if (endErr) console.error('api_chat_end', endErr)
          return json({ reply, me: me0, brain: 'command' })
        }
      }

      // The NFT quote task ("I did it" or a pasted link): handled here, without the model, so it never
      // lands on another task and always ends with the launch countdown. Nothing is checked against X.
      const link = text.match(POST_URL)?.[0]
      if (link || DONE.test(text)) {
        const me0 = await loadMe(db, s.uid, origin)
        const q = nftQuoteTarget(me0)
        if (q && (link || q.status === 'opened')) {
          const { data, error: claimErr } = await db.rpc('api_task_claim', { p_user: s.uid, p_task: q.id, p_evidence: link ? { url: link } : null })
          const result = claimErr ? { ok: false, error: 'server' } : data
          if (claimErr) console.error('api_task_claim', claimErr)
          const r = nftQuoteReply(result, me0.user.username)
          const reply = { role: 'agent', text: r.text, events: r.events }
          const { error: endErr } = await db.rpc('api_chat_end', { p_user: s.uid, p_text: reply.text, p_events: reply.events, p_brain: 'nft-quote', p_calls: 0, p_tokens: 0 })
          if (endErr) console.error('api_chat_end', endErr)
          return json({ reply, me: result?.ok ? await loadMe(db, s.uid, origin) : me0, brain: 'nft-quote' })
        }
      }

      // A secret phrase anywhere in the message: the reserve pays (once per person) before the model
      // ever sees it, and signal answers without spending a model call. Phrases live only in the database.
      const { data: code, error: codeErr } = await db.rpc('api_redeem_code', { p_user: s.uid, p_text: text })
      if (codeErr) console.error('api_redeem_code (run migration 0005?)', codeErr.message ?? codeErr)
      if (code?.matched) {
        const reply = { role: 'agent', text: codeReply(code, text), events: code.ok ? [{ type: 'reward', amount: code.reward, reason: 'secret phrase' }] : [] }
        const { error: endErr } = await db.rpc('api_chat_end', { p_user: s.uid, p_text: reply.text, p_events: reply.events, p_brain: 'code', p_calls: 0, p_tokens: 0 })
        if (endErr) console.error('api_chat_end', endErr)
        return json({ reply, me: await loadMe(db, s.uid, origin), brain: 'code' })
      }

      let turn
      try {
        turn = await chatTurn(db, s.uid, text, begin.history, origin, started, begin.model !== false)
      } catch (e) {
        await db.rpc('api_chat_end', { p_user: s.uid, p_text: '' }) // release the one-at-a-time lock
        throw e
      }
      const { error: endErr } = await db.rpc('api_chat_end', {
        p_user: s.uid, p_text: turn.reply.text, p_events: turn.reply.events, p_brain: turn.brain,
        p_calls: turn.usage.calls, p_tokens: turn.usage.tokens,
      })
      if (endErr) console.error('api_chat_end', endErr)
      return json({ reply: turn.reply, me: turn.me, brain: turn.brain })
    }

    return json({ error: 'not_found' }, 404)
  } catch (e) {
    console.error(e)
    return json({ error: 'server_error' }, 500)
  }
}

// Netlify's own per-IP limit, enforced at the edge before this function runs (costs no compute).
// A real visitor needs ~2 calls to load and at most ~6 chat messages a minute (database limit), so
// 30 a minute per IP leaves room for a few people on one carrier IP and stops scripts early.
export const config = {
  path: '/api/*',
  excludedPath: ['/api/nft/*'], // netlify/functions/nft.mjs
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
