// The live sky: stars, the earth turning below, debris, far satellites and signal itself, all as character
// cells on one canvas. Pings (clicks, sends) and bursts (rewards) are text-only too.

import { Frame, CHARS, INK, PALETTES, drawBeam, drawPlanet, drawRing, drawSatellite, drawStars, hash2, type Mode, type Theme } from '../../shared/sky.mjs'

export type { Mode, Theme } from '../../shared/sky.mjs'

interface Ping { x: number; y: number; r: number; max: number; strength: number; ink: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; ch: string }
interface Debris { x: number; y: number; vx: number; vy: number; rot: number; vr: number; kind: number }
interface Far { x: number; y: number; vx: number; vy: number }

const DEBRIS = [['/', '#'], ['=', '\\'], ['[', ']'], ['x'], ['<', '='], ['o', '-']]

export class Orbit {
  private ctx: CanvasRenderingContext2D
  private atlas = document.createElement('canvas')
  private frame = new Frame(1, 1)
  private dpr = 1
  private cell = 12
  private cols = 0
  private rows = 0
  private slot = 0
  private pad = 0
  private t = 0
  private last = 0
  private raf = 0
  private theme: Theme = 'dark'
  private mode: Mode = 'idle'
  private focus = { x: 0, y: 0, w: 0, h: 0 }
  private pointer = { x: -999, y: -999, active: false }
  private pings: Ping[] = []
  private sparks: Spark[] = []
  private debris: Debris[] = []
  private far: Far[] = []
  private sat = { x: 0, y: 0, vx: 0, vy: 0, angle: -0.25, av: 0, dish: Math.PI * 0.6, glitch: 0 }
  private beamUntil = 0
  private reduced: boolean
  readonly seed = 0x51a7

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (e) => (this.reduced = e.matches))
    addEventListener('resize', () => this.resize())
    addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX / this.cell
      this.pointer.y = e.clientY / this.cell
      this.pointer.active = e.pointerType === 'mouse'
    })
    document.addEventListener('pointerleave', () => (this.pointer.active = false))
    this.resize()
    this.populate()
    document.fonts?.ready.then(() => this.buildAtlas())
  }

  // ---------------------------------------------------------------- public API
  start() {
    cancelAnimationFrame(this.raf)
    this.last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.step(this.reduced ? dt * 0.3 : dt)
      this.render()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  setTheme(theme: Theme) {
    this.theme = theme
    this.buildAtlas()
  }

  setMode(mode: Mode) {
    if (mode === 'thinking' && this.mode !== 'thinking') this.beamUntil = this.t + 1.2
    this.mode = mode
  }

  /** Where the composer is (CSS px rect): signal listens towards it. */
  setFocus(r: DOMRect) {
    this.focus = { x: (r.left + r.width / 2) / this.cell, y: (r.top + r.height / 2) / this.cell, w: r.width / this.cell, h: r.height / this.cell }
  }

  /** A ping ring at a screen point (CSS px). */
  rippleAt(px: number, py: number, strength = 0.8, maxPx = 180) {
    this.ping(px / this.cell, py / this.cell, strength, maxPx / this.cell, INK.main)
  }

  /** A burst of + * 1 0 — when signal logs something. */
  burst(px: number, py: number, n = 26) {
    const x = px / this.cell
    const y = py / this.cell
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 4 + Math.random() * 10
      const max = 1.1 + Math.random() * 0.9
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.7 - 4, life: max, max, ch: '+*10.'[i % 5] })
    }
    this.ping(x, y, 1, 22, INK.hot)
    setTimeout(() => this.ping(x, y, 0.7, 30, INK.hot), 220)
    this.beamUntil = this.t + 1.6
  }

  // ---------------------------------------------------------------- setup
  private resize() {
    const w = innerWidth
    const h = innerHeight
    this.dpr = Math.min(2, devicePixelRatio || 1)
    this.cell = w < 520 ? 9 : w < 1100 ? 11 : 12
    document.documentElement.style.setProperty('--cell', `${this.cell}px`)
    this.cols = Math.ceil(w / this.cell)
    this.rows = Math.ceil(h / this.cell)
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.frame = new Frame(this.cols, this.rows)
    this.buildAtlas()
    if (this.sat.x === 0) this.home()
  }

  /** Where signal likes to hang: upper left on wide screens, top centre on phones. */
  private anchor() {
    const narrow = this.cols < 70
    return { x: this.cols * (narrow ? 0.5 : 0.24), y: this.rows * (narrow ? 0.17 : 0.3) }
  }

  private home() {
    const a = this.anchor()
    this.sat.x = a.x
    this.sat.y = a.y
  }

  private populate() {
    this.debris = []
    for (let i = 0; i < 7; i++) {
      this.debris.push({ x: Math.random() * this.cols, y: Math.random() * this.rows * 0.75, vx: -(0.4 + Math.random() * 1.4), vy: (Math.random() - 0.5) * 0.3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 2, kind: i % DEBRIS.length })
    }
    this.far = []
    for (let i = 0; i < 2; i++) this.far.push(this.newFar())
    this.t = Math.random() * 100
  }

  private newFar(): Far {
    const ltr = Math.random() < 0.5
    return { x: ltr ? -5 : this.cols + 5, y: 3 + Math.random() * this.rows * 0.5, vx: (ltr ? 1 : -1) * (3 + Math.random() * 3), vy: (Math.random() - 0.5) * 1.2 }
  }

  private buildAtlas() {
    const c = Math.max(4, Math.round(this.cell * this.dpr))
    const P = PALETTES[this.theme]
    this.pad = P.glow ? Math.round(c * 0.3) : 0
    this.slot = c + this.pad * 2
    this.atlas.width = this.slot * CHARS.length
    this.atlas.height = this.slot * P.inks.length
    const a = this.atlas.getContext('2d')!
    a.clearRect(0, 0, this.atlas.width, this.atlas.height)
    a.textAlign = 'center'
    a.textBaseline = 'middle'
    a.font = `500 ${Math.round(c * 0.7)}px "Martian Mono", "Geist Mono", ui-monospace, Menlo, monospace`
    P.inks.forEach((ink, row) => {
      a.fillStyle = ink
      a.shadowColor = ink
      a.shadowBlur = P.glow ? c * P.glow : 0
      for (let i = 1; i < CHARS.length; i++) a.fillText(CHARS[i], i * this.slot + this.slot / 2, row * this.slot + this.slot / 2 + c * 0.04)
    })
  }

  // ---------------------------------------------------------------- simulation
  private ping(x: number, y: number, strength: number, max = 16, ink: number = INK.main) {
    if (this.reduced) return
    if (this.pings.length > 14) this.pings.shift()
    this.pings.push({ x, y, r: 1, max, strength, ink })
  }

  private target() {
    // signal turns its dish: to the composer while you type, to the earth while it thinks, to your cursor otherwise
    const s = this.sat
    const planet = this.planet()
    if (this.mode === 'listening' && this.focus.w) return Math.atan2(this.focus.y - s.y, this.focus.x - s.x)
    if (this.mode === 'thinking') return Math.atan2(planet.cy - s.y, planet.cx - s.x)
    if (this.pointer.active) return Math.atan2(this.pointer.y - s.y, this.pointer.x - s.x)
    return Math.atan2(planet.cy - s.y, planet.cx - s.x) + Math.sin(this.t * 0.2) * 0.6
  }

  private step(dt: number) {
    this.t += dt
    const s = this.sat
    // drift around the anchor on a slow figure eight; tumble a little
    const a = this.anchor()
    const gx = a.x + Math.sin(this.t * 0.11) * this.cols * 0.04
    const gy = a.y + Math.sin(this.t * 0.22) * this.rows * 0.03
    s.vx += (gx - s.x) * 0.25 * dt - s.vx * 0.6 * dt
    s.vy += (gy - s.y) * 0.25 * dt - s.vy * 0.6 * dt
    s.x += s.vx * dt
    s.y += s.vy * dt
    const tumble = Math.sin(this.t * 0.17) * 0.32 - 0.12 + (this.mode === 'thinking' ? Math.sin(this.t * 9) * 0.03 : 0)
    s.av += (tumble - s.angle) * 0.8 * dt - s.av * 1.2 * dt
    s.angle += s.av * dt
    const want = this.target()
    const d = Math.atan2(Math.sin(want - s.dish), Math.cos(want - s.dish))
    s.dish += d * Math.min(1, dt * (this.mode === 'idle' ? 1.2 : 3.5))
    s.glitch += ((this.mode === 'thinking' ? 1 : 0) - s.glitch) * Math.min(1, dt * 4)

    // while thinking, the dish sends pings down
    if (this.mode === 'thinking' && hash2(Math.floor(this.t * 3), 7) % 3 === 0 && this.pings.length < 6 && Math.random() < dt * 3) {
      this.ping(s.x + Math.cos(s.dish) * 4, s.y + Math.sin(s.dish) * 4, 0.6, 10, INK.main)
    }

    for (const p of this.pings) p.r += dt * (9 + p.max * 0.25)
    this.pings = this.pings.filter((p) => p.r < p.max)
    for (const p of this.sparks) {
      p.life -= dt
      p.vy += 5 * dt
      p.vx *= 1 - dt * 1.5
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
    this.sparks = this.sparks.filter((p) => p.life > 0)
    for (const b of this.debris) {
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.rot += b.vr * dt
      if (b.x < -4) {
        b.x = this.cols + 4
        b.y = Math.random() * this.rows * 0.75
      }
    }
    this.far = this.far.map((f) => {
      f.x += f.vx * dt
      f.y += f.vy * dt
      return f.x < -8 || f.x > this.cols + 8 ? this.newFar() : f
    })
  }

  private planet() {
    const narrow = this.cols < 70
    const r = Math.max(this.rows * (narrow ? 0.42 : 0.62), this.cols * (narrow ? 0.62 : 0.3))
    return { cx: this.cols * (narrow ? 0.5 : 0.66), cy: this.rows + r * (narrow ? 0.45 : 0.38), r, spin: this.t * 0.035, light: [-0.55, -0.62, 0.56] as [number, number, number] }
  }

  // ---------------------------------------------------------------- rendering
  private render() {
    const f = this.frame
    f.clear()
    const t = this.t
    drawStars(f, t)
    // far satellites: a dot with a fading trail
    for (const s of this.far) {
      for (let i = 0; i < 7; i++) f.set(s.x - Math.sign(s.vx) * i * 0.9, s.y - (s.vy / Math.abs(s.vx)) * i * 0.9, i === 0 ? '+' : '.', INK.faint, 0.6 * (1 - i / 7))
    }
    drawPlanet(f, this.planet(), t)
    for (const b of this.debris) {
      const shape = DEBRIS[b.kind]
      const ang = b.rot
      shape.forEach((ch, i) => f.set(b.x + Math.cos(ang) * i, b.y + Math.sin(ang) * i * 0.6, ch, INK.dim, 0.6))
    }
    const s = this.sat
    const scale = this.cols < 70 ? 0.8 : this.cols < 110 ? 1.15 : 1.45
    // a transmission down to earth after a reward or while thinking
    if (t < this.beamUntil || this.mode === 'thinking') {
      const p = this.planet()
      const tx = s.x + (p.cx - s.x) * 0.55
      const ty = p.cy - p.r + 2
      drawBeam(f, s.x + Math.cos(s.dish) * 5 * scale, s.y + Math.sin(s.dish) * 5 * scale, tx, ty, t * 8, INK.hot, 0.8)
    }
    drawSatellite(f, { x: s.x, y: s.y, angle: s.angle, scale, dish: s.dish, t, seed: this.seed, glitch: s.glitch * 2.5 })
    for (const p of this.pings) {
      const life = 1 - p.r / p.max
      drawRing(f, p.x, p.y, p.r, p.ink, p.strength * Math.pow(life, 1.3) * 0.8)
    }
    for (const p of this.sparks) f.set(p.x, p.y, p.ch, INK.hot, Math.pow(p.life / p.max, 0.8))

    // cells → screen
    const { ctx, cols, rows } = this
    const cpx = this.cell * this.dpr
    const pad = this.pad
    const slot = this.slot
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    // tinted squares first, so characters sit on top of them
    const inks = PALETTES[this.theme].inks
    const gap = Math.max(1, Math.round(this.dpr))
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const b = f.bg[y * cols + x]
        if (b <= 0.01) continue
        ctx.globalAlpha = b
        ctx.fillStyle = inks[f.ink[y * cols + x] === INK.hot ? INK.main : f.ink[y * cols + x]]
        ctx.fillRect(x * cpx, y * cpx, cpx - gap, cpx - gap)
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const k = y * cols + x
        const a = f.a[k]
        if (a <= 0.01) continue
        ctx.globalAlpha = a
        ctx.drawImage(this.atlas, f.ch[k] * slot, f.ink[k] * slot, slot, slot, x * cpx - pad, y * cpx - pad, slot, slot)
      }
    }
    ctx.globalAlpha = 1
  }
}
