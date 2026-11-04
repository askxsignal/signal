// Brand renders: the OG image (1200×630) and the X avatar (400×400) and header (1500×500), drawn with the
// same sky primitives as the site. Run with scripts/brand.html in a browser (see README → Brand kit);
// each canvas is exposed on window.__brand as a PNG data URL.

import { BRAND } from '../shared/brand.mjs'
import { Frame, CHARS, INK, PALETTES, drawPlanet, drawRing, drawSatellite, drawStars } from '../shared/sky.mjs'

const CELL = 14
const P = PALETTES.dark

function paint(ctx: CanvasRenderingContext2D, f: Frame, cell: number) {
  for (let y = 0; y < f.rows; y++)
    for (let x = 0; x < f.cols; x++) {
      const b = f.bg[y * f.cols + x]
      if (b <= 0.01) continue
      ctx.globalAlpha = b
      ctx.fillStyle = P.inks[f.ink[y * f.cols + x] === INK.hot ? INK.main : f.ink[y * f.cols + x]]
      ctx.fillRect(x * cell, y * cell, cell - 1.25, cell - 1.25)
    }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `500 ${Math.round(cell * 0.72)}px "Martian Mono", ui-monospace, monospace`
  ctx.shadowBlur = 6
  for (let y = 0; y < f.rows; y++)
    for (let x = 0; x < f.cols; x++) {
      const k = y * f.cols + x
      if (f.a[k] <= 0.01) continue
      ctx.globalAlpha = f.a[k]
      ctx.fillStyle = ctx.shadowColor = P.inks[f.ink[k]]
      ctx.fillText(CHARS[f.ch[k]], x * cell + cell / 2, y * cell + cell / 2 + 0.5)
    }
  ctx.globalAlpha = 1
  ctx.shadowBlur = 0
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w * 2
  c.height = h * 2
  const ctx = c.getContext('2d')!
  ctx.scale(2, 2)
  ctx.fillStyle = P.bg
  ctx.fillRect(0, 0, w, h)
  return { c, ctx }
}

function og() {
  const W = 1200, H = 630
  const { c, ctx } = canvas(W, H)
  const f = new Frame(Math.ceil(W / CELL), Math.ceil(H / CELL))
  drawStars(f, 12, 0, 0.02)
  drawPlanet(f, { cx: f.cols * 0.78, cy: f.rows * 1.55, r: f.rows * 0.85, spin: 1.2, light: [-0.5, -0.7, 0.5] }, 12)
  drawRing(f, f.cols * 0.24, f.rows * 0.5, 20, INK.faint, 0.25)
  drawSatellite(f, { x: f.cols * 0.24, y: f.rows * 0.5, angle: -0.22, scale: 1.05, dish: 0.9, t: 12, seed: 0x51a7 })
  paint(ctx, f, CELL)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#e7f5eb'
  ctx.shadowColor = 'rgba(159,227,184,0.35)'
  ctx.shadowBlur = 18
  ctx.font = '400 60px "Major Mono Display", "Martian Mono", monospace'
  ctx.fillText('is anyone', 560, 250)
  ctx.fillText('out there?', 560, 322)
  ctx.shadowBlur = 0
  ctx.font = '400 20px "Martian Mono", monospace'
  ctx.fillStyle = '#9fb7a8'
  ctx.fillText('a broken satellite guards', 562, 382)
  ctx.fillText(`the ${BRAND.unit} reserve. talk your way in.`, 562, 412)
  ctx.font = '500 16px "Martian Mono", monospace'
  ctx.fillStyle = '#9fe3b8'
  ctx.fillText(new URL(BRAND.site).host, 562, 470)
  return c
}

function avatar() {
  const S = 400
  const { c, ctx } = canvas(S, S)
  const cell = 12
  const f = new Frame(Math.ceil(S / cell), Math.ceil(S / cell))
  drawStars(f, 3, 0, 0.03)
  drawSatellite(f, { x: f.cols / 2, y: f.rows / 2, angle: -0.5, scale: 0.98, dish: -2.1, t: 2, seed: 0x51a7 })
  paint(ctx, f, cell)
  return c
}

function header() {
  const W = 1500, H = 500
  const { c, ctx } = canvas(W, H)
  const f = new Frame(Math.ceil(W / CELL), Math.ceil(H / CELL))
  drawStars(f, 30, 0, 0.022)
  drawPlanet(f, { cx: f.cols * 0.6, cy: f.rows * 2.9, r: f.rows * 2.2, spin: 2.4, light: [-0.4, -0.8, 0.45] }, 30)
  drawSatellite(f, { x: f.cols * 0.78, y: f.rows * 0.36, angle: 0.18, scale: 0.9, dish: 2.2, t: 30, seed: 0x51a7 })
  paint(ctx, f, CELL)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#e7f5eb'
  ctx.shadowColor = 'rgba(159,227,184,0.35)'
  ctx.shadowBlur = 14
  ctx.font = '400 54px "Major Mono Display", "Martian Mono", monospace'
  ctx.fillText('is anyone out there?', 90, 210)
  return c
}

async function main() {
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))])
  const out: Record<string, string> = {}
  for (const [name, fn] of Object.entries({ og, avatar, header })) {
    const c = fn()
    out[name] = c.toDataURL('image/png')
    document.body.append(c)
  }
  ;(window as unknown as { __brand: Record<string, string> }).__brand = out
}
main()
