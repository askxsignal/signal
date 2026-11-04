// The whole interface: one question, one composer, a thread that appears once you speak.

import { BRAND, launchLeft, tokenLinks } from '../shared/brand.mjs'
import { Orbit, type Theme } from './space/engine'
import { ApiUnavailable, type Backend, type ChatEvent, type LogRow, type Me, type Msg, type NftMint, type Task } from './backend/types'
type MintedEvent = Extract<ChatEvent, { type: 'minted' }>
import { copy, fmt, h, session, sleep, sound, store, toast } from './util'
import { isCommand, nftQuoteOffer } from '../shared/brain.mjs'
import { pickReply, withReply } from '../shared/replies.mjs'
import { CARD_H, CARD_W, callsign, cardBlob, renderCard, verdict } from './card'

const ICON = {
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>',
  clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>',
  out: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7v7M13 3 4 12"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.2 1.5h2.2L9.6 7l5.6 7.5h-4.4L7.4 10l-3.9 4.5H1.3l5.1-5.9L1 1.5h4.5l3.1 4.1 3.6-4.1Zm-.8 11.7h1.2L4.7 2.7H3.4l8 10.5Z"/></svg>',
}
const svg = (s: string) => {
  const t = document.createElement('template')
  t.innerHTML = s
  return t.content.firstElementChild!
}

const SCRAMBLE = '.:;+=#%01'
const AUTH_ERRORS: Record<string, string> = {
  cancelled: 'You cancelled the X sign-in.',
  expired: 'Sign-in took too long. Try again.',
  state: 'Sign-in check failed. Try again (and allow cookies for this site).',
  token: 'X refused the sign-in. The app settings on X do not match this site.',
  profile: 'Could not read your X profile. Try again.',
  x_busy: 'X is rate-limiting sign-ins right now. Try again in a few minutes.',
  too_new: 'Your X account is too new to get through.',
  database: 'Could not save your account. Try again in a minute.',
  config: 'Sign-in is not configured yet (X keys missing on the server).',
  server: 'Something broke on our side. Try again.',
}
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const NFT_ERRORS: Record<string, string> = {
  closed: 'Minting is not open for you yet.',
  need_tasks: 'Finish your trials first. Type /mintallo.',
  need_wallet: 'Paste a Solana wallet address first.',
  bad_wallet: 'That is not a Solana wallet address.',
  wallet_taken: 'That wallet is already saved by another account.',
  busy: 'Already minting. One moment.',
  too_many_attempts: `Too many tries. Message @${BRAND.xHandle}.`,
  daily_cap: 'The reserve minted enough for today. Try tomorrow.',
  paused: 'Minting is paused for now.',
  treasury_low: 'The reserve is refilling its gas. Try again later.',
  chain_unavailable: 'Solana is not answering. Try again in a minute.',
  chain_rejected: 'Solana did not take the mint. Try again in a minute.',
  chain_failed: 'The mint did not land. Try again.',
  not_configured: 'Minting is not set up yet.',
  rate_ip: 'Slow down. Try again in a minute.',
  unauthorized: 'Sign in again.',
}
const scan = (kind: 'tx' | 'token', id: string, network: string) => `https://solscan.io/${kind}/${id}${network === 'devnet' ? '?cluster=devnet' : ''}`
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
/** Where "View NFT" goes: the item page on Tensor (mainnet); Solscan on devnet, where Tensor has nothing. */
const nftPage = (assetId: string, network: string) => (network === 'devnet' ? scan('token', assetId, network) : `https://www.tensor.trade/item/${assetId}`)
const TITLES = ['is anyone out there?']
const CHIPS = ['who are you?', `what is the ${BRAND.unit} reserve?`, 'i want in']

export class App {
  private me: Me | null = null
  private history: Msg[] = []
  private historyLoaded = false
  private busy = false
  private queued: string[] = []
  private cooldownUntil = 0
  private view: 'hero' | 'chat' = 'hero'
  private cards = new Map<string, Set<HTMLElement>>()
  private timers = new Set<number>()
  private cardArt: { key: string; blob: Promise<Blob>; url: Promise<string>; ready: string | null } | null = null
  private nftCards = new Set<HTMLElement>()
  private replySteps = new Map<string, number>()
  private nftBusy = false
  private nftPolling = false
  private nftAutoPolled = false
  private sayChain: Promise<void> = Promise.resolve()

  // elements
  private root = document.getElementById('app')!
  private top!: HTMLElement
  private right!: HTMLElement
  private historyBtn!: HTMLButtonElement
  private thread!: HTMLElement
  private inner!: HTMLElement
  private dock!: HTMLElement
  private ask!: HTMLElement
  private box!: HTMLElement
  private input!: HTMLTextAreaElement
  private sendBtn!: HTMLButtonElement
  private menu!: HTMLElement
  private banner: HTMLElement | null = null

  constructor(private backend: Backend, private orbit: Orbit) {}

  // ---------------------------------------------------------------- boot
  async start() {
    this.build()
    this.applyTheme((store.get('signal_theme') as Theme) || 'dark', false)
    this.captureRef()
    const auth = this.readAuthResult()
    this.introTitle()

    try {
      this.me = await this.backend.me()
      if (this.me) this.history = await this.backend.history()
    } catch (e) {
      if (e instanceof ApiUnavailable) this.showBanner('Service unavailable — the API is not responding. Open /api/health for details.')
      else console.error(e)
    }
    this.renderTop()

    // Back from X.
    if (auth?.ok && this.me) {
      await this.openChat()
      await this.afterSignIn()
    } else if (auth && !auth.ok) {
      toast(AUTH_ERRORS[auth.reason ?? ''] ?? 'Could not sign in with X. Try again.', 'err')
      if (session.get('signal_pending')) this.startSignIn()
    }
  }

