// The signal NFT: a 1200×1200 square drawn on the server (SVG → PNG with resvg), so nobody can forge the
// numbers on it. Your ASCII satellite (cracks and markings seeded by your handle, same as the site's
// operator pass), your handle, your allocation and a rubber stamp with the reserve's decision: PENDING,
// APPROVED or REJECTED. The image and the metadata are served from our own domain and read the database on
// every (cached) request, so the stamp can change.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND } from '../../shared/brand.mjs'
import { Frame, GLYPHS, INK, PALETTES, drawPlanet, drawRing, drawSatellite, drawStars, fnv, rng } from '../../shared/sky.mjs'

export const NFT_SIZE = 1200
const C = { bg: '#06080c', ink: '#e7f5eb', ink2: '#9fb7a8', ink3: '#5e7568', line: 'rgba(159,227,184,0.18)', plate: 'rgba(6,8,12,0.82)', phos: '#9fe3b8', hot: '#effff3' }
export const STAMPS = {
  pending: { word: 'PENDING', color: '#ffb547' },
  approved: { word: 'APPROVED', color: '#7ee2a0' },
  rejected: { word: 'REJECTED', color: '#ff6159' },
}
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const host = () => new URL(BRAND.site).host

/** signal's read of you, by allocation (same as the site's operator pass). */
export function verdict(n) {
  if (n >= 6000) return 'mission control'
  if (n >= 4000) return 'deep space relay'
  if (n >= 2500) return 'clear signal'
  if (n >= 1500) return 'faint signal'
  return 'static'
}

export const permitId = (handle, no) =>
  `SIG-${no != null ? String(no).padStart(4, '0') : '----'}-${fnv(String(handle).toLowerCase()).toString(16).slice(0, 4).toUpperCase().padStart(4, '0')}`

/** The sky as SVG: tinted squares, then glyphs. */
function skySvg(f, cell, ox = 0, oy = 0) {
  const P = PALETTES.dark
  const rects = []
  const texts = []
  for (let y = 0; y < f.rows; y++) {
    for (let x = 0; x < f.cols; x++) {
      const k = y * f.cols + x
      const px = ox + x * cell
      const py = oy + y * cell
      if (f.bg[k] > 0.01) rects.push(`<rect x="${px}" y="${py}" width="${cell - 2}" height="${cell - 2}" fill="${P.inks[f.ink[k] === INK.hot ? INK.main : f.ink[k]]}" fill-opacity="${f.bg[k].toFixed(2)}"/>`)
      if (f.a[k] > 0.01) texts.push(`<text x="${px + (cell - 2) / 2}" y="${py + cell * 0.7}" fill="${P.inks[f.ink[k]]}" fill-opacity="${f.a[k].toFixed(2)}">${esc(GLYPHS[f.ch[k]])}</text>`)
    }
  }
  return `<g>${rects.join('')}</g><g font-family="Geist Mono" font-weight="500" font-size="${Math.round(cell * 0.66)}" text-anchor="middle">${texts.join('')}</g>`
}

/**
 * @param {{ handle: string, allocation: number, status: 'pending'|'approved'|'rejected', no?: number|null, rank?: number|null, divers?: number|null, date?: string|null, collection?: boolean }} d
 * @returns {string} SVG
 */
