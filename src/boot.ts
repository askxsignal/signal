// The boot screen: a few telemetry lines while the dish finds a carrier. Once per session, under 4 s,
// skipped by any key or tap, and not at all with reduced motion.

import { h, session } from './util'

const LINES = [
  ['cold start', 'ok'],
  ['clock drift', '+00:41:07'],
  ['solar array L', 'damaged'],
  ['solar array R', '61%'],
  ['dish alignment', 'searching'],
  ['carrier', 'acquired'],
] as const

export function boot(): Promise<void> {
  if (session.get('signal_booted') || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve()
  session.set('signal_booted', '1')
  return new Promise((resolve) => {
    const list = h('ol', { class: 'boot-lines' })
    const skip = h('button', { class: 'boot-skip', type: 'button' }, 'skip')
    const el = h('div', { class: 'boot', role: 'status', 'aria-live': 'polite' }, h('p', { class: 'boot-head' }, 'signal // uplink'), list, skip)
    document.body.append(el)
    let done = false
    const timers: number[] = []
    const finish = () => {
      if (done) return
      done = true
      timers.forEach(clearTimeout)
      removeEventListener('keydown', finish)
      el.classList.add('out')
      setTimeout(() => el.remove(), 450)
      resolve()
    }
    skip.addEventListener('click', finish)
    el.addEventListener('pointerdown', finish)
    addEventListener('keydown', finish)
    LINES.forEach(([k, v], i) => {
      timers.push(window.setTimeout(() => {
        const bad = v === 'damaged'
        list.append(h('li', {}, h('span', {}, k), h('i'), h('b', { class: bad ? 'bad' : v === 'acquired' ? 'good' : '' }, v)))
      }, 180 + i * 330))
    })
    timers.push(window.setTimeout(finish, 180 + LINES.length * 330 + 700))
  })
}
