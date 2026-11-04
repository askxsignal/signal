// DEMO backend: everything in localStorage, signal runs on the scripted brain. Used by `npm run dev`,
// previews and any build without VITE_BACKEND=api. The UI shows a DEMO badge.

import { fillText, taskUrl } from '../../shared/brand.mjs'
import { DEMO_TASKS, PITCH, WELCOME_BONUS } from '../../shared/tasks.mjs'
import { brainState, codeReply, commandReply, composeReply, eventsFrom, followUp, planTurn } from '../../shared/brain.mjs'
import type { Backend, LogRow, Me, Msg, SendResult, Task } from './types'
import { sleep, store } from '../util'

const KEY = 'signal_demo_v1'
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM = /^0x[0-9a-fA-F]{40}$/

interface DemoState {
  username: string
  opened: Record<string, number>
  done: Record<string, number>
  ledger: { key: string; amount: number; reason: string }[]
  pitch: { attempts: number; best: number }
  wallet: string | null
  messages: Msg[]
  joinedAt?: string
}

const load = (): DemoState | null => {
  try {
    return JSON.parse(store.get(KEY) ?? 'null')
  } catch {
    return null
  }
}
const save = (s: DemoState) => store.set(KEY, JSON.stringify(s))

function credit(s: DemoState, key: string, amount: number, reason: string) {
  if (amount <= 0 || s.ledger.some((l) => l.key === key)) return false
  s.ledger.push({ key, amount, reason })
  return true
}

function toMe(s: DemoState): Me {
  const refLink = `${location.origin}${location.pathname}?ref=${s.username}`
  const tasks: Task[] = DEMO_TASKS.map((t) => ({
    id: t.id,
    type: t.type,
    title: fillText(t.title),
    reward: t.reward,
    verification: t.verification as Task['verification'],
    waitSec: t.waitSec,
    actionUrl: taskUrl(t.actionUrl, refLink),
    required: t.required,
    params: t.params,
    status: s.done[t.id] ? 'done' : s.opened[t.id] ? 'opened' : 'todo',
    openedAt: s.opened[t.id] ?? null,
  }))
  return {
    user: { username: s.username, name: s.username, avatar: null },
    allocation: s.ledger.reduce((a, l) => a + l.amount, 0),
    pendingRefs: 0,
    refLink,
    referrals: { total: 0, qualified: 0 },
    wallet: s.wallet,
    tasks,
    pitch: { attempts: s.pitch.attempts, max: PITCH.attempts, best: s.pitch.best, unlocked: tasks.every((t) => !t.required || t.status === 'done') },
    standing: { rank: 1, total: 1, no: 1, joinedAt: s.joinedAt ?? new Date().toISOString() }, // demo: you are the only operator
    serverNow: Date.now(),
  }
}

// Tool execution with the same rules as the SQL functions.
function run(s: DemoState, tool: string, input: Record<string, any>) {
  const me = toMe(s)
  const task = me.tasks.find((t) => t.id === input.task_id)
  switch (tool) {
    case 'show_task':
      if (!task) return { ok: false, error: 'unknown_task' }
      return { ok: true, task: { id: task.id, type: task.type, title: task.title, verification: task.verification, status: task.status } }
    case 'verify_task': {
      if (!task) return { ok: false, error: 'unknown_task' }
      if (task.status === 'done') return { ok: true, already: true }
      if (task.verification === 'timer') {
        if (!task.openedAt) return { ok: false, error: 'not_opened' }
        const left = task.waitSec - (Date.now() - task.openedAt) / 1000
        if (left > 0) return { ok: false, error: 'too_early', wait: left }
      } else if (task.verification === 'reply_url') {
        const re = new RegExp(`^https://(www\\.)?(x|twitter)\\.com/${s.username}/status/[0-9]+`, 'i')
        if (!re.test(String(input.proof_url ?? ''))) return { ok: false, error: 'bad_link' }
      } else if (task.verification === 'referral') {
        return { ok: false, error: 'not_enough_friends', have: 0, need: (task.params?.need as number) ?? 2 }
      }
      s.done[task.id] = Date.now()
      s.opened[task.id] ??= Date.now()
      credit(s, `task:${task.id}`, task.reward, `Task: ${task.title}`)
      return { ok: true, reward: task.reward }
    }
    case 'judge_pitch': {
      if (!me.pitch.unlocked) return { ok: false, error: 'locked' }
      if (s.pitch.attempts >= PITCH.attempts) return { ok: false, error: 'no_attempts' }
      const score = Math.max(0, Math.min(3, Math.round(Number(input.score) || 0)))
      s.pitch.attempts++
      s.pitch.best = Math.max(s.pitch.best, score)
      let awarded = 0
      for (let i = 0; i < score; i++) if (credit(s, `pitch:t${i + 1}`, PITCH.tiers[i], 'Persuasion bonus')) awarded += PITCH.tiers[i]
      return { ok: true, score, awarded, attemptsLeft: PITCH.attempts - s.pitch.attempts }
    }
    case 'save_wallet': {
      const w = String(input.address ?? '').trim()
      if (!SOLANA.test(w) && !EVM.test(w)) return { ok: false, error: 'bad_wallet' }
      if (s.wallet && s.wallet !== w) return { ok: false, error: 'wallet_locked', wallet: s.wallet }
      if (s.wallet) return { ok: true, wallet: w, already: true }
      s.wallet = w
      return { ok: true, wallet: w }
    }
    case 'show_invite':
    case 'show_token':
      return { ok: true }
  }
  return { ok: false, error: 'unknown_tool' }
}

