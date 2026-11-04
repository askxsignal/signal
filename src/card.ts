// The operator pass: a 1200×675 image (drawn at 2×) of how signal sees you from orbit — your own
// satellite, seeded by your handle (cracks, tumble, where the dish points), over the earth, next to your
// callsign, your pending $SIG, signal's verdict and your rank. Drawn in the browser so it can be pasted into a post.

import { BRAND } from '../shared/brand.mjs'
import { Frame, CHARS, INK, PALETTES, drawPlanet, drawRing, drawSatellite, drawStars, fnv, rng, type Theme } from '../shared/sky.mjs'

export interface CardData {
  handle: string
  allocation: number
  trials: { done: number; total: number }
  rank: number | null
  operators: number | null
  no: number | null
  joinedAt: string | null
  theme: Theme
}

export const CARD_W = 1200
export const CARD_H = 675
const SCALE = 2
const CELL = 14

const UI = {
  dark: { bg: '#06080c', ink: '#e7f5eb', ink2: '#9fb7a8', ink3: '#5e7568', line: 'rgba(159,227,184,0.18)', hot: '#effff3', panel: 'rgba(6,8,12,0.78)', stamp: '#9fe3b8' },
  light: { bg: '#ebe8df', ink: '#14261c', ink2: '#3d4f45', ink3: '#7c8a82', line: 'rgba(20,38,28,0.16)', hot: '#0b7a43', panel: 'rgba(235,232,223,0.86)', stamp: '#0b7a43' },
}

/** signal's opinion of you, by SIG in the log. */
export function verdict(n: number) {
  if (n >= 6000) return 'mission control'
  if (n >= 4000) return 'deep space relay'
  if (n >= 2500) return 'clear signal'
  if (n >= 1500) return 'faint signal'
  return 'static'
}

/** A callsign that is always the same for the same handle: K7-QX4R. */
export function callsign(handle: string) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const r = rng(fnv(`call:${handle.toLowerCase()}`))
  const p = () => A[Math.floor(r() * A.length)]
  return `${p()}${Math.floor(r() * 9) + 1}-${p()}${p()}${p()}${p()}`
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

async function fontsReady() {
  const want = ['600 72px "Space Grotesk"', '400 40px "Major Mono Display"', '400 92px "Martian Mono"', '500 26px "Martian Mono"']
  await Promise.race([Promise.all(want.map((f) => document.fonts.load(f).catch(() => null))), new Promise((r) => setTimeout(r, 2500))])
}

/** Draw the pass. Returns a canvas of CARD_W × CARD_H at 2× pixels. */
export async function renderCard(d: CardData): Promise<HTMLCanvasElement> {
  await fontsReady()
  const canvas = document.createElement('canvas')
  canvas.width = CARD_W * SCALE
  canvas.height = CARD_H * SCALE
  drawCard(canvas, d)
  return canvas
}

/** Draw the pass onto any 16:9 canvas. `w`/`h` let the OG render reuse it at 1200×630. */
export function drawCard(canvas: HTMLCanvasElement, d: CardData, w = CARD_W, h = CARD_H) {
  const c = UI[d.theme]
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0)
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, w, h)
  drawSky(ctx, d, w, h)
  drawText(ctx, d, c, w, h)
}