  /** ?auth=ok | ?auth=error&reason=… after the X round trip; cleans the URL. */
  private readAuthResult(): { ok: boolean; reason?: string } | null {
    const p = new URLSearchParams(location.search)
    const auth = p.get('auth')
    if (!auth) return null
    const reason = p.get('reason') ?? undefined
    for (const k of ['auth', 'reason', 'code', 'state']) p.delete(k)
    history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}${location.hash}`)
    if (auth === 'ok') store.set('signal_ref', null)
    return { ok: auth === 'ok', reason }
  }

  /** First thing after signing in: /uplink runs itself, otherwise the deal in one breath. */
  private async afterSignIn() {
    const pending = session.get('signal_pending')
    session.set('signal_pending', null)
    // Live sign-in went through X and reloaded the page: show what they typed before it again.
    const echo = this.backend.mode === 'api'
    if (pending && isCommand(pending)) {
      this.submit(pending, echo)
      return
    }
    const returning = this.history.length > 0
    await this.signalSays(returning
      ? `@${this.me?.user.username}, back on the frequency. your trials are where you left them.`
      : `@${this.me?.user.username}, signal acquired. here's the protocol: i have trials on x. do them and i credit ${BRAND.unit} to your allocation. say "go" when you're ready.`)
    if (pending && !/^(hi|hey|hello|gm|yo|sup|ping|привет|хай|ку)\W*$/i.test(pending.trim())) this.submit(pending, echo)
  }

  /** Remember ?ref=CODE for sign-in, then clean the URL. */
  private captureRef() {
    const p = new URLSearchParams(location.search)
    const ref = p.get('ref')
    if (!ref) return
    store.set('signal_ref', ref.slice(0, 40))
    p.delete('ref')
    history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}${location.hash}`)
  }

  // ---------------------------------------------------------------- layout
  private build() {
    this.historyBtn = h('button', { class: 'pill history', type: 'button', hidden: true, onclick: () => (this.view === 'hero' ? this.openChat() : this.closeChat()) }) as HTMLButtonElement
    this.right = h('div', { class: 'right' })
    this.top = h(
      'header',
      { class: 'top' },
      h('button', { class: 'mark', type: 'button', 'aria-label': `${BRAND.name} home`, onclick: () => this.closeChat() },
        h('span', { class: 'mark-word' }, BRAND.name), h('i', {}, 'leo · ch 07'), this.backend.mode === 'demo' ? h('span', { class: 'badge', title: 'Scripted brain, saved in this browser only' }, 'demo') : null),
      this.historyBtn,
      this.right,
    )

    this.inner = h('div', { class: 'thread-inner' })
    this.thread = h('section', { class: 'thread', role: 'log', 'aria-live': 'polite', 'aria-label': `Conversation with ${BRAND.name}` }, this.inner)

    this.input = h('textarea', { rows: 1, placeholder: `Transmit to ${BRAND.name}…`, 'aria-label': `Message ${BRAND.name}`, maxlength: 1000, enterkeyhint: 'send' }) as HTMLTextAreaElement
    this.sendBtn = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', disabled: true }) as HTMLButtonElement
    this.sendBtn.append(svg(ICON.send))
    const plus = h('button', { class: 'icon', type: 'button', 'aria-label': 'More', 'aria-haspopup': 'menu', onclick: (e: Event) => { e.stopPropagation(); this.toggleMenu(plus) } })
    plus.append(svg(ICON.plus))

    this.box = h('div', { class: 'box' }, this.input, h('div', { class: 'bar' }, plus, h('span', { class: 'hint' }, '↵ transmit · ⇧↵ newline'), this.sendBtn))
    const form = h('form', { class: 'composer', onsubmit: (e: Event) => { e.preventDefault(); this.submit(this.input.value) } }, this.box)

    this.ask = h('h1', { class: 'ask' }, TITLES[0])
    const chips = h('div', { class: 'chips' }, ...CHIPS.map((c) => h('button', { class: 'chip', type: 'button', onclick: () => this.submit(c) }, c)))
    const fine = h('p', { class: 'fine' }, `${BRAND.name} checks with timers and links · allocations are pending and reviewed before any drop · airdrop planned, not promised · not financial advice · not affiliated with X`)
    this.dock = h('div', { class: 'dock' }, this.ask, form, chips, fine)

    this.menu = h('div', { class: 'menu', role: 'menu', hidden: true })
    this.root.append(this.top, h('main', { class: 'stage' }, this.thread, this.dock), this.menu)
    document.body.dataset.view = 'hero'

    // composer behaviour
    this.input.addEventListener('input', () => {
      this.autosize()
      this.sendBtn.disabled = !this.input.value.trim()
      if (!this.busy) this.orbit.setMode(this.input.value ? 'listening' : 'idle')
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        this.submit(this.input.value)
      }
    })
    this.input.addEventListener('blur', () => !this.busy && this.orbit.setMode('idle'))

    // a ping where you tap the sky
    addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('button, a, input, textarea, .card, .menu, .bubble, .text, .boot')) return
      this.orbit.rippleAt(e.clientX, e.clientY, 0.9, 200)
      sound.play('tick')
    })
    document.addEventListener('click', (e) => {
      if (!this.menu.hidden && !(e.target as HTMLElement).closest('.menu')) this.menu.hidden = true
    })
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.menu.hidden = true
    })
    const focus = () => this.orbit.setFocus(this.box.getBoundingClientRect())
    addEventListener('resize', focus)
    new ResizeObserver(focus).observe(this.box)
    requestAnimationFrame(focus)
  }

  private autosize() {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(180, this.input.scrollHeight)}px`
  }

  /** First visit per session: the question decodes out of noise. */
  private introTitle() {
    const text = TITLES[0]
    if (reduced() || session.get('signal_title')) return
    session.set('signal_title', '1')
    const start = performance.now()
    const dur = 1100
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / dur)
      const shown = Math.floor(text.length * k)
      this.ask.textContent = text.slice(0, shown) + [...text.slice(shown)].map((c) => (c === ' ' ? ' ' : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0])).join('')
      if (k < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private showBanner(text: string) {
    this.banner?.remove()
    this.banner = h('p', { class: 'banner', role: 'alert' }, text)
    this.dock.prepend(this.banner)
  }

  // ---------------------------------------------------------------- top bar
  private renderTop() {
    this.right.replaceChildren()
    const me = this.me
    if (me) {
      const alloc = h('button', { class: 'alloc', type: 'button', title: 'Pending allocation — not a balance', onclick: () => this.localMessage('this is what the reserve has set aside for you. pending, not promised.', [{ type: 'log' }]) },
        h('b', { 'data-n': String(me.allocation) }, `${fmt(me.allocation)} ${BRAND.unit}`), h('small', {}, 'pending allocation'))
      const av = h('button', { class: 'avatar', type: 'button', 'aria-label': `Signed in as @${me.user.username}`, title: `@${me.user.username}`, onclick: (e: Event) => { e.stopPropagation(); this.toggleMenu(av) } },
        me.user.avatar ? h('img', { src: me.user.avatar, alt: '', referrerpolicy: 'no-referrer' }) : me.user.username.slice(0, 1).toUpperCase())
      this.right.append(alloc, av)
    } else {
      const btn = h('button', { class: 'pill signin', type: 'button', onclick: () => this.startSignIn() })
      btn.append(svg(ICON.x), 'Sign in')
      this.right.append(btn)
    }
    const hasHistory = !!me && this.history.length > 0
    this.historyBtn.hidden = !(hasHistory || this.view === 'chat')
    this.historyBtn.replaceChildren(svg(ICON.clock), this.view === 'chat' ? 'Close' : 'History')
  }

  private bumpAllocation(prev: number) {
    const b = this.right.querySelector<HTMLElement>('.alloc b')
    if (!b || !this.me) return
    const to = this.me.allocation
    const from = prev
    if (to === from) return
    b.parentElement!.classList.remove('bump')
    void b.offsetWidth
    b.parentElement!.classList.add('bump')
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 900)
      const e = 1 - Math.pow(1 - k, 3)
      b.textContent = `${fmt(from + (to - from) * e)} ${BRAND.unit}`
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  private setMe(me: Me | null) {
    if (!me) return
    const prev = this.me?.allocation ?? me.allocation
    this.me = me
    this.renderTop()
    this.bumpAllocation(prev)
    this.refreshCards()
    this.paintNfts()
    this.paintQuoteCtas()
    for (const el of this.swapAmounts) {
      if (!el.isConnected) this.swapAmounts.delete(el)
      else el.textContent = fmt(me.allocation)
    }
  }

  // ---------------------------------------------------------------- menu
  private toggleMenu(anchor: HTMLElement) {
    if (!this.menu.hidden) {
      this.menu.hidden = true
      return
    }
    const item = (label: string, hint: string, fn: () => void) =>
      h('button', { type: 'button', role: 'menuitem', onclick: () => { this.menu.hidden = true; fn() } }, label, h('small', {}, hint))
    const me = this.me
    const theme = (document.documentElement.dataset.theme as Theme) || 'dark'
    this.menu.replaceChildren(
      ...(me
        ? [
            item('Trials', `${me.tasks.filter((t) => t.status === 'done').length}/${me.tasks.length}`, () => this.localMessage('everything i have asked of you.', me.tasks.map((t) => ({ type: 'task', taskId: t.id }) as ChatEvent))),
            item('Operator pass', verdict(me.allocation), () => this.localMessage('this is how you look from up here.', [{ type: 'card' }])),
            ...(me.nft && (me.nft.eligible || me.nft.mint)
              ? [item('My NFT', me.nft.mint?.status === 'minted' ? 'minted' : me.nft.mint?.status === 'sent' ? 'landing' : me.nft.ready === false ? 'trials first' : 'mint', () => {
                  const m = me.nft?.mint
                  if (m?.status === 'minted') this.localMessage('your pass, on chain.', [{ type: 'minted', id: m.id, signature: m.signature, assetId: m.assetId, owner: m.owner, network: m.network }])
                  else if (!m && me.nft?.ready === false) this.openChat().then(() => this.submit('/mintallo'))
                  else this.localMessage('your pass, as an nft on solana. one per person, the reserve pays the gas.', [{ type: 'nft' }])
                })]
              : []),
            item('Invite friends', `${me.referrals.qualified} joined`, () => this.localMessage('bring friends. they count once they finish a task.', [{ type: 'invite' }])),
            item('Wallet', me.wallet ? `${me.wallet.slice(0, 4)}…${me.wallet.slice(-4)}` : 'not set', () => {
              this.localMessage(me.wallet ? `your wallet is ${me.wallet}. it is locked; changes go through the team.` : 'paste a solana wallet in the chat and i will log it.')
              this.input.focus()
            }),
          ]
        : [item('Sign in', 'x account', () => this.startSignIn())]),
      item('The log', 'top operators', () => this.localMessage('the log. everyone who got through, by signal strength.', [{ type: 'log' }])),
      item(`${BRAND.unit} token`, BRAND.token.ca ? 'contract' : 'soon', () => this.localMessage(BRAND.token.ca ? `this is the ${BRAND.unit} contract.` : 'no contract yet. anyone showing you one is lying.', [{ type: 'token' }])),
      ...(BRAND.launch.at ? [item('Launch', launchLeft() ?? 'live', () => this.localMessage(`the launch: ${BRAND.launch.label}.`, [{ type: 'launch' }]))] : []),
      h('hr'),
      item(theme === 'dark' ? 'Printout mode' : 'Night sky', 'theme', () => this.applyTheme(theme === 'dark' ? 'light' : 'dark')),
      item(sound.on ? 'Sound off' : 'Sound on', 'synth blips', () => sound.set(!sound.on)),
      ...(me ? [item('Sign out', `@${me.user.username}`, () => this.signOut())] : []),
    )
    this.menu.hidden = false
    const r = anchor.getBoundingClientRect()
    const mw = 240
    const left = Math.min(innerWidth - mw - 8, Math.max(8, r.left))
    this.menu.style.left = `${left}px`
    if (r.top > innerHeight / 2) {
      this.menu.style.top = 'auto'
      this.menu.style.bottom = `${innerHeight - r.top + 8}px`
    } else {
      this.menu.style.bottom = 'auto'
      this.menu.style.top = `${r.bottom + 8}px`
    }
    ;(this.menu.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true })
  }

  private applyTheme(t: Theme, save = true) {
    document.documentElement.dataset.theme = t
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#06080c' : '#ebe8df')
    this.orbit.setTheme(t)
    if (save) store.set('signal_theme', t)
  }

  private async signOut() {
    await this.backend.logout().catch(() => {})
    this.me = null
    this.history = []
    this.historyLoaded = false
    this.inner.replaceChildren()
    this.closeChat()
    this.renderTop()
    toast('Signed out')
  }

  private startSignIn() {
    this.openChat().then(() => this.localMessage(this.backend.mode === 'api' ? 'who is transmitting? sign in with x.' : 'who is transmitting? give me your x handle.', [{ type: 'signin' }]))
  }

  // ---------------------------------------------------------------- views
  private async openChat() {
    if (this.view === 'chat') return
    if (this.me && !this.historyLoaded) {
      this.historyLoaded = true
      for (const m of this.history) this.renderMsg(m, false)
    }
    this.flip(() => {
      this.view = 'chat'
      document.body.dataset.view = 'chat'
    })
    this.renderTop()
    this.scrollDown(false)
    if (this.me) setTimeout(() => this.maybeNftIntro(), 1200)
  }

  /** Once per browser: tell an allowed person their NFT is ready to mint. */
  private maybeNftIntro() {
    const n = this.me?.nft
    if (!n?.eligible || n.ready === false || n.mint || this.busy || store.get('signal_nft_intro') || this.view !== 'chat') return
    store.set('signal_nft_intro', '1')
    this.signalSays('the reserve approved you. your operator pass, stamped approved, as a compressed nft on solana — minted straight to your wallet. free: the reserve pays the gas.', [{ type: 'nft' }])
  }

  private closeChat() {
    if (this.view === 'hero') return
    this.flip(() => {
      this.view = 'hero'
      document.body.dataset.view = 'hero'
    })
    this.renderTop()
  }

  /** Animate the composer between the centre and the bottom (FLIP). */
  private flip(change: () => void) {
    const a = this.box.getBoundingClientRect()
    change()
    const b = this.box.getBoundingClientRect()
    this.orbit.setFocus(b)
    if (reduced()) return
    const dy = a.top - b.top
    this.box.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.22,1,.36,1)' })
  }

  private scrollDown(smooth = true) {
    requestAnimationFrame(() => this.thread.scrollTo({ top: this.thread.scrollHeight, behavior: smooth && !reduced() ? 'smooth' : 'auto' }))
  }

  // ---------------------------------------------------------------- sending
  private async submit(raw: string, echo = true) {
    const text = raw.trim().slice(0, 1000)
    if (!text) return
    const wait = Math.ceil((this.cooldownUntil - Date.now()) / 1000)
    if (wait > 0) {
      toast(`${BRAND.name} is cooling down. try again in ${wait}s.`)
      return
    }
    if (this.busy) {
      if (this.queued.length >= 2) {
        toast(`one moment — ${BRAND.name} is still answering.`)
        return
      }
      // still answering: show the message now, send it right after.
      if (echo) {
        this.input.value = ''
        this.autosize()
        this.sendBtn.disabled = true
        this.renderMsg({ role: 'user', text }, true)
      }
      this.queued.push(text)
      return
    }
    if (echo) {
      this.input.value = ''
      this.autosize()
    }
    this.sendBtn.disabled = true
    await this.openChat()
    if (echo) this.renderMsg({ role: 'user', text }, true)
    const r = this.box.getBoundingClientRect()
    this.orbit.rippleAt(r.left + r.width / 2, r.top, 0.7, 260)
    sound.play('tick')

    if (!this.me) {
      session.set('signal_pending', text)
      const live = this.backend.mode === 'api'
      await this.signalSays(
        isCommand(text)
          ? live ? 'uplink requested. first show me who you are: sign in with x, and i will explain the protocol.' : 'uplink requested. first tell me who you are: your x handle, and i will explain the protocol.'
          : live ? 'unidentified transmission. sign in with x first. i will keep what you said.' : 'unidentified transmission. give me your x handle first. i will keep what you said.',
        [{ type: 'signin' }],
      )
      return
    }

    this.busy = true
    this.orbit.setMode('thinking')
    const thinking = this.thinkingMsg(/\b(done|did|finished|x\.com|twitter\.com)\b/i.test(text) || text.length > 60)
    try {
      const res = await this.backend.send(text)
      thinking.remove()
      if (res.me) this.setMe(res.me)
      if (res.error === 'unauthorized') {
        this.me = null
        this.renderTop()
        session.set('signal_pending', text)
      }
      if (res.retryAfter) this.startCooldown(res.retryAfter)
      await this.signalSays(res.reply.text, res.reply.events ?? [])
    } catch (e) {
      thinking.remove()
      console.error(e)
      sound.play('err')
      await this.signalSays(e instanceof ApiUnavailable ? 'no carrier. the api is not responding.' : 'static on the line. try again in a moment.')
    } finally {
      this.busy = false
      this.orbit.setMode('idle')
      this.sendBtn.disabled = !this.input.value.trim()
      if (matchMedia('(pointer: fine)').matches) this.input.focus()
      const next = this.queued.shift()
      if (next) this.submit(next, false)
    }
  }

  /** A limit was hit: hold the composer until the server's retry time, with a countdown. */
  private startCooldown(seconds: number) {
    this.cooldownUntil = Date.now() + seconds * 1000
    this.queued = [] // they would only hit the same limit
    const base = `Transmit to ${BRAND.name}…`
    const tick = () => {
      const left = Math.ceil((this.cooldownUntil - Date.now()) / 1000)
      if (left <= 0) {
        this.input.placeholder = base
        return
      }
      this.input.placeholder = left > 120 ? `${BRAND.name} is out of range · back in ${Math.ceil(left / 60)} min` : `${BRAND.name} is out of range · ${left}s`
      setTimeout(tick, 1000)
    }
    tick()
  }

  /** A message from signal that is not stored (menu shortcuts, sign-in prompts). */
  private localMessage(text: string, events: ChatEvent[] = []) {
    this.openChat().then(() => this.signalSays(text, events))
  }

  private thinkingMsg(checking: boolean) {
    const spin = h('span', { class: 'spin' }, '')
    const state = h('span', { class: 'state' }, 'receiving')
    const el = h('div', { class: 'msg agent' }, h('div', { class: 'who' }, h('span', { class: 'sig' }, ''), BRAND.name, state, spin))
    this.inner.append(el)
    this.scrollDown()
    const frames = ['▁▂▃', '▂▃▅', '▃▅▆', '▅▆▇', '▃▅▆', '▂▃▅']
    let i = 0
    const id = window.setInterval(() => {
      spin.textContent = frames[i++ % frames.length]
      if (checking && i === 8) state.textContent = 'checking the link'
      if (checking && i === 22) state.textContent = 'still checking'
    }, 140)
    this.timers.add(id)
    return { remove: () => { clearInterval(id); this.timers.delete(id); el.remove() } }
  }

  /** signal's local messages, one after another (never two typing at once). */
  private signalSays(text: string, events: ChatEvent[] = []) {
    const run = this.sayChain.then(() => this.signalSaysNow(text, events))
    this.sayChain = run.catch(() => {})
    return run
  }

  private async signalSaysNow(text: string, events: ChatEvent[] = []) {
    const el = this.renderMsg({ role: 'agent', text: '', events: [] }, true)
    const body = el.querySelector<HTMLElement>('.text')!
    await this.typeInto(body, text)
    const box = el.querySelector<HTMLElement>('.events')!
    for (const ev of events) {
      const node = this.renderEvent(ev, true)
      if (node) {
        box.append(node)
        this.scrollDown()
        await sleep(reduced() ? 0 : 140)
      }
    }
  }

  private async typeInto(el: HTMLElement, text: string) {
    if (!text) return
    if (reduced()) {
      el.textContent = text
      this.scrollDown()
      return
    }
    const perFrame = Math.max(1, Math.round(text.length / 70))
    for (let i = 0; i <= text.length; i += perFrame) {
      const tail = text.slice(i, i + 3).replace(/\S/g, () => SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0])
      el.replaceChildren(text.slice(0, i), h('span', { class: 'scr' }, tail))
      if (i % (perFrame * 8) === 0) this.scrollDown(false)
      await new Promise((r) => requestAnimationFrame(r))
    }
    el.textContent = text
    this.scrollDown()
  }

  // ---------------------------------------------------------------- rendering
  private renderMsg(m: Msg, live: boolean) {
    let el: HTMLElement
    if (m.role === 'user') {
      el = h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, m.text))
    } else {
      const events = h('div', { class: 'events' })
      for (const ev of m.events ?? []) {
        const node = this.renderEvent(ev, false)
        if (node) events.append(node)
      }
      el = h('div', { class: 'msg agent' }, h('div', { class: 'who' }, h('span', { class: 'sig' }, ''), BRAND.name), h('div', { class: 'text' }, m.text), events)
    }
    if (!live) el.style.animation = 'none'
    this.inner.append(el)
    if (live) this.scrollDown()
    return el
  }

  private renderEvent(ev: ChatEvent, live: boolean): HTMLElement | null {
    switch (ev.type) {
      case 'task': {
        const card = h('div', { class: 'card task', 'data-task': ev.taskId })
        if (!this.cards.has(ev.taskId)) this.cards.set(ev.taskId, new Set())
        this.cards.get(ev.taskId)!.add(card)
        this.paintTask(card)
        return card
      }
      case 'reward': {
        const el = h('div', { class: 'reward' }, h('b', {}, `+${fmt(ev.amount)} ${BRAND.unit}`), `added to your pending allocation · ${ev.reason.toLowerCase()}`)
        if (live) requestAnimationFrame(() => {
          const r = el.getBoundingClientRect()
          this.orbit.burst(r.left + 40, r.top + r.height / 2)
          sound.play('reward')
        })
        return el
      }
      case 'wallet':
        return h('div', { class: 'reward' }, h('b', {}, 'wallet logged'), `${ev.address.slice(0, 6)}…${ev.address.slice(-6)}`)
      case 'invite':
        return this.inviteCard()
      case 'token':
        return this.tokenCard()
      case 'signin':
        return this.signinCard()
      case 'card':
        return this.me ? this.profileCard(null) : this.signinCard()
      case 'nft':
        return this.me ? this.nftCard() : this.signinCard()
      case 'minted':
        return this.receiptCard(ev)
      case 'launch':
        return this.launchCard()
      case 'log':
        return this.logCard()
    }
    return null
  }

  private refreshCards() {
    for (const [id, set] of this.cards) {
      for (const card of set) {
        if (!card.isConnected) set.delete(card)
        else this.paintTask(card)
      }
      if (!set.size) this.cards.delete(id)
    }
  }

  private paintTask(card: HTMLElement) {
    const id = card.dataset.task!
    const t = this.me?.tasks.find((x) => x.id === id)
    if (!t) {
      card.replaceChildren(h('div', { class: 'card-note' }, 'this trial is gone.'))
      return
    }
    const req = this.me!.tasks.filter((x) => x.required)
    const idx = req.findIndex((x) => x.id === id)
    const label = `${idx >= 0 ? `trial ${String(idx + 1).padStart(2, '0')}/${String(req.length).padStart(2, '0')}` : 'bonus trial'} · ${t.type === 'card' ? 'operator pass' : t.type === 'nftquote' ? 'nft quote' : t.type}`
    card.classList.toggle('done', t.status === 'done')
    const row = h('div', { class: 'card-row' })

    if (t.type === 'nftquote') {
      card.replaceChildren(
        h('div', { class: 'card-head' }, h('span', {}, label), h('span', { class: 'amt' }, `+${fmt(t.reward)} ${BRAND.unit}`)),
        h('div', { class: 'card-title' }, t.title),
        ...this.nftQuoteParts(t),
      )
      return
    }

    if (t.type === 'card') {
      card.replaceChildren(
        h('div', { class: 'card-head' }, h('span', {}, label), h('span', { class: 'amt' }, `+${fmt(t.reward)} ${BRAND.unit}`)),
        h('div', { class: 'card-title' }, t.title),
        ...this.profileParts(t),
      )
      return
    }
    if (t.status === 'done') {
      row.append(h('span', { class: 'status ok' }, '✓ verified'))
    } else if (t.verification === 'referral') {
      row.append(this.btn('Copy invite link', 'ghost', async () => toast((await copy(this.me!.refLink)) ? 'Invite link copied' : 'Copy failed', 'ok')))
      row.append(h('span', { class: 'status' }, `${this.me!.referrals.qualified}/${(t.params?.need as number) ?? 2} friends`))
    } else {
      if (t.actionUrl) {
        // A real link (not window.open): popup blockers and in-app browsers treat it as a user navigation.
        const label = t.type === 'reply' ? (t.status === 'opened' ? 'Reply again' : 'Reply on X') : t.status === 'opened' ? 'Open again' : 'Open on X'
        // Replies: each operator gets their own suggested text (shared/replies.mjs); "Reply again" moves on.
        const step = this.replySteps.get(t.id) ?? 0
        const href = t.type === 'reply' ? withReply(t.actionUrl, pickReply(this.me!.user.username, step)) : t.actionUrl
        const open = h('a', { class: `btn ${t.status === 'opened' ? 'ghost' : ''}`, href, target: '_blank', rel: 'noopener', onclick: () => {
          if (t.type === 'reply') this.replySteps.set(t.id, step + 1)
          this.openTask(t, open)
        } }, label)
        open.append(svg(ICON.out))
        row.append(open)
      }
      if (t.status === 'opened' && t.verification === 'timer') {
        const done = this.btn('I did it', '', () => this.submit(`done — ${t.title.toLowerCase()}`))
        const status = h('span', { class: 'status wait' })
        row.append(done, status)
        this.countdown(t, done as HTMLButtonElement, status)
      }
      if (t.verification === 'reply_url') row.append(h('span', { class: 'status' }, t.type === 'reply'
        ? 'post the reply, then paste its link in the chat ↓'
        : t.status === 'opened' ? 'paste your post link in the chat ↓' : 'post, then paste the link'))
    }
    card.replaceChildren(
      h('div', { class: 'card-head' }, h('span', {}, label), h('span', { class: 'amt' }, `+${fmt(t.reward)} ${BRAND.unit}`)),
      h('div', { class: 'card-title' }, t.title),
      row,
    )
  }

  private countdown(t: Task, btn: HTMLButtonElement, status: HTMLElement) {
    const offset = (this.me?.serverNow ?? Date.now()) - Date.now()
    let first = true
    const tick = () => {
      const left = Math.ceil(t.waitSec - (Date.now() + offset - (t.openedAt ?? 0)) / 1000)
      if (!first && !btn.isConnected) return clearInterval(id)
      first = false
      if (left > 0) {
        btn.disabled = true
        status.textContent = `verifying… ${left}s`
      } else {
        btn.disabled = this.busy
        status.textContent = ''
        clearInterval(id)
      }
    }
    const id = window.setInterval(tick, 250)
    tick()
  }

  private btn(label: string, kind: string, fn: () => void, icon?: string) {
    const b = h('button', { class: `btn ${kind}`, type: 'button', onclick: fn }, label)
    if (icon) b.append(svg(icon))
    return b
  }

  private async openTask(t: Task, btn: HTMLElement) {
    const r = btn.getBoundingClientRect()
    this.orbit.rippleAt(r.left + r.width / 2, r.top + r.height / 2, 0.8, 140)
    try {
      const res = await this.backend.openTask(t.id)
      if (res.ok && this.me) {
        const task = this.me.tasks.find((x) => x.id === t.id)
        if (task && task.status === 'todo') {
          task.status = 'opened'
          task.openedAt = res.openedAt ?? Date.now()
          this.me.serverNow = Date.now()
        }
        this.refreshCards()
      } else if (res.error === 'unauthorized') toast('Sign in again.', 'err')
    } catch {
      toast('No carrier. Try again.', 'err')
    }
  }

  // ---------------------------------------------------------------- the operator pass
  /** The pass image for the current state; re-drawn only when something on it changes. */
  private cardArtNow() {
    const me = this.me!
    const req = me.tasks.filter((t) => t.required)
    const theme = ((document.documentElement.dataset.theme as Theme) || 'dark') as Theme
    const data = {
      handle: me.user.username,
      allocation: me.allocation,
      trials: { done: req.filter((t) => t.status === 'done').length, total: req.length },
      rank: me.standing?.rank ?? null,
      operators: me.standing?.total ?? null,
      no: me.standing?.no ?? null,
      joinedAt: me.standing?.joinedAt ?? null,
      theme,
    }
    const key = JSON.stringify(data)
    if (this.cardArt?.key === key) return this.cardArt
    const old = this.cardArt
    const blob = renderCard(data).then(cardBlob)
    const art = { key, blob, url: blob.then((b) => URL.createObjectURL(b)), ready: null as string | null }
    art.url.then((u) => {
      art.ready = u
      if (old?.ready) setTimeout(() => URL.revokeObjectURL(old.ready!), 4000)
    })
    this.cardArt = art
    return art
  }

  /** Pass image + actions. With the pass trial: also "Open post → Quote" and how to finish it. */
  private profileParts(task: Task | null): HTMLElement[] {
    const me = this.me!
    const art = this.cardArtNow()
    const name = `signal-pass-${me.user.username}.png`
    const img = h('img', { class: 'pcard-img', alt: `operator pass for @${me.user.username}: ${fmt(me.allocation)} ${BRAND.unit} pending`, width: CARD_W, height: CARD_H, decoding: 'async' }) as HTMLImageElement
    const frame = h('div', { class: 'pcard' }, img)
    img.addEventListener('load', () => frame.classList.add('in'))
    img.addEventListener('error', () => frame.classList.add('broken'))
    if (art.ready) {
      img.src = art.ready
      frame.classList.add('in')
    } else art.url.then((u) => (img.src = u)).catch(() => frame.classList.add('broken'))

    const row = h('div', { class: 'card-row' })
    row.append(this.btn('Copy image', '', () => this.copyCard(art.blob, name)))
    if (task && task.status !== 'done') {
      // X has no link that opens its quote box. The sure way: open the pinned post, tap Repost → Quote.
      const href = `https://x.com/${BRAND.xHandle}/status/${BRAND.postId}`
      const post = h('a', { class: 'btn ghost', href, target: '_blank', rel: 'noopener', onclick: () => this.openTask(task, post) }, 'Open post → Quote')
      post.append(svg(ICON.out))
      row.append(post)
    }
    if (this.canShareFiles()) row.append(this.btn('Share', 'ghost', () => this.shareCard(art.blob, name)))
    else row.append(this.btn('Save', 'ghost', async () => this.saveCard(await art.blob, name)))

    const parts: HTMLElement[] = [frame, row]
    // The words for the quote, ready to copy in one tap.
    if (task && task.status !== 'done') {
      const quote = `signal acquired. operator ${callsign(me.user.username)}, ${fmt(me.allocation)} ${BRAND.unit} pending in the reserve 🛰️\n\nis anyone out there? ${me.refLink.replace(/^https?:\/\//, '')}`
      const copyText = async () => toast((await copy(quote)) ? 'Quote text copied' : 'Copy failed', 'ok')
      const box = h('button', { class: 'mono-box quote-text', type: 'button', title: 'Tap to copy', onclick: copyText }, quote)
      parts.push(h('div', { class: 'quote-wrap' }, h('div', { class: 'card-head' }, h('span', {}, 'text for your quote'), h('span', { class: 'amt' }, 'tap to copy')), box,
        h('div', { class: 'card-row' }, this.btn('Copy text', '', copyText))))
    }
    if (task?.status === 'done') row.append(h('span', { class: 'status ok' }, '✓ verified'))
    else if (task) parts.push(h('div', { class: 'card-note' }, matchMedia('(pointer: coarse)').matches
      ? '1. save the pass  2. copy text  3. open post → quote: tap repost ⟲ → quote  4. paste the text, attach the pass, post  5. paste your quote link here ↓'
      : '1. open post → quote: click repost ⟲ → quote  2. copy image → paste it there (ctrl/⌘ v)  3. copy text → paste it there  4. post  5. paste your quote link here ↓'))
    return parts
  }

  private profileCard(task: Task | null) {
    const me = this.me!
    const nft = me.nft?.eligible && me.nft.mint?.status !== 'minted'
      ? [h('div', { class: 'card-row' }, this.btn('Mint it as an NFT', 'ghost', () => this.localMessage('your pass, as a compressed nft. one per person, the reserve pays the gas.', [{ type: 'nft' }])),
          h('span', { class: 'status' }, 'free · solana'))]
      : []
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', {}, 'your operator pass'), h('span', { class: 'amt' }, verdict(me.allocation))),
      ...this.profileParts(task),
      ...nft,
    )
  }

  // ---------------------------------------------------------------- the NFT
  private nftCard() {
    const card = h('div', { class: 'card nft-card' })
    this.nftCards.add(card)
    this.paintNft(card)
    return card
  }

  private paintNfts() {
    for (const c of this.nftCards) {
      if (!c.isConnected) this.nftCards.delete(c)
      else this.paintNft(c)
    }
  }

  private paintNft(card: HTMLElement) {
    const me = this.me
    const n = me?.nft
    if (!me || !n || !this.backend.nftMint) {
      card.replaceChildren(h('div', { class: 'card-head' }, h('span', {}, 'nft'), h('span', { class: 'amt' }, 'soon')),
        h('div', { class: 'card-note' }, this.backend.mode === 'demo' ? 'demo mode: minting needs the live site.' : `not open yet. watch @${BRAND.xHandle}.`))
      return
    }
    const mint = n.mint
    if (n.eligible && n.ready === false && !mint) {
      const left = me.tasks.filter((t) => t.params?.mint === true && t.status !== 'done').length
      card.replaceChildren(h('div', { class: 'card-head' }, h('span', {}, 'your nft · solana'), h('span', { class: 'amt' }, `${left} trial${left === 1 ? '' : 's'} left`)),
        h('div', { class: 'card-note' }, 'the mint opens after your trials on x.'),
        h('div', { class: 'card-row' }, this.btn('Show my trials', '', () => this.submit('/mintallo'))))
      return
    }
    if (!n.eligible && !mint) {
      card.replaceChildren(h('div', { class: 'card-head' }, h('span', {}, 'nft'), h('span', { class: 'amt' }, 'closed')),
        h('div', { class: 'card-note' }, `minting is open for a few operators first. watch @${BRAND.xHandle}.`))
      return
    }

    // The picture: kept between repaints so it does not flash.
    const key = `${me.allocation}-${me.standing?.rank ?? ''}`
    const src = mint?.status === 'minted' ? `/nft/${mint.id}.png?v=${encodeURIComponent(key)}` : this.backend.nftPreviewUrl!(key)
    let frame = card.querySelector<HTMLElement>('.pcard')
    if (!frame || frame.dataset.src !== src) {
      const img = h('img', { class: 'pcard-img', alt: `nft for @${me.user.username}: ${fmt(me.allocation)} ${BRAND.unit}, approved`, width: 1200, height: 1200, decoding: 'async', src }) as HTMLImageElement
      const f = h('div', { class: 'pcard square', 'data-src': src }, img)
      img.addEventListener('load', () => f.classList.add('in'))
      img.addEventListener('error', () => f.classList.add('broken'))
      frame = f
    }

    const head = h('div', { class: 'card-head' }, h('span', {}, 'your nft · solana'),
      h('span', { class: 'amt stamp-approved' }, 'approved'))
    const parts: HTMLElement[] = [head, frame]
    const row = h('div', { class: 'card-row' })

    if (mint?.status === 'minted') {
      row.append(h('span', { class: 'status ok' }, `✓ minted to ${short(mint.owner)}`))
      if (mint.assetId) row.append(this.link('View NFT', nftPage(mint.assetId, mint.network)))
      if (mint.signature) row.append(this.link('Transaction', scan('tx', mint.signature, mint.network)))
      parts.push(row, h('div', { class: 'card-note' }, `the picture lives on ${BRAND.site.replace(/^https?:\/\//, '')} and follows your allocation: when it grows, so does the number on your nft. wallets refresh it on their own schedule.`))
    } else if (this.nftBusy || mint?.status === 'sent' || mint?.status === 'minting') {
      const b = this.btn('Minting…', '', () => {}) as HTMLButtonElement
      b.disabled = true
      row.append(b, h('span', { class: 'status wait nft-wait' }, mint?.status === 'sent' ? 'landing on solana' : 'writing to solana'))
      if (mint?.signature) row.append(this.link('Transaction', scan('tx', mint.signature, mint.network)))
      parts.push(row)
      // Came back to a mint still on its way (reload): check on it once.
      if (!this.nftBusy && !this.nftPolling && !this.nftAutoPolled) {
        this.nftAutoPolled = true
        void this.pollNft()
      }
    } else {
      const saved = me.wallet && SOLANA.test(me.wallet) ? me.wallet : null
      let input: HTMLInputElement | null = null
      if (saved) parts.push(h('div', { class: 'card-note' }, 'mints to ', h('b', { class: 'mono' }, short(saved)), ' (your saved wallet)'))
      else {
        input = h('input', { placeholder: 'your solana wallet', 'aria-label': 'Your Solana wallet', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', maxlength: 44, enterkeyhint: 'go' }) as HTMLInputElement
        input.addEventListener('keydown', (e) => e.key === 'Enter' && this.mintNft(input))
        parts.push(h('div', { class: 'handle-row' }, input))
        parts.push(h('div', { class: 'card-note' }, me.wallet
          ? 'your saved wallet is not on solana, so this one is used for the nft only.'
          : 'it is also saved as your payout wallet (once set, only the team can change it).'))
      }
      row.append(this.btn(mint?.status === 'failed' ? 'Try again' : 'Mint my NFT', '', () => this.mintNft(input)), h('span', { class: 'status' }, 'free · one per person'))
      parts.push(row)
      if (mint?.status === 'failed') parts.push(h('div', { class: 'card-note' }, 'the last mint did not land. nothing was minted, nothing was charged.'))
    }
    card.replaceChildren(...parts)
  }

  private link(label: string, href: string) {
    const a = h('a', { class: 'btn ghost', href, target: '_blank', rel: 'noopener' }, label)
    a.append(svg(ICON.out))
    return a
  }

  private setNftMint(mint: NftMint | null | undefined) {
    if (!this.me?.nft || !mint) return
    const was = this.me.nft.mint?.status
    this.me.nft.mint = mint
    this.paintNfts()
    if (mint.status === 'minted' && was !== 'minted') {
      toast('Minted. It is in your wallet.', 'ok')
      const btn = [...this.nftCards].at(-1)?.querySelector('.status.ok')
      if (btn) {
        const r = btn.getBoundingClientRect()
        this.orbit.burst(r.left + 40, r.top + r.height / 2)
      }
    }
  }

  private async mintNft(input: HTMLInputElement | null) {
    if (this.nftBusy || !this.backend.nftMint) return
    const wallet = input?.value.trim() ?? ''
    if (input && !SOLANA.test(wallet)) {
      toast(NFT_ERRORS.bad_wallet, 'err')
      input.focus()
      return
    }
    this.nftBusy = true
    this.paintNfts()
    try {
      const r = await this.backend.nftMint(input ? wallet : undefined)
      if (r.ok && r.mint) {
        this.setNftMint(r.mint)
        this.sayAll(r.messages)
        if (r.mint.status !== 'minted') void this.pollNft()
      } else {
        toast(NFT_ERRORS[r.error ?? ''] ?? 'Could not mint. Try again.', 'err')
        if (r.error === 'busy') void this.pollNft()
      }
    } catch (e) {
      toast(e instanceof ApiUnavailable ? 'The service is not responding.' : 'No carrier. Try again.', 'err')
    } finally {
      this.nftBusy = false
      // The wallet may have been saved; the stamp may have moved.
      try {
        this.setMe(await this.backend.me())
      } catch {}
      this.paintNfts()
    }
  }

  /** signal's message from the server after a mint: the receipt (its button offers the quote task). */
  private sayAll(msgs: Msg[] | undefined) {
    if (!msgs?.length) return
    // The quote task card needs the task in `me`; it arrives with the next /api/me.
    void this.backend.me().then((me) => this.setMe(me)).catch(() => {}).finally(() => {
      for (const m of msgs) this.signalSays(m.text, m.events ?? [])
    })
  }

  /** The mint receipt: what was minted, where it went, and the transaction on Solscan. */
  private receiptCard(ev: MintedEvent) {
    const net = ev.network === 'devnet' ? 'devnet' : 'mainnet'
    const thumb = h('img', { class: 'rcpt-thumb', alt: 'your nft', width: 1200, height: 1200, decoding: 'async', src: `/nft/${ev.id}.png` }) as HTMLImageElement
    thumb.addEventListener('error', () => thumb.classList.add('broken'))
    const row = (k: string, v: string | HTMLElement) => h('div', { class: 'rcpt-row' }, h('span', {}, k), h('i'), typeof v === 'string' ? h('b', {}, v) : v)
    const txLink = ev.signature
      ? h('a', { href: scan('tx', ev.signature, net), target: '_blank', rel: 'noopener' }, `${short(ev.signature)} ↗`)
      : '—'
    const links = h('div', { class: 'card-row' })
    if (ev.signature) links.append(this.link('View transaction', scan('tx', ev.signature, net)))
    links.append(ev.assetId ? this.link('View NFT', nftPage(ev.assetId, net)) : this.link('Open image', `/nft/${ev.id}.png`))
    const cta = h('div', { class: 'quote-cta' })
    this.quoteCtas.add(cta)
    this.paintQuoteCta(cta)
    return h('div', { class: 'card receipt' },
      h('div', { class: 'card-head' }, h('span', {}, 'mint receipt'), h('span', { class: 'amt stamp-approved' }, '✓ confirmed')),
      h('div', { class: 'rcpt' }, thumb,
        h('div', { class: 'rcpt-rows' },
          row('nft', this.me ? `${BRAND.name} · @${this.me.user.username}` : 'operator pass'),
          row('stamp', 'approved'),
          row('to', short(ev.owner)),
          row('chain', `solana ${net}`),
          row('tx', txLink),
          row('you paid', '0 SOL'))),
      links,
      cta,
    )
  }

  /** The launch: a live countdown to BRAND.launch.at, then "live". */
  private launchCard() {
    const at = Date.parse(BRAND.launch.at)
    const unit = (label: string) => {
      const n = h('b', {}, '00')
      return { n, el: h('div', { class: 'cd-unit' }, n, h('small', {}, label)) }
    }
    const d = unit('days'), hh = unit('hours'), mm = unit('min'), ss = unit('sec')
    const clock = h('div', { class: 'cd' }, d.el, hh.el, mm.el, ss.el)
    const state = h('span', { class: 'amt' }, 'countdown')
    const swap = this.swapBlock()
    const card = h('div', { class: 'card launch' },
      h('div', { class: 'card-head' }, h('span', {}, `${BRAND.unit} launch`), state),
      clock, swap.el)
    const pad = (n: number) => String(n).padStart(2, '0')
    let first = true
    const tick = () => {
      if (!first && !card.isConnected) return clearInterval(id)
      first = false
      const left = at - Date.now()
      if (left <= 0) {
        clock.replaceChildren(h('div', { class: 'cd-live' }, `${BRAND.unit} is live`))
        state.textContent = 'live'
        state.classList.add('stamp-approved')
        swap.live()
        return clearInterval(id)
      }
      const s = Math.floor(left / 1000)
      d.el.hidden = s < 86400
      d.n.textContent = pad(Math.floor(s / 86400))
      hh.n.textContent = pad(Math.floor((s % 86400) / 3600))
      mm.n.textContent = pad(Math.floor((s % 3600) / 60))
      ss.n.textContent = pad(s % 60)
    }
    const id = window.setInterval(tick, 1000)
    this.timers.add(id)
    tick()
    return card
  }

  /** Under the countdown: your NFT → your $SIG, and a Swap button that stays locked until the launch. */
  private swapAmounts = new Set<HTMLElement>()
  private swapBlock() {
    const me = this.me
    const mint = me?.nft?.mint
    const src = mint?.status === 'minted' ? `/nft/${mint.id}.png` : me?.nft?.eligible && this.backend.nftPreviewUrl ? this.backend.nftPreviewUrl('swap') : null
    const nft = src
      ? h('img', { class: 'swap-nft', alt: 'your nft', width: 1200, height: 1200, decoding: 'async', src })
      : h('div', { class: 'swap-nft empty' }, 'nft')
    const amount = h('b', {}, fmt(me?.allocation ?? 0))
    this.swapAmounts.add(amount)
    const arrow = h('div', { class: 'swap-arrow', 'aria-hidden': 'true' }, h('i', {}, '›'), h('i', {}, '›'), h('i', {}, '›'))
    const lock = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>'
    const btn = h('button', { class: 'btn swap-btn', type: 'button', disabled: true }, svg(lock), 'Swap', h('small', {}, 'opens at launch')) as HTMLButtonElement
    const wrap = h('div', { class: 'swap-btn-wrap' }, btn)
    const el = h('div', { class: 'swap' },
      h('div', { class: 'swap-row' },
        h('div', { class: 'swap-side' }, nft, h('small', {}, 'your nft')),
        arrow,
        h('div', { class: 'swap-side token' }, h('div', { class: 'swap-amt' }, amount, h('span', {}, `${BRAND.unit}`)), h('small', {}, 'pending allocation'))),
      wrap)
    return {
      el,
      /** The launch has happened: a real link once BRAND.swap.url is set; until then, still locked. */
      live: () => {
        if (BRAND.swap.url) {
          const a = h('a', { class: 'btn swap-btn on', href: BRAND.swap.url, target: '_blank', rel: 'noopener' }, 'Swap')
          a.append(svg(ICON.out))
          wrap.replaceChildren(a)
        } else {
          btn.replaceChildren(svg(lock), 'Swap', h('small', {}, 'opens soon'))
        }
      },
    }
  }

  /** "Get +1,000 $SIG" under the receipt / minted NFT: opens the quote task; "✓ earned" once done. */
  private quoteCtas = new Set<HTMLElement>()
  private paintQuoteCta(el: HTMLElement) {
    const q = this.me?.tasks.find((t) => t.id === 'nft-quote')
    if (!q) return void el.replaceChildren()
    if (q.status === 'done') return void el.replaceChildren(h('span', { class: 'status ok' }, `✓ +${fmt(q.reward)} ${BRAND.unit} earned for the quote`))
    const b = this.btn(`Get +${fmt(q.reward)} ${BRAND.unit}`, 'reward-btn', () => {
      const offer = nftQuoteOffer(q)
      this.localMessage(offer.text, offer.events)
    })
    el.replaceChildren(b, h('span', { class: 'status' }, 'quote your nft on x'))
  }
  private paintQuoteCtas() {
    for (const el of this.quoteCtas) {
      if (!el.isConnected) this.quoteCtas.delete(el)
      else this.paintQuoteCta(el)
    }
  }

  /** The NFT quote task: the NFT image, the pinned post to quote, and the words to paste. */
  private nftBlobs = new Map<string, Promise<Blob>>()
  private nftQuoteParts(task: Task): HTMLElement[] {
    const me = this.me!
    const mint = me.nft?.mint
    if (!mint || mint.status !== 'minted') return [h('div', { class: 'card-note' }, 'mint your nft first: type /mintallo.')]
    const src = `/nft/${mint.id}.png`
    const blob = () => {
      if (!this.nftBlobs.has(mint.id)) {
        const p = fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('image'))))
        p.catch(() => this.nftBlobs.delete(mint.id))
        this.nftBlobs.set(mint.id, p)
      }
      return this.nftBlobs.get(mint.id)!
    }
    const name = `signal-nft-${me.user.username}.png`
    const img = h('img', { class: 'pcard-img', alt: `your nft`, width: 1200, height: 1200, decoding: 'async', src }) as HTMLImageElement
    const frame = h('div', { class: 'pcard square small' }, img)
    img.addEventListener('load', () => frame.classList.add('in'))
    img.addEventListener('error', () => frame.classList.add('broken'))

    const row = h('div', { class: 'card-row' })
    row.append(this.btn('Copy image', '', () => this.copyCard(blob(), name)))
    if (task.status !== 'done') {
      const href = `https://x.com/${BRAND.xHandle}/status/${BRAND.postId}`
      const post = h('a', { class: 'btn ghost', href, target: '_blank', rel: 'noopener', onclick: () => this.openTask(task, post) }, 'Open post → Quote')
      post.append(svg(ICON.out))
      row.append(post)
    }
    if (this.canShareFiles()) row.append(this.btn('Share', 'ghost', () => this.shareCard(blob(), name)))
    else row.append(this.btn('Save', 'ghost', async () => this.saveCard(await blob(), name)))
    const parts: HTMLElement[] = [frame, row]
    if (task.status === 'done') {
      row.append(h('span', { class: 'status ok' }, '✓ verified'))
      return parts
    }
    const quote = `just minted my ${BRAND.name} operator pass on solana. approved by the reserve 🛰️\n\nis anyone out there? ${me.refLink.replace(/^https?:\/\//, '')}`
    const copyText = async () => toast((await copy(quote)) ? 'Quote text copied' : 'Copy failed', 'ok')
    parts.push(h('div', { class: 'quote-wrap' }, h('div', { class: 'card-head' }, h('span', {}, 'text for your quote'), h('span', { class: 'amt' }, 'tap to copy')),
      h('button', { class: 'mono-box quote-text', type: 'button', title: 'Tap to copy', onclick: copyText }, quote),
      h('div', { class: 'card-row' }, this.btn('Copy text', '', copyText))))
    parts.push(h('div', { class: 'card-note' }, matchMedia('(pointer: coarse)').matches
      ? '1. save the nft image  2. copy text  3. open post → quote: tap repost ⟲ → quote  4. paste the text, attach the image, post  5. paste your quote link here ↓'
      : '1. open post → quote: click repost ⟲ → quote  2. copy image → paste it there (ctrl/⌘ v)  3. copy text → paste it there  4. post  5. paste your quote link here ↓'))
    return parts
  }

  /** A mint is on its way: ask the server (which asks Solana) until it lands or fails. */
  private async pollNft() {
    if (this.nftPolling || !this.backend.nftStatus) return
    this.nftPolling = true
    try {
      for (let i = 0; i < 40; i++) {
        await sleep(3000)
        const r = await this.backend.nftStatus().catch(() => null)
        if (!r?.ok) continue
        if (r.mint) this.setNftMint(r.mint)
        this.sayAll(r.messages)
        if (!r.mint || r.mint.status === 'minted' || r.mint.status === 'failed') break
      }
    } finally {
      this.nftPolling = false
      this.paintNfts()
    }
  }

  private canShareFiles() {
    try {
      const f = new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' })
      return matchMedia('(pointer: coarse)').matches && !!navigator.canShare?.({ files: [f] })
    } catch {
      return false
    }
  }

  /** Copy the PNG to the clipboard; where that is blocked (some in-app browsers), share or save it. */
  private async copyCard(blob: Promise<Blob>, name: string) {
    try {
      // Called before any await: Safari only allows clipboard writes inside the click itself.
      const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
      if (!CI || !navigator.clipboard?.write) throw new Error('no image clipboard')
      await navigator.clipboard.write([new CI({ 'image/png': blob })])
      toast('Pass copied. Paste it into your post.', 'ok')
      sound.play('ok')
    } catch {
      if (this.canShareFiles() && (await this.shareCard(blob, name))) return
      this.saveCard(await blob, name)
      toast('Copying images is blocked here, so the pass was saved instead.')
    }
  }

  private async shareCard(blob: Promise<Blob>, name: string) {
    try {
      const file = new File([await blob], name, { type: 'image/png' })
      await navigator.share({ files: [file], text: `is anyone out there? · ${this.me?.refLink ?? BRAND.site}` })
      return true
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return true // they closed the sheet
      return false
    }
  }

  private saveCard(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: name, style: 'display:none' })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  // ---------------------------------------------------------------- the log (leaderboard)
  private logCard() {
    const list = h('ol', { class: 'log' }, h('li', { class: 'log-empty' }, 'tuning in…'))
    const mine = h('div', { class: 'card-note' })
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', {}, 'the log · top operators'), h('span', { class: 'amt' }, this.backend.mode === 'demo' ? 'demo · only you' : `pending ${BRAND.unit} · live`)),
      list, mine)
    this.backend.leaderboard().then((rows: LogRow[]) => {
      if (!rows.length) {
        list.replaceChildren(h('li', { class: 'log-empty' }, 'nobody has got through yet. be the first.'))
        return
      }
      const me = this.me?.user.username
      list.replaceChildren(...rows.slice(0, 25).map((r) => h('li', { class: r.username === me ? 'me' : '' },
        h('span', { class: 'log-rank' }, `#${r.rank}`),
        h('span', { class: 'log-name' }, `@${r.username}`),
        h('i'),
        h('b', {}, fmt(r.points)))))
      const st = this.me?.standing
      if (st && !rows.slice(0, 25).some((r) => r.username === me)) mine.textContent = `you: #${fmt(st.rank)} of ${fmt(st.total)} · ${fmt(this.me!.allocation)} ${BRAND.unit}`
      this.scrollDown()
    }).catch(() => list.replaceChildren(h('li', { class: 'log-empty' }, 'no carrier. the log did not load.')))
    return card
  }

  private inviteCard() {
    const me = this.me
    if (!me) return this.signinCard()
    const share = `https://x.com/intent/tweet?text=${encodeURIComponent(`talking my way into the ${BRAND.unit} reserve. ${BRAND.name} is tough. your turn:`)}&url=${encodeURIComponent(me.refLink)}`
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', {}, 'your invite link'), h('span', { class: 'amt' }, `${fmt(me.allocation)} ${BRAND.unit} pending`)),
      h('div', { class: 'mono-box' }, me.refLink),
      h('div', { class: 'card-row' },
        this.btn('Copy', '', async () => toast((await copy(me.refLink)) ? 'Invite link copied' : 'Copy failed', 'ok')),
        h('a', { class: 'btn ghost', href: share, target: '_blank', rel: 'noopener' }, 'Share on X'),
        h('span', { class: 'status' }, `${me.referrals.qualified} joined · ${me.referrals.total - me.referrals.qualified} pending`)),
    )
  }

  private tokenCard() {
    const ca = BRAND.token.ca
    if (!ca) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('span', {}, `${BRAND.unit} · contract`), h('span', { class: 'amt' }, 'launching soon')),
        h('div', { class: 'card-note' }, `no contract exists yet. the only real one will be posted on @${BRAND.xHandle}.`),
        h('div', { class: 'card-row' }, h('a', { class: 'btn ghost', href: `https://x.com/${BRAND.xHandle}`, target: '_blank', rel: 'noopener' }, `@${BRAND.xHandle}`)),
      )
    }
    const caBox = h('button', { class: 'mono-box', type: 'button', style: 'text-align:left;background:none;color:inherit;cursor:copy', onclick: async () => {
      if (await copy(ca)) {
        toast('Contract copied', 'ok')
        const r = caBox.getBoundingClientRect()
        this.orbit.rippleAt(r.left + r.width / 2, r.top + r.height / 2, 1, 160)
      }
    } }, ca)
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('span', {}, `${BRAND.unit} · ${BRAND.token.chain} contract`), h('span', { class: 'amt' }, 'tap to copy')),
      caBox,
      h('div', { class: 'card-row' }, ...tokenLinks(ca).map((l) => h('a', { class: 'btn ghost', href: l.url, target: '_blank', rel: 'noopener' }, l.label))),
    )
  }

  /** Live: "Sign in with X" (OAuth on our server). Demo: type a handle. */
  private signinCard() {
    const card = h('div', { class: 'card' })
    if (this.backend.mode === 'api' && this.backend.xSignInUrl) {
      const go = h('a', { class: 'btn', href: this.backend.xSignInUrl(location.pathname), onclick: () => card.classList.add('leaving') })
      go.append(svg(ICON.x), 'Sign in with X')
      card.append(
        h('div', { class: 'card-head' }, h('span', {}, 'identify'), h('span', { class: 'amt' }, 'x account')),
        h('div', { class: 'card-row' }, go),
        h('div', { class: 'card-note' }, 'we only read your public profile: handle and avatar. no posting, no dms, nothing kept from x.'),
      )
      return card
    }
    const done = async () => {
      this.me = await this.backend.me()
      this.history = await this.backend.history()
      this.historyLoaded = true
      this.renderTop()
      card.replaceChildren(h('div', { class: 'status ok' }, `✓ identified as @${this.me?.user.username}`))
      sound.play('ok')
      await this.afterSignIn()
    }

    const input = h('input', { id: 'signin-handle', placeholder: '@yourhandle', 'aria-label': 'Your X handle', autocapitalize: 'off', autocomplete: 'username', spellcheck: 'false', maxlength: 16, enterkeyhint: 'go' }) as HTMLInputElement
    const note = h('div', { class: 'card-note' }, this.backend.mode === 'demo' ? 'demo mode: nothing leaves this browser.' : 'just your x handle. no password, no x login.')
    const go = async () => {
      const handle = input.value.trim().replace(/^@/, '')
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        toast('X handles are 1–15 letters, numbers or _.', 'err')
        return
      }
      btn.disabled = true
      try {
        const r = await this.backend.login(handle)
        if (r.ok) return void (await done())
        toast(r.message ?? `Could not sign in (${r.error ?? 'server error'}).`, 'err')
      } catch (e) {
        toast(e instanceof ApiUnavailable ? 'The service is not responding.' : 'Could not sign in. Try again.', 'err')
      } finally {
        btn.disabled = false
      }
    }
    const btn = this.btn('Enter', '', go) as HTMLButtonElement
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go())
    card.replaceChildren(
      h('div', { class: 'card-head' }, h('span', {}, this.backend.mode === 'demo' ? 'demo sign-in' : 'identify'), h('span', { class: 'amt' }, 'x handle')),
      h('div', { class: 'handle-row' }, input, btn),
      note,
    )
    requestAnimationFrame(() => input.focus())
    return card
  }
}
