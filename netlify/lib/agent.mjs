// signal's mind on the server. A language model talks; the tools below act.
// The model sits behind any OpenAI-compatible chat-completions endpoint (MODEL_BASE_URL, MODEL_API_KEY,
// MODEL_NAME; MODEL_OPTIONS = extra JSON merged into every request).
// The model never decides amounts: every tool calls a SQL function that applies the reserve's rules.
// With no endpoint, or when the model is too slow or fails, the scripted brain answers instead.

import { BRAND, fillText, taskUrl } from '../../shared/brand.mjs'
import { brainState, composeReply, eventsFrom, followUp, mintTrialFollow, planTurn } from '../../shared/brain.mjs'
import { TOOL_DEFS, instructions } from '../../shared/persona.mjs'
import { checkPost } from './xpost.mjs'

const provider = () => (process.env.MODEL_API_KEY && process.env.MODEL_BASE_URL ? 'model' : null)
const model = () => process.env.MODEL_NAME || 'signal'
const options = () => {
  try {
    const o = JSON.parse(process.env.MODEL_OPTIONS || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}
const DEADLINE_MS = Number(process.env.CHAT_DEADLINE_MS) || 8500 // Netlify sync functions stop at 10 s by default
const MAX_TOKENS = 200 // per model call: signal speaks in 1–2 short sentences
const MAX_ROUNDS = 4 // model calls per user message (tool rounds included)
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/

// ------------------------------------------------------------------ account view
/** Load the account and shape it for the UI and the brains (same shape as the DEMO backend). */
export async function loadMe(db, uid, origin) {
  const { data, error } = await db.rpc('api_me', { p_user: uid })
  if (error) throw error
  if (!data) return null
  const refLink = `${origin}/?ref=${encodeURIComponent(data.refCode)}`
  return {
    user: data.user,
    allocation: Number(data.allocation),
    pendingRefs: Number(data.pendingRefs),
    refLink,
    referrals: data.referrals,
    wallet: data.wallet,
    pitch: data.pitch,
    standing: data.standing ?? null, // rank / operators / operator number for the pass (migration 0005)
    nft: data.nft ?? null, // may mint, the reserve's stamp, the mint (migration 0010)
    serverNow: Date.parse(data.now),
    tasks: data.tasks.map((t) => ({
      id: t.id,
      type: t.type,
      title: fillText(t.title),
      reward: t.reward,
      verification: t.verification,
      waitSec: t.waitSec,
      actionUrl: taskUrl(t.actionUrl, refLink),
      required: t.required,
      params: t.params,
      status: t.completedAt ? 'done' : t.openedAt ? 'opened' : 'todo',
      openedAt: t.openedAt ? Date.parse(t.openedAt) : null,
    })),
  }
}

// ------------------------------------------------------------------ tools
// The tools in the OpenAI-style function-calling format.
const FUNCTIONS = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))

async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args)
  if (error) {
    console.error(fn, error)
    return { ok: false, error: 'server' }
  }
  return data
}

/** Execute one tool. `turn` tracks per-message limits. */
async function runTool(db, uid, me, name, input = {}, turn) {
  const task = me.tasks.find((t) => t.id === String(input.task_id ?? ''))
  switch (name) {
    case 'show_task':
      if (!task) return { ok: false, error: 'unknown_task' }
      return { ok: true, task: { id: task.id, type: task.type, title: task.title, verification: task.verification, status: task.status } }
    case 'verify_task': {
      if (!task) return { ok: false, error: 'unknown_task' }
      if (turn.verified.has(task.id)) return { ok: false, error: 'already_checked_this_message' }
      turn.verified.add(task.id)
      const url = typeof input.proof_url === 'string' ? input.proof_url.trim().slice(0, 300) : ''
      if (task.verification === 'reply_url' && url) {
        // Sign-in is by typed handle, so a hand-made link must not pass: confirm the post exists and is theirs.
        // Some tasks need more than a post: tasks.params can ask for an image (media) or words (must).
        const need = { must: Array.isArray(task.params?.must) ? task.params.must : [], media: task.params?.media === true }
        const check = await checkPost(url, me.user.username, need)
        if (check.status === 'mismatch' || check.status === 'bad_url') return { ok: false, error: 'bad_link' }
        if (check.status === 'not_found') return { ok: false, error: 'post_not_found' }
        if (check.status === 'no_media') return { ok: false, error: 'no_card' }
        if (check.status === 'missing_text') return { ok: false, error: need.media ? 'no_card' : 'missing_text', must: need.must }
        if (check.status === 'unavailable') console.error('reply check: oembed unavailable, falling back to the link format check')
      }
      return rpc(db, 'api_task_claim', { p_user: uid, p_task: task.id, p_evidence: url ? { url } : null })
    }
    case 'judge_pitch': {
      if (turn.pitched) return { ok: false, error: 'one_pitch_per_message' }
      turn.pitched = true
      const score = Math.max(0, Math.min(3, Math.round(Number(input.score) || 0)))
      return rpc(db, 'api_pitch', { p_user: uid, p_score: score })
    }
    case 'save_wallet': {
      const w = String(input.address ?? '').trim()
      if (!SOLANA.test(w) && !EVM.test(w)) return { ok: false, error: 'bad_wallet' }
      return rpc(db, 'api_set_wallet', { p_user: uid, p_wallet: w })
    }
    case 'show_invite':
      return { ok: true, link: me.refLink, friends: me.referrals }
    case 'show_token':
      return { ok: true, ca: BRAND.token.ca || null, status: BRAND.token.ca ? 'live' : 'launching soon' }
  }
  return { ok: false, error: 'unknown_tool' }
}