// ---------------------------------------------------------------- the sky (left, bleeding under the panel)
function drawSky(ctx: CanvasRenderingContext2D, d: CardData, w: number, h: number) {
  const cols = Math.ceil(w / CELL)
  const rows = Math.ceil(h / CELL)
  const seed = fnv(d.handle.toLowerCase())
  const r = rng(seed)
  const f = new Frame(cols, rows)
  const t = 7 + r() * 40
  drawStars(f, t, 0, 0.02)
  drawPlanet(f, { cx: cols * 0.18, cy: rows + rows * 0.42, r: rows * 0.72, spin: r() * 6, light: [-0.3, -0.75, 0.6] }, t)
  const sx = cols * 0.27
  const sy = rows * 0.42
  const angle = -0.35 + r() * 0.5
  const dish = Math.PI * (0.35 + r() * 0.3)
  // the transmission rings, under the satellite
  drawRing(f, sx, sy, 22, INK.faint, 0.22)
  drawSatellite(f, { x: sx, y: sy, angle, scale: 1.1, dish, t, seed })
  // a few logged bits drifting up from the dish
  for (let i = 0; i < 16; i++) {
    const u = i / 15
    const x = sx + Math.cos(dish) * (6 + u * 10) + Math.sin(i * 1.9) * 1.6
    const y = sy + Math.sin(dish) * (6 + u * 10) - u * 4
    if (!f.covered(Math.round(x), Math.round(y))) f.set(x, y, i % 4 === 0 ? '1' : '0+.'[i % 3], INK.hot, 0.9 - u * 0.6)
  }

  const P = PALETTES[d.theme]
  ctx.save()
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const b = f.bg[y * cols + x]
      if (b <= 0.01) continue
      ctx.globalAlpha = b
      ctx.fillStyle = P.inks[f.ink[y * cols + x] === INK.hot ? INK.main : f.ink[y * cols + x]]
      ctx.fillRect(x * CELL, y * CELL, CELL - 1.25, CELL - 1.25)
    }
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `500 ${Math.round(CELL * 0.72)}px "Martian Mono", ui-monospace, monospace`
  if (P.glow) ctx.shadowBlur = 6
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const k = y * cols + x
      if (f.a[k] <= 0.01) continue
      const ink = P.inks[f.ink[k]]
      ctx.globalAlpha = f.a[k]
      ctx.fillStyle = ink
      if (P.glow) ctx.shadowColor = ink
      ctx.fillText(CHARS[f.ch[k]], x * CELL + CELL / 2, y * CELL + CELL / 2 + 0.5)
    }
  }
  ctx.restore()

  // serial, top left
  ctx.font = '500 12px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = UI[d.theme].ink3
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  spaced(ctx, `SAT ${seed.toString(16).slice(0, 4).toUpperCase()} · LEO`, 36, 52, 2)
}