export function nftSvg(d) {
  const W = NFT_SIZE
  const handle = String(d.handle || 'anon').toLowerCase()
  const seed = fnv(handle)
  const r = rng(seed)
  const stamp = STAMPS[d.status] ?? STAMPS.pending
  const out = []
  const push = (s) => out.push(s)

  push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">`)
  push(`<rect width="${W}" height="${W}" fill="${C.bg}"/>`)

  // ---------------------------------------------------------------- the sky
  const cell = 20
  const f = new Frame(W / cell, W / cell)
  const t = 5 + r() * 40
  drawStars(f, t, 0, 0.02)
  drawPlanet(f, { cx: f.cols * (0.3 + r() * 0.4), cy: f.rows * 1.42, r: f.rows * 0.7, spin: r() * 6, light: [-0.35, -0.75, 0.55] }, t)
  const sx = f.cols / 2
  const sy = f.rows * 0.33
  drawRing(f, sx, sy, 24, INK.faint, 0.22)
  const dish = Math.PI * (0.3 + r() * 0.4)
  drawSatellite(f, { x: sx, y: sy, angle: -0.3 + r() * 0.5, scale: 1.3, dish, t, seed: d.collection ? 0x51a7 : seed })
  for (let i = 0; i < 14; i++) {
    const u = i / 13
    const x = sx + Math.cos(dish) * (9 + u * 12) + Math.sin(i * 1.9) * 1.8
    const y = sy + Math.sin(dish) * (9 + u * 12) - u * 5
    if (!f.covered(Math.round(x), Math.round(y))) f.set(x, y, i % 4 === 0 ? '$' : '0+1.'[i % 4], INK.hot, 0.95 - u * 0.6)
  }
  push(skySvg(f, cell))

  // ---------------------------------------------------------------- header
  push(`<text x="64" y="72" font-family="Manrope" font-weight="800" font-size="30" fill="${C.ink}">${esc(BRAND.name)}</text>`)
  push(`<text x="${64 + BRAND.name.length * 17 + 14}" y="72" font-family="Geist Mono" font-weight="400" font-size="20" fill="${C.ink3}">$${esc(BRAND.ticker)}</text>`)
  if (!d.collection) push(`<text x="${W - 64}" y="72" font-family="Geist Mono" font-weight="500" font-size="18" letter-spacing="3" fill="${C.ink3}" text-anchor="end">OPERATOR NO. ${d.no != null ? String(d.no).padStart(4, '0') : '----'}</text>`)

  // the plate under the words
  const plate = (y, h) => {
    push(`<rect x="40" y="${y}" width="${W - 80}" height="${h}" fill="${C.plate}" stroke="${C.line}"/>`)
    for (const [x, yy, ddx, ddy] of [[40, y, 1, 1], [W - 40, y, -1, 1], [40, y + h, 1, -1], [W - 40, y + h, -1, -1]]) {
      push(`<path d="M${x} ${yy + ddy * 18}V${yy}H${x + ddx * 18}" fill="none" stroke="${C.phos}" stroke-width="2"/>`)
    }
  }

  // ---------------------------------------------------------------- the collection cover (no person, no stamp)
  if (d.collection) {
    plate(800, 360)
    push(`<text x="${W / 2}" y="930" font-family="Manrope" font-weight="800" font-size="140" letter-spacing="-4" fill="${C.ink}" text-anchor="middle">${esc(BRAND.name)}</text>`)
    push(`<text x="${W / 2}" y="992" font-family="Geist Mono" font-weight="500" font-size="22" letter-spacing="6" fill="${C.ink3}" text-anchor="middle">THE $${esc(BRAND.ticker)} RESERVE · APPROVED OPERATORS</text>`)
    push(`<text x="${W / 2}" y="1060" font-family="Geist Mono" font-weight="400" font-size="22" fill="${C.ink2}" text-anchor="middle">minted on request, only for operators the reserve approved</text>`)
    push(`<text x="80" y="1130" font-family="Geist Mono" font-weight="500" font-size="20" fill="${C.ink2}">${esc(host())}</text>`)
    push(`<text x="${W - 80}" y="1130" font-family="Geist Mono" font-weight="400" font-size="18" letter-spacing="2" fill="${C.ink3}" text-anchor="end">@${esc(BRAND.xHandle)}</text>`)
    push(`</svg>`)
    return out.join('')
  }

  // ---------------------------------------------------------------- handle + allocation
  plate(720, 440)
  const tag = `@${handle}`
  const handleSize = Math.min(92, Math.floor(1020 / (tag.length * 0.62)))
  push(`<text x="${W / 2}" y="826" font-family="Manrope" font-weight="800" font-size="${handleSize}" letter-spacing="-2" fill="${C.ink}" text-anchor="middle">${esc(tag)}</text>`)
  const sub = `${verdict(d.allocation)}${d.rank ? ` · rank #${fmt(d.rank)}${d.divers ? ` of ${fmt(d.divers)}` : ''}` : ''}`
  push(`<text x="${W / 2}" y="870" font-family="Geist Mono" font-weight="400" font-size="20" fill="${C.ink2}" text-anchor="middle">${esc(sub)}</text>`)
  push(`<rect x="80" y="898" width="${W - 160}" height="1.5" fill="${C.line}"/>`)
  push(`<text x="${W / 2}" y="946" font-family="Geist Mono" font-weight="500" font-size="17" letter-spacing="5" fill="${C.ink3}" text-anchor="middle">${d.status === 'approved' ? 'ALLOCATION' : d.status === 'rejected' ? 'ALLOCATION · NOT GRANTED' : 'PENDING ALLOCATION'}</text>`)
  const num = fmt(d.allocation)
  const unit = `$${BRAND.ticker}`
  const numSize = num.length > 7 ? 100 : 118
  const numW = num.length * numSize * 0.6
  const unitW = unit.length * 52 * 0.6
  const gx = (W - (numW + 22 + unitW)) / 2
  const dim = d.status === 'rejected' ? ' fill-opacity="0.45"' : ''
  push(`<text x="${gx.toFixed(1)}" y="1060" font-family="Geist Mono" font-weight="500" font-size="${numSize}" fill="${C.ink}"${dim}>${num}</text>`)
  push(`<text x="${(gx + numW + 22).toFixed(1)}" y="1060" font-family="Geist Mono" font-weight="600" font-size="52" fill="${C.ink}"${dim}>${esc(unit)}</text>`)
  if (d.status === 'rejected') push(`<rect x="${(gx - 10).toFixed(1)}" y="1022" width="${(numW + unitW + 42).toFixed(1)}" height="5" fill="${STAMPS.rejected.color}" fill-opacity="0.8"/>`)

  // ---------------------------------------------------------------- footer
  push(`<text x="80" y="1130" font-family="Geist Mono" font-weight="500" font-size="20" fill="${C.ink2}">${esc(host())}</text>`)
  push(`<text x="${W - 80}" y="1130" font-family="Geist Mono" font-weight="400" font-size="18" letter-spacing="2" fill="${C.ink3}" text-anchor="end">${esc(permitId(handle, d.no))}</text>`)

  // ---------------------------------------------------------------- the stamp
  const sw = 430
  const sh = 168
  const date = d.date ? new Date(d.date) : new Date()
  const dd = `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`
  const rot = -11 + (r() - 0.5) * 4
  // worn ink: tiny holes punched by a mask
  let holes = ''
  const rs = rng(seed ^ 0xabcdef)
  for (let i = 0; i < 260; i++) holes += `<circle cx="${(rs() * sw).toFixed(1)}" cy="${(rs() * sh).toFixed(1)}" r="${(0.6 + rs() * 2.2).toFixed(1)}" fill="black"/>`
  push(`<defs><mask id="worn" maskUnits="userSpaceOnUse" x="-20" y="-20" width="${sw + 40}" height="${sh + 40}"><rect x="-20" y="-20" width="${sw + 40}" height="${sh + 40}" fill="white"/>${holes}</mask></defs>`)
  push(`<g transform="translate(${W - 64 - sw + 10} 520) rotate(${rot.toFixed(2)} ${sw / 2} ${sh / 2})" mask="url(#worn)" opacity="0.9">`)
  push(`<rect x="3" y="3" width="${sw - 6}" height="${sh - 6}" fill="none" stroke="${stamp.color}" stroke-width="7"/>`)
  push(`<rect x="16" y="16" width="${sw - 32}" height="${sh - 32}" fill="none" stroke="${stamp.color}" stroke-width="2.5"/>`)
  push(`<text x="${sw / 2}" y="${sh / 2 + 16}" font-family="Geist Mono" font-weight="600" font-size="${stamp.word.length > 7 ? 54 : 58}" letter-spacing="6" fill="${stamp.color}" text-anchor="middle">${stamp.word}</text>`)
  push(`<text x="${sw / 2}" y="${sh - 30}" font-family="Geist Mono" font-weight="500" font-size="15" letter-spacing="4" fill="${stamp.color}" text-anchor="middle">${esc(BRAND.ticker)} RESERVE · ${dd}</text>`)
  push(`<text x="${sw / 2}" y="44" font-family="Geist Mono" font-weight="500" font-size="15" letter-spacing="6" fill="${stamp.color}" text-anchor="middle">SIGNAL ACQUIRED</text>`)
  push(`</g>`)

  push(`</svg>`)
  return out.join('')
}

