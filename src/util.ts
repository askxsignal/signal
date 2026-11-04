// Tiny DOM + formatting helpers.

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, String(v))
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid)
  return el
}

export const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const store = {
  get(k: string) {
    try { return localStorage.getItem(k) } catch { return null }
  },
  set(k: string, v: string | null) {
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ }
  },
}
export const session = {
  get(k: string) {
    try { return sessionStorage.getItem(k) } catch { return null }
  },
  set(k: string, v: string | null) {
    try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v) } catch { /* private mode */ }
  },
}

let toastTimer = 0
export function toast(text: string, kind: 'ok' | 'err' | 'info' = 'info') {
  let el = document.querySelector<HTMLDivElement>('.toast')
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' })
    document.body.append(el)
  }
  el.textContent = text
  el.dataset.kind = kind
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el!.classList.remove('on'), 2600)
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement
    ta.value = text
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

// ---------------------------------------------------------------- sound
// Synthesised blips only (no files), off until the visitor turns them on.
let audio: AudioContext | null = null
export const sound = {
  get on() {
    return store.get('signal_sound') === '1'
  },
  set(on: boolean) {
    store.set('signal_sound', on ? '1' : null)
    if (on) this.play('ok')
  },
  play(kind: 'tick' | 'ok' | 'reward' | 'err') {
    if (!this.on) return
    try {
      audio ??= new AudioContext()
      const notes = { tick: [1320], ok: [880, 1320], reward: [660, 990, 1480], err: [220, 180] }[kind]
      const t0 = audio.currentTime
      notes.forEach((f, i) => {
        const o = audio!.createOscillator()
        const g = audio!.createGain()
        o.type = kind === 'err' ? 'sawtooth' : 'square'
        o.frequency.value = f
        g.gain.setValueAtTime(0.0001, t0 + i * 0.07)
        g.gain.exponentialRampToValueAtTime(0.035, t0 + i * 0.07 + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.07 + 0.09)
        o.connect(g).connect(audio!.destination)
        o.start(t0 + i * 0.07)
        o.stop(t0 + i * 0.07 + 0.1)
      })
    } catch {
      /* no audio here */
    }
  },
}