// Secret phrases, as SHA-256 of the normalised phrase: the demo can check them without the site's code
// giving them away. Production checks the real list in the database (secret_codes, migration 0005).
// Secret phrases: SHA-256 hashes only (the live list is in the database). None ship with the repo.
const DEMO_CODES: Record<string, number> = {}
const normCode = (t: string) => t.toLowerCase().replace(/[^a-z0-9\u0430-\u044f\u0451$]+/g, ' ').trim()
async function sha256(t: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** Any run of 1–6 words in the message that hashes to a phrase. Longest first. */
async function findCode(text: string) {
  if (!crypto?.subtle) return null
  const words = normCode(text.slice(0, 1000)).split(' ').filter(Boolean)
  for (let n = Math.min(6, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const hash = await sha256(words.slice(i, i + n).join(' '))
      if (DEMO_CODES[hash]) return { hash: hash.slice(0, 12), reward: DEMO_CODES[hash] }
    }
  }
  return null
}

export function demoBackend(): Backend {
  return {
    mode: 'demo',
    async me() {
      const s = load()
      return s ? toMe(s) : null
    },
    async history() {
      return load()?.messages ?? []
    },
    async send(text: string): Promise<SendResult> {
      const s = load()
      if (!s) return { reply: { role: 'agent', text: '', events: [{ type: 'signin' }] }, me: null, error: 'unauthorized' }
      s.messages.push({ role: 'user', text, at: new Date().toISOString() })
      save(s)

      // 0. /uplink and /mintallo: the fixed answer + next trial (same as the server).
      const cmd = commandReply(text, brainState(toMe(s)))
      if (cmd) {
        await sleep(700)
        const reply: Msg = { role: 'agent', text: cmd.text, events: cmd.events, at: new Date().toISOString() }
        s.messages.push(reply)
        save(s)
        return { reply, me: toMe(s), brain: 'command' }
      }

      // 0b. A secret phrase: paid before any brain sees the message (same as the server).
      const code = await findCode(text)
      if (code) {
        const key = `code:${code.hash}`
        const fresh = credit(s, key, code.reward, 'Secret phrase')
        const result = fresh ? { ok: true, reward: code.reward } : { ok: false, error: 'already' }
        await sleep(900)
        const reply: Msg = { role: 'agent', text: codeReply(result, text), events: fresh ? [{ type: 'reward', amount: code.reward, reason: 'secret phrase' }] : [], at: new Date().toISOString() }
        s.messages.push(reply)
        save(s)
        return { reply, me: toMe(s), brain: 'code' }
      }

      // 1. The scripted brain (the live site talks through the model: netlify/lib/agent.mjs).
      const state = brainState(toMe(s))
      const plan = planTurn(text, state)
      // signal takes a breath before acting; checks take longer.
      await sleep(plan.some((p) => p.tool === 'verify_task' || p.tool === 'judge_pitch') ? 1900 + Math.random() * 900 : 700 + Math.random() * 600)
      const cur = load() ?? s
      const results = plan.map((a) => ({ ...a, result: run(cur, a.tool, a.input) }))
      for (const a of followUp(results, brainState(toMe(cur)))) results.push({ ...a, result: run(cur, a.tool, a.input) })
      const after = toMe(cur)
      const reply: Msg = { role: 'agent', text: composeReply(text, brainState(after), results), events: eventsFrom(results, after.tasks), at: new Date().toISOString() }
      cur.messages.push(reply)
      save(cur)
      return { reply, me: after, brain: 'scripted' }
    },
    async openTask(id: string) {
      const s = load()
      if (!s) return { ok: false, error: 'unauthorized' }
      s.opened[id] ??= Date.now()
      save(s)
      return { ok: true, openedAt: s.opened[id] }
    },
    async login(handle: string) {
      const username = (handle ?? '').replace(/^@/, '').trim().toLowerCase().slice(0, 15)
      if (!/^[a-z0-9_]{1,15}$/.test(username)) return { ok: false, error: 'bad_handle', message: 'X handles are 1–15 letters, numbers or _.' }
      const prev = load()
      const s: DemoState = prev && prev.username === username ? prev : { username, opened: {}, done: {}, ledger: [], pitch: { attempts: 0, best: 0 }, wallet: null, messages: [], joinedAt: new Date().toISOString() }
      credit(s, 'welcome', WELCOME_BONUS, 'Welcome bonus')
      save(s)
      return { ok: true }
    },
    async logout() {
      store.set(KEY, null)
    },
    async leaderboard(): Promise<LogRow[]> {
      // Demo: nothing leaves this browser, so the log holds only you.
      const s = load()
      return s ? [{ rank: 1, username: s.username, avatar: null, points: toMe(s).allocation }] : []
    },
  }
}