// ---------------------------------------------------------------- PNG
// resvg as WebAssembly: the same build runs wherever the site is deployed from (a Mac, Linux, CI).
// The native @resvg/resvg-js picks its binary at install time, so a deploy built on a Mac shipped a
// macOS binary to Netlify's Linux functions and every PNG failed.
// netlify.toml ships the fonts and the .wasm with the function (included_files); they are looked up
// from the working directory and from the bundled file's own folder, whichever exists.
function findFile(rel) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const roots = [process.cwd(), process.env.LAMBDA_TASK_ROOT, here, path.join(here, '..'), path.join(here, '../..'), path.join(here, '../../..')].filter(Boolean)
  for (const r of roots) {
    const f = path.join(r, rel)
    if (fs.existsSync(f)) return f
  }
  return null
}

let fontBuffers = null
function fonts() {
  if (fontBuffers) return fontBuffers
  const probe = findFile('netlify/fonts/GeistMono_500Medium.ttf')
  if (!probe) throw new Error('NFT fonts not found (netlify/fonts must be in included_files)')
  const dir = path.dirname(probe)
  fontBuffers = fs.readdirSync(dir).filter((f) => f.endsWith('.ttf')).map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))))
  return fontBuffers
}

let wasm = null
async function resvg() {
  const mod = await import('@resvg/resvg-wasm')
  wasm ??= (async () => {
    const file = findFile('node_modules/@resvg/resvg-wasm/index_bg.wasm')
    if (!file) throw new Error('resvg wasm not found (node_modules/@resvg/resvg-wasm/index_bg.wasm must be in included_files)')
    await mod.initWasm(fs.readFileSync(file))
  })().catch((e) => {
    wasm = null
    throw e
  })
  await wasm
  return mod.Resvg
}