// ------------------------------------------------------------------ prompt
const systemPrompt = (me, convo) => instructions(me, convo)

function toApiHistory(rows, text) {
  const out = []
  for (const r of rows ?? []) {
    const role = r.role === 'agent' ? 'assistant' : 'user'
    const content = String(r.text ?? '').trim()
    if (!content) continue
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n${content}`
    else out.push({ role, content })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  if (out.length && out[out.length - 1].role === 'user') out[out.length - 1].content += `\n${text}`
  else out.push({ role: 'user', content: text })
  return out
}

async function complete(body, ms) {
  const res = await fetch(`${process.env.MODEL_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...options(), ...body }),
    signal: AbortSignal.timeout(Math.max(800, ms)),
  })
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

/** Tool arguments arrive as a JSON string that may be malformed: never trust it blindly. */
const parseArgs = (raw) => {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

// DeepSeek sometimes writes a tool call into the text instead of tool_calls, e.g.
// `<function=verify_task>{"task_id":"like-3"}</function>`. Turn those back into real calls.
const LEAKED_CALL = /<function=([a-z_]+)>?\s*(\{[\s\S]*?\})?\s*(?:<\/function>?|$)/gi
const TOOL_NAMES = () => new Set(FUNCTIONS.map((f) => f.function?.name).filter(Boolean))
// Anything that still looks like tool syntax must never reach the chat.
const TOOL_JUNK = /<\/?function|<\|?\s*tool|｜tool|tool▁call/i

function leakedCalls(content) {
  const names = TOOL_NAMES()
  const calls = []
  for (const m of String(content ?? '').matchAll(LEAKED_CALL)) {
    if (!names.has(m[1])) continue
    calls.push({ id: `leak_${calls.length}_${Date.now()}`, type: 'function', function: { name: m[1], arguments: m[2] || '{}' } })
  }
  return calls
}

/** One turn: OpenAI-style messages and tool rounds until it speaks. */
async function modelLoop({ system, history, text, exec, deadline, usage }) {
  const messages = [{ role: 'system', content: system }, ...toApiHistory(history, text)]
  let said = ''
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const left = deadline - Date.now() - 250
    if (left < 900) break
    const res = await complete({ model: model(), messages, tools: FUNCTIONS, max_tokens: MAX_TOKENS, temperature: 1.2 }, left)
    usage.calls++
    usage.tokens += (res.usage?.prompt_tokens ?? 0) + (res.usage?.completion_tokens ?? 0)
    const msg = res.choices?.[0]?.message ?? {}
    let calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    let content = msg.content ?? ''
    if (!calls.length && TOOL_JUNK.test(content)) {
      calls = leakedCalls(content)
      if (calls.length) console.warn('model wrote tool calls as text; running them:', calls.map((c) => c.function.name).join(','))
      content = content.replace(LEAKED_CALL, '')
    }
    said = TOOL_JUNK.test(content) ? '' : content.trim()
    if (!calls.length) break
    messages.push({ role: 'assistant', content, tool_calls: calls })
    for (const c of calls) {
      const r = await exec(c.function?.name ?? '', parseArgs(c.function?.arguments))
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r) })
    }
    // Cards only (show_task / show_invite / show_token) and it already spoke: no need for a second round.
    if (said && calls.every((c) => DISPLAY_TOOLS.has(c.function?.name))) break
    said = '' // keep only what is said after the latest tool results
  }
  return said
}

