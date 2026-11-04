// The signal NFT: on-demand compressed NFT mints + the public image / metadata they point at.
//
//   GET  /nft/<id>.json          public  Metaplex metadata (the on-chain uri)        CDN-cached
//   GET  /nft/<id>.png           public  the card image, drawn from the database     CDN-cached
//   GET  /nft/collection.json    public  the collection's metadata (+ /nft/collection.png)
//   GET  /api/nft/health         public  which NFT env is missing, network, minting wallet balance
//   GET  /api/nft/preview.png    signed in, allowed   your card before you mint
//   GET  /api/nft/status         signed in            your mint (settles a sent transaction)
//   POST /api/nft/mint           signed in, allowed   mint now: { wallet? }
//
// The browser never says what goes on the NFT or how much: the server reads it from the database.
import { admin, json, missingEnv, sameOrigin, session } from '../lib/server.mjs'
import { collectionMetadata, nftMetadata, nftPng, renderCheck } from '../lib/nft.mjs'
import { buildMint, check, explorer, isPreflightError, isSolanaAddress, nftMissingEnv, nftNetwork, send, settle, treasury } from '../lib/solana.mjs'
import { nftMintedMessages } from '../../shared/brain.mjs'

const MIN_SOL = 0.002 // keep at least this much in the minting wallet

/** The metadata uri is written on chain forever, so it must use the real domain (SITE_URL). */
const site = () => (process.env.SITE_URL ?? '').replace(/\/$/, '')
const missing = () => [...missingEnv(), ...nftMissingEnv(), ...(process.env.SITE_URL ? [] : ['SITE_URL'])]

const PUBLIC_CACHE = {
  'Access-Control-Allow-Origin': '*', // wallets and marketplaces fetch these from their own pages
  'Cache-Control': 'public, max-age=60',
  'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=300, stale-while-revalidate=86400',
}
const png = (buf, headers) => new Response(buf, { status: 200, headers: { 'Content-Type': 'image/png', ...headers } })

// Only approved operators get a pass (being on the mint list IS the approval), so every NFT carries the
// APPROVED stamp, dated the day it was minted.
const dataFor = (row) => ({
  handle: row.handle,
  allocation: Number(row.allocation),
  status: 'approved',
  no: row.no ? Number(row.no) : null,
  rank: row.rank ? Number(row.rank) : null,
  divers: row.divers ? Number(row.divers) : null,
  date: row.createdAt ?? null,
})

const view = (m) => m && {
  id: m.id, status: m.status, assetId: m.assetId ?? null, signature: m.signature ?? null, owner: m.owner, network: m.network,
  links: {
    tx: m.signature ? explorer('tx', m.signature, m.network) : null,
    asset: m.assetId ? (m.network === 'devnet' ? explorer('token', m.assetId, m.network) : `https://www.tensor.trade/item/${m.assetId}`) : null,
    image: `${site()}/nft/${m.id}.png`,
  },
}