// ---------------------------------------------------------------- the words (right)
function drawText(ctx: CanvasRenderingContext2D, d: CardData, c: (typeof UI)['dark'], w: number, h: number) {
  const panel = { x: w * 0.5, y: 28, w: w * 0.5 - 28, h: h - 56 }
  // the panel: a plate with corner ticks
  ctx.fillStyle = c.panel
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h)
  ctx.strokeStyle = c.line
  ctx.lineWidth = 1
  ctx.strokeRect(panel.x + 0.5, panel.y + 0.5, panel.w - 1, panel.h - 1)
  ctx.strokeStyle = c.ink2
  ctx.lineWidth = 2
  const tick = 14
  for (const [x, y, sx, sy] of [[panel.x, panel.y, 1, 1], [panel.x + panel.w, panel.y, -1, 1], [panel.x, panel.y + panel.h, 1, -1], [panel.x + panel.w, panel.y + panel.h, -1, -1]] as const) {
    ctx.beginPath()
    ctx.moveTo(x, y + sy * tick)
    ctx.lineTo(x, y)
    ctx.lineTo(x + sx * tick, y)
    ctx.stroke()
  }

  const x0 = panel.x + 36
  const x1 = panel.x + panel.w - 36
  const width = x1 - x0
  const top = panel.y
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  // header: wordmark · operator number
  ctx.font = '400 24px "Major Mono Display", "Martian Mono", monospace'
  ctx.fillStyle = c.ink
  ctx.fillText(BRAND.name, x0, top + 56)
  const wm = ctx.measureText(BRAND.name).width
  ctx.font = '400 14px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink3
  ctx.fillText(BRAND.unit, x0 + wm + 12, top + 55)
  ctx.font = '500 12px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink3
  ctx.textAlign = 'right'
  spaced(ctx, `OPERATOR NO. ${d.no ? String(d.no).padStart(4, '0') : '----'}`, x1, top + 54, 2, true)
  ctx.textAlign = 'left'

  // callsign + handle, as large as fits
  ctx.font = '500 13px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink3
  spaced(ctx, `CALLSIGN ${callsign(d.handle)}`, x0, top + 112, 2)
  const handle = `@${d.handle}`
  let size = 64
  ctx.fillStyle = c.ink
  do {
    ctx.font = `600 ${size}px "Space Grotesk", system-ui, sans-serif`
    size -= 2
  } while (ctx.measureText(handle).width > width && size > 28)
  ctx.fillText(handle, x0 - 2, top + 176)

  // verdict
  ctx.font = '400 16px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink3
  const lead = `${BRAND.name}'s read · `
  ctx.fillText(lead, x0, top + 216)
  ctx.fillStyle = c.hot
  ctx.fillText(verdict(d.allocation), x0 + ctx.measureText(lead).width, top + 216)

  rule(ctx, x0, x1, top + 248, c.line)

  // the number
  ctx.font = '500 12px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink3
  spaced(ctx, 'PENDING ALLOCATION', x0, top + 286, 2.2)
  const num = fmt(d.allocation)
  ctx.font = '500 36px "Martian Mono", ui-monospace, monospace'
  const unitW = ctx.measureText(BRAND.unit).width
  let n = 84
  ctx.fillStyle = c.ink
  do {
    ctx.font = `400 ${n}px "Martian Mono", ui-monospace, monospace`
    n -= 4
  } while (ctx.measureText(num).width > width - unitW - 20 && n > 36)
  ctx.fillText(num, x0 - 3, top + 370)
  const nw = ctx.measureText(num).width
  ctx.font = '500 36px "Martian Mono", ui-monospace, monospace'
  ctx.fillText(BRAND.unit, x0 + nw + 14, top + 370)

  rule(ctx, x0, x1, top + 404, c.line)

  // three small facts
  const joined = d.joinedAt ? new Date(d.joinedAt).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }).toLowerCase() : '—'
  const facts: [string, string, string][] = [
    ['TRIALS', `${d.trials.done}/${d.trials.total}`, ''],
    ['RANK', d.rank ? `#${fmt(d.rank)}` : '—', d.rank && d.operators ? ` /${fmt(d.operators)}` : ''],
    ['FIRST CONTACT', joined, ''],
  ]
  const colX = [x0, x0 + width * 0.3, x0 + width * 0.64]
  facts.forEach(([label, value, tail], i) => {
    ctx.font = '500 11px "Martian Mono", ui-monospace, monospace'
    ctx.fillStyle = c.ink3
    spaced(ctx, label, colX[i], top + 444, 1.8)
    ctx.font = '500 24px "Martian Mono", ui-monospace, monospace'
    ctx.fillStyle = c.ink
    ctx.fillText(value, colX[i], top + 480)
    if (tail) {
      const vw = ctx.measureText(value).width
      ctx.font = '400 14px "Martian Mono", ui-monospace, monospace'
      ctx.fillStyle = c.ink3
      ctx.fillText(tail, colX[i] + vw + 2, top + 480)
    }
  })

  // the stamp
  ctx.save()
  ctx.translate(w * 0.36, h - 86) // over the sky, bottom left, clear of the facts
  ctx.rotate(-0.12)
  ctx.strokeStyle = c.stamp
  ctx.fillStyle = c.stamp
  ctx.globalAlpha = 0.85
  ctx.lineWidth = 2.5
  ctx.strokeRect(-92, -24, 184, 48)
  ctx.lineWidth = 1
  ctx.strokeRect(-86, -18, 172, 36)
  ctx.font = '600 15px "Martian Mono", ui-monospace, monospace'
  ctx.textAlign = 'left'
  spaced(ctx, 'SIGNAL ACQUIRED', 0, 6, 1.4, false, true)
  ctx.restore()

  // footer
  ctx.font = '500 14px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink2
  ctx.textAlign = 'left'
  ctx.fillText(new URL(BRAND.site).host, x0, top + panel.h - 34)
  ctx.font = '400 12px "Martian Mono", ui-monospace, monospace'
  ctx.fillStyle = c.ink3
  ctx.fillText('pending · never promised', x0, top + panel.h - 14)
}

function rule(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string) {
  ctx.fillStyle = color
  ctx.fillRect(x0, y, x1 - x0, 1)
}

/** Letter-spaced text (canvas letterSpacing is not everywhere yet). */
function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, track: number, alignRight = false, center = false) {
  const chars = [...text]
  const total = chars.reduce((w, ch) => w + ctx.measureText(ch).width + track, -track)
  const prev = ctx.textAlign
  ctx.textAlign = 'left'
  let cx = alignRight ? x - total : center ? x - total / 2 : x
  for (const ch of chars) {
    ctx.fillText(ch, cx, y)
    cx += ctx.measureText(ch).width + track
  }
  ctx.textAlign = prev
}

export function cardBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'))
}