const DISPLAY_TOOLS = new Set(['show_task', 'show_invite', 'show_token'])

const clean = (s) => s.replace(/[*_`#>]+/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 900)

// ------------------------------------------------------------------ one chat turn
/**
 * One chat turn. `allowModel` comes from the database budget check (per-user and site-wide daily
 * limits); when false, signal answers with the scripted brain and the key is not touched.
 * Returns usage so the caller can record what this turn spent.
 */
export async function chatTurn(db, uid, text, history, origin, started = Date.now(), allowModel = true) {
  const deadline = started + DEADLINE_MS
  let me = await loadMe(db, uid, origin)
  const results = []
  const turn = { verified: new Set(), pitched: false }
  let reply = ''
  let brain = 'scripted'
  const usage = { calls: 0, tokens: 0 }
  let why = '' // why the scripted brain answered, stored with the message

  const exec = async (tool, input) => {
    const result = await runTool(db, uid, me, tool, input, turn)
    results.push({ tool, input, result })
    if (['verify_task', 'judge_pitch', 'save_wallet'].includes(tool) && result?.ok) me = await loadMe(db, uid, origin)
    return result
  }

  const p = provider()
  const convo = p && allowModel ? await conversationState(db, uid).catch(() => ({ userMessages: 0, cardsShown: [] })) : null
  if (!p) why = 'no_model'
  else if (!allowModel) why = 'budget'
  if (p && allowModel) {
    brain = 'model'
    try {
      reply = clean(await modelLoop({ system: systemPrompt(me, convo), history, text, exec, deadline, usage }))
    } catch (e) {
      console.error('model turn failed, falling back to the scripted brain:', e?.name, e?.message ?? e)
      why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : `error:${String(e?.message ?? e).slice(0, 60)}`
      // A call cut off by the deadline was still billed: count it with a rough estimate.
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        usage.calls++
        usage.tokens += 3000
      }
      brain = 'scripted'
    }
  }

  if (!reply && brain !== 'scripted' && !why) why = 'empty_or_deadline'
  if (!reply) {
    brain = 'scripted'
    // Scripted brain: plans tools itself if the model did not run any.
    if (!results.length) for (const a of planTurn(text, brainState(me))) await exec(a.tool, a.input)
    reply = composeReply(text, brainState(me), results)
  }
  for (const a of followUp(results, brainState(me))) await exec(a.tool, a.input)

  let events = eventsFrom(results, me.tasks)
  // A mint trial was just verified: the next card is the next mint trial, or the mint window itself.
  const mintNext = mintTrialFollow(results, brainState(me))
  if (mintNext) {
    events = [...events.filter((e) => e.type !== 'task'), ...mintNext.events]
    if (mintNext.line) reply = `${reply} ${mintNext.line}`.trim()
  }
  return { reply: { role: 'agent', text: reply, events }, me, brain: why ? `scripted:${why}` : brain, usage }
}

/** What the model needs to pace the conversation: how far in we are and which cards are already on screen. */
async function conversationState(db, uid) {
  const { data } = await db.rpc('api_history', { p_user: uid, p_limit: 60 })
  const rows = Array.isArray(data) ? data : []
  const cardsShown = [...new Set(rows.flatMap((m) => (m.role === 'agent' ? (m.events ?? []) : [])).filter((e) => e?.type === 'task').map((e) => e.taskId))]
  return { userMessages: rows.filter((m) => m.role === 'user').length, cardsShown }
}

/** One tiny request to the configured model — for /api/health?llm=1. */
export async function pingModel() {
  const p = provider()
  if (!p) return { ok: false, error: 'no model endpoint set (MODEL_BASE_URL, MODEL_API_KEY)' }
  const t0 = Date.now()
  try {
    const r = await complete({ model: model(), messages: [{ role: 'user', content: 'reply with one word: ok' }], max_tokens: 5 }, 8000)
    return { ok: true, ms: Date.now() - t0, said: r.choices?.[0]?.message?.content ?? '' }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) }
  }
}

export const brainInfo = () => ({ brain: provider() ? 'model' : 'scripted', deadline_ms: DEADLINE_MS })