export default async (req) => {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/$/, '')
  try {
    // ---------------------------------------------------------- public media
    if (path.startsWith('/nft/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'bad_request' }, 405)
      if (path === '/nft/collection.json') return json(collectionMetadata(site() || url.origin), 200, { ...PUBLIC_CACHE, 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=86400' })
      if (path === '/nft/collection.png') return png(await nftPng({ collection: true, handle: 'signal', allocation: 0, status: 'approved' }), { ...PUBLIC_CACHE, 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=86400' })
      const m = path.match(/^\/nft\/([a-f0-9]{12})\.(json|png)$/)
      if (!m) return json({ error: 'not_found' }, 404, { 'Access-Control-Allow-Origin': '*' })
      if (missingEnv().length) return json({ error: 'not_configured' }, 503)
      const { data, error } = await admin().rpc('api_nft_public', { p_id: m[1] })
      if (error) throw error
      if (!data) return json({ error: 'not_found' }, 404, { 'Access-Control-Allow-Origin': '*', 'Netlify-CDN-Cache-Control': 'public, s-maxage=30' })
      const d = dataFor(data)
      if (m[2] === 'json') return json(nftMetadata(d, site() || url.origin, m[1]), 200, PUBLIC_CACHE)
      return png(await nftPng(d), PUBLIC_CACHE)
    }

    if (path === '/api/nft/health') {
      const render = await renderCheck()
      const info = { ok: missing().length === 0 && render.ok, missing: missing(), render, network: nftNetwork(), tree: process.env.NFT_TREE ?? null, collection: process.env.NFT_COLLECTION ?? null }
      if (!nftMissingEnv().length) {
        try {
          info.wallet = await treasury()
        } catch (e) {
          info.wallet = { error: String(e?.message ?? e).slice(0, 160) }
        }
      }
      return json(info)
    }

    // ---------------------------------------------------------- signed in
    if (missingEnv().length) return json({ error: 'not_configured', missing: missingEnv() }, 503)
    const s = session(req)
    if (!s) return json({ error: 'unauthorized' }, 401)
    const db = admin()

    if (path === '/api/nft/preview.png' && req.method === 'GET') {
      const { data, error } = await db.rpc('api_nft_preview', { p_user: s.uid })
      if (error) throw error
      if (!data?.eligible) return json({ error: 'closed' }, 403)
      return png(await nftPng(dataFor(data)), { 'Cache-Control': 'private, max-age=60' })
    }

    if (path === '/api/nft/status' && req.method === 'GET') {
      const st = await state(db, s.uid)
      let mint = st?.mint ?? null
      if (mint?.status === 'sent' && !nftMissingEnv().length) mint = await resolveSent(db, s.uid, mint)
      else if (mint?.status === 'minted' && !mint.assetId && !nftMissingEnv().length) mint = await fillAsset(db, s.uid, mint)
      const messages = mint?.status === 'minted' ? await announce(db, s.uid, mint) : []
      return json({ eligible: !!st?.eligible, allocationStatus: 'approved', mint: view(mint), messages })
    }

    if (path === '/api/nft/mint' && req.method === 'POST') {
      if (!sameOrigin(req)) return json({ error: 'bad_origin' }, 403)
      if (missing().length) return json({ ok: false, error: 'not_configured' }, 503)
      let body = {}
      try {
        body = JSON.parse((await req.text()).slice(0, 2048) || '{}')
      } catch {
        return json({ ok: false, error: 'bad_json' }, 400)
      }
      const st = await state(db, s.uid)
      if (!st) return json({ ok: false, error: 'unauthorized' }, 401)
      if (!st.eligible && st.mint?.status !== 'minted') return json({ ok: false, error: 'closed' }, 403)
      // Trials first; checked before anything is saved (the wallet would otherwise be locked in already).
      if (st.ready === false && !st.mint) return json({ ok: false, error: 'need_tasks' }, 409)

      // Where it goes: the saved Solana wallet; else the one pasted now (saved too, if none was saved).
      let owner = isSolanaAddress(st.wallet) ? st.wallet : null
      if (!owner) {
        const w = String(body.wallet ?? '').trim()
        if (!isSolanaAddress(w)) return json({ ok: false, error: 'need_wallet' }, 400)
        if (!st.wallet) {
          const { data: saved, error } = await db.rpc('api_set_wallet', { p_user: s.uid, p_wallet: w })
          if (error) throw error
          if (!saved?.ok && saved?.error === 'wallet_taken') return json({ ok: false, error: 'wallet_taken' }, 409)
        }
        owner = w
      }
      const r = await mint(db, s.uid, owner, st.handle)
      return json(r, r.ok ? 200 : r.status ?? 409)
    }

    return json({ error: 'not_found' }, 404)
  } catch (e) {
    console.error(e)
    return json({ error: 'server_error' }, 500)
  }
}

/**
 * signal's message once the NFT has landed: the receipt (with the transaction link; its "Get +1,000"
 * button opens the quote task). Stored in the chat once; returned only when written now, so the page
 * shows it live exactly once (after a reload it comes back with the history).
 */
async function announce(db, uid, m) {
  try {
    const messages = nftMintedMessages({ ...m, network: m.network ?? nftNetwork() })
    const { data: wrote, error } = await db.rpc('api_nft_announce', { p_user: uid, p_messages: messages })
    if (error) throw error
    return wrote ? messages : []
  } catch (e) {
    console.error('nft: announce failed (run migration 0011?)', e?.message ?? e)
    return []
  }
}

async function state(db, uid) {
  const { data, error } = await db.rpc('api_nft_state', { p_user: uid })
  if (error) throw error
  return data
}

/** A transaction is out: has it landed, failed, or is it still on its way? */
async function resolveSent(db, uid, m) {
  const r = await check(m.signature, m.height)
  if (r.state === 'confirmed') {
    await db.rpc('api_nft_done', { p_user: uid, p_signature: m.signature, p_asset: r.assetId })
    return { ...m, status: 'minted', assetId: r.assetId }
  }
  if (r.state === 'failed') {
    await db.rpc('api_nft_failed', { p_user: uid, p_signature: m.signature, p_error: r.error })
    return { ...m, status: 'failed' }
  }
  return m
}

async function fillAsset(db, uid, m) {
  const r = await check(m.signature, null).catch(() => null)
  if (r?.assetId) {
    await db.rpc('api_nft_done', { p_user: uid, p_signature: m.signature, p_asset: r.assetId })
    return { ...m, assetId: r.assetId }
  }
  return m
}

/** Claim → build + sign → store the signature → send → wait. Never two mints for one person. */
async function mint(db, uid, owner, handle) {
  const network = nftNetwork()
  for (let round = 0; round < 2; round++) {
    const { data: c, error } = await db.rpc('api_nft_claim', { p_user: uid, p_owner: owner, p_network: network, p_tree: process.env.NFT_TREE })
    if (error) throw error
    if (!c.ok) return { ok: false, error: c.error, status: c.error === 'closed' ? 403 : 409 }
    if (c.state === 'minted') {
      const m = { ...c, status: 'minted' }
      return { ok: true, mint: view(m), messages: await announce(db, uid, m) }
    }
    if (c.state === 'sent') {
      const m = await resolveSent(db, uid, { ...c, status: 'sent' })
      if (m.status === 'failed') continue // it can never land: mint again
      return { ok: true, mint: view(m), messages: m.status === 'minted' ? await announce(db, uid, m) : [] }
    }

    // state 'go': this request owns the mint for the next 90 s.
    const fail = async (sig, err) => db.rpc('api_nft_failed', { p_user: uid, p_signature: sig, p_error: String(err?.message ?? err).slice(0, 300) })
    let built
    try {
      const t = await treasury()
      if (t.sol < MIN_SOL) {
        console.error(`nft: minting wallet ${t.address} is low (${t.sol} SOL)`)
        await fail(null, 'treasury_low')
        return { ok: false, error: 'treasury_low', status: 503 }
      }
      built = await buildMint({ owner: c.owner, handle, uri: `${site()}/nft/${c.id}.json` })
    } catch (e) {
      console.error('nft: build failed', e)
      await fail(null, e)
      return { ok: false, error: 'chain_unavailable', status: 503 }
    }
    const { data: stored, error: sentErr } = await db.rpc('api_nft_sent', { p_user: uid, p_id: c.id, p_signature: built.signature, p_height: built.lastValidBlockHeight })
    if (sentErr) throw sentErr
    if (!stored) return { ok: false, error: 'busy', status: 409 } // the lock ran out and someone else took over

    try {
      await send(built.tx)
    } catch (e) {
      if (isPreflightError(e)) {
        console.error('nft: rejected before sending', e?.message ?? e)
        await fail(built.signature, e)
        return { ok: false, error: 'chain_rejected', status: 502 }
      }
      // Unknown whether it went out: the signature is stored, so the status check settles it either way.
      console.error('nft: send error (status unknown)', e?.message ?? e)
    }
    const r = await settle(built.signature, built.lastValidBlockHeight, Number(process.env.NFT_CONFIRM_MS) || 20_000)
    const m = { id: c.id, owner: c.owner, network, signature: built.signature, status: 'sent' }
    if (r.state === 'confirmed') {
      await db.rpc('api_nft_done', { p_user: uid, p_signature: built.signature, p_asset: r.assetId })
      const done = { ...m, status: 'minted', assetId: r.assetId }
      return { ok: true, mint: view(done), messages: await announce(db, uid, done) }
    }
    if (r.state === 'failed') {
      await fail(built.signature, r.error)
      return { ok: false, error: 'chain_failed', status: 502 }
    }
    return { ok: true, mint: view(m) } // still landing: the page asks /api/nft/status
  }
  return { ok: false, error: 'chain_failed', status: 502 }
}

export const config = {
  path: ['/nft/*', '/api/nft/*'],
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