/** Can this function draw PNGs? (for /api/nft/health) */
export async function renderCheck() {
  try {
    await resvg()
    return { ok: true, fonts: fonts().length }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
  }
}

export async function nftPng(d) {
  const Resvg = await resvg()
  const r = new Resvg(nftSvg(d), { font: { fontBuffers: fonts(), loadSystemFonts: false, defaultFontFamily: 'Geist Mono' }, fitTo: { mode: 'width', value: NFT_SIZE } })
  const png = r.render().asPng()
  r.free?.()
  return png
}

/** Changes whenever something drawn on the card changes. */
export const imageVersion = (d) => fnv(`${d.status}|${Math.round(Number(d.allocation) || 0)}|${d.no ?? ''}|${d.rank ?? ''}|${d.divers ?? ''}|${d.date ?? ''}`).toString(36)

/** The collection's own metadata (MPL Core collection uri). */
export function collectionMetadata(site) {
  return {
    name: BRAND.name,
    symbol: BRAND.ticker,
    description: `Operator passes from the $${BRAND.ticker} reserve, minted on request and only for operators the reserve approved. The pass shows the operator's current allocation. Not financial advice. ${site.replace(/^https?:\/\//, '')}`,
    image: `${site}/nft/collection.png`,
    external_url: site,
    properties: { files: [{ uri: `${site}/nft/collection.png`, type: 'image/png' }], category: 'image' },
  }
}

/** Metaplex JSON metadata for one NFT. */
export function nftMetadata(d, site, id) {
  const stamp = STAMPS[d.status] ?? STAMPS.pending
  const handle = String(d.handle).toLowerCase()
  let name = `${BRAND.name} · @${handle}`
  while (Buffer.byteLength(name) > 32) name = name.slice(0, -1)
  // The image URL changes whenever the picture does, so caches (wallets, indexers, CDNs) fetch it again.
  const image = `${site}/nft/${id}.png?v=${imageVersion(d)}`
  return {
    name,
    symbol: BRAND.ticker,
    description: `@${handle}'s ${BRAND.name} operator pass, ${stamp.word.toLowerCase()} by the $${BRAND.ticker} reserve: ${fmt(d.allocation)} $${BRAND.ticker}. The picture follows the operator's current allocation. Not financial advice. ${site.replace(/^https?:\/\//, '')}`,
    image,
    external_url: site,
    attributes: [
      { trait_type: 'Status', value: stamp.word.toLowerCase() },
      { trait_type: 'Allocation', value: Math.round(Number(d.allocation) || 0) },
      { trait_type: 'Verdict', value: verdict(d.allocation) },
      ...(d.no ? [{ trait_type: 'Operator No.', value: d.no }] : []),
      { trait_type: 'Permit', value: permitId(handle, d.no) },
    ],
    properties: { files: [{ uri: image, type: 'image/png' }], category: 'image' },
  }
}
