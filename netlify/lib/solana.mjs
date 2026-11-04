// Minting one compressed NFT (Metaplex Bubblegum v2) from the server. The server signs only the mint it
// builds itself here: one mintV2 instruction into OUR tree, for the wallet the database approved, with
// metadata pointing at our own domain. Nothing from the browser is ever signed.
//
// Env: NFT_RPC_URL (a DAS-capable RPC, e.g. Helius), NFT_SECRET_KEY (the minting wallet: base58 or a
// JSON byte array), NFT_TREE, optional NFT_COLLECTION (MPL Core collection with the BubblegumV2 plugin),
// NFT_NETWORK (mainnet | devnet, default mainnet), NFT_PRIORITY_MICROLAMPORTS (optional priority fee).

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createSignerFromKeypair, publicKey, signerIdentity, none, some } from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { mplBubblegum, mintV2, parseLeafFromMintV2Transaction } from '@metaplex-foundation/mpl-bubblegum'
import { setComputeUnitLimit, setComputeUnitPrice } from '@metaplex-foundation/mpl-toolbox'

const NFT_REQUIRED = ['NFT_RPC_URL', 'NFT_SECRET_KEY', 'NFT_TREE']
export const nftMissingEnv = () => NFT_REQUIRED.filter((k) => !process.env[k])
export const nftNetwork = () => (process.env.NFT_NETWORK === 'devnet' ? 'devnet' : 'mainnet')

const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** A real 32-byte Solana address (base58), not just the right alphabet. */
export function isSolanaAddress(s) {
  if (typeof s !== 'string' || !SOLANA.test(s)) return false
  try {
    return base58.serialize(s).length === 32
  } catch {
    return false
  }
}

/** The minting wallet's secret key: base58 (Phantom export) or a JSON array (solana-keygen file). */
export function parseSecretKey(raw) {
  const s = String(raw ?? '').trim()
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58.serialize(s)
  if (bytes.length !== 64) throw new Error('NFT_SECRET_KEY must be a 64-byte secret key')
  return bytes
}

let cached
export function chain() {
  if (cached) return cached
  const umi = createUmi(process.env.NFT_RPC_URL, { commitment: 'confirmed' }).use(mplBubblegum())
  const kp = umi.eddsa.createKeypairFromSecretKey(parseSecretKey(process.env.NFT_SECRET_KEY))
  umi.use(signerIdentity(createSignerFromKeypair(umi, kp)))
  cached = { umi, tree: publicKey(process.env.NFT_TREE), collection: process.env.NFT_COLLECTION ? publicKey(process.env.NFT_COLLECTION) : null }
  return cached
}

/** Metaplex name is at most 32 bytes (not characters). */
export function nftName(handle) {
  let name = `signal · @${handle}`
  while (Buffer.byteLength(name) > 32) name = name.slice(0, -1)
  return name
}

/**
 * Build + sign one mint. Nothing is sent yet: the caller stores `signature` first, then calls send().
 * @returns {{ tx, signature: string, lastValidBlockHeight: number, blockhash: string }}
 */
export async function buildMint({ owner, handle, uri }) {
  const { umi, tree, collection } = chain()
  let builder = mintV2(umi, {
    leafOwner: publicKey(owner),
    merkleTree: tree,
    ...(collection ? { coreCollection: collection } : {}),
    metadata: {
      name: nftName(handle),
      symbol: 'SIG',
      uri,
      sellerFeeBasisPoints: 0,
      collection: collection ? some(collection) : none(),
      creators: [],
    },
  })
  // Mainnet default: a small priority fee (20 000 µlamports × 250k CU ≈ 0.000005 SOL) so mints land when
  // the network is busy. NFT_PRIORITY_MICROLAMPORTS overrides it (0 = none). Devnet: none by default.
  const env = process.env.NFT_PRIORITY_MICROLAMPORTS
  const micro = env !== undefined && env !== '' ? Number(env) : nftNetwork() === 'mainnet' ? 20_000 : 0
  if (micro > 0) {
    builder = builder.prepend(setComputeUnitLimit(umi, { units: 250_000 })).prepend(setComputeUnitPrice(umi, { microLamports: micro }))
  }
  const bh = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' })
  const tx = await builder.setBlockhash(bh).buildAndSign(umi)
  return { tx, signature: base58.deserialize(tx.signatures[0])[0], lastValidBlockHeight: bh.lastValidBlockHeight, blockhash: bh.blockhash }
}

/** Send a signed mint. Preflight on: a transaction the cluster would reject never leaves the RPC. */
export async function send(tx) {
  const { umi } = chain()
  await umi.rpc.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 })
}

/**
 * Only a rejection the RPC itself reports as a failed simulation (or a bad signature) proves the
 * transaction was never broadcast, so only then is it safe to mint again right away. web3.js words EVERY
 * send error as "Simulation failed. Message: …" (even "Internal error"), so the RPC's own message is what
 * counts: "Transaction simulation failed: …". Anything else: the outcome is unknown and the stored
 * signature is checked on chain until its blockhash expires.
 */
export function isPreflightError(e) {
  const text = [e?.transactionMessage, e?.cause?.transactionMessage, e?.message, e?.cause?.message].filter(Boolean).join(' | ')
  return /Transaction simulation failed|Transaction signature verification failure/i.test(text)
}

/**
 * Where a sent mint stands: 'confirmed' (with assetId), 'failed' (landed with an error, or can never land
 * because its blockhash expired), or 'pending'.
 */
export async function check(signature, lastValidBlockHeight) {
  const { umi } = chain()
  const sig = base58.serialize(signature)
  const [st] = await umi.rpc.getSignatureStatuses([sig], { searchTransactionHistory: true })
  if (st) {
    if (st.error) return { state: 'failed', error: JSON.stringify(st.error).slice(0, 200) }
    if (st.commitment === 'confirmed' || st.commitment === 'finalized') {
      let assetId = null
      try {
        assetId = (await parseLeafFromMintV2Transaction(umi, sig)).id.toString()
      } catch (e) {
        console.error('nft: could not read the asset id yet', e?.message ?? e)
      }
      return { state: 'confirmed', assetId }
    }
    return { state: 'pending' }
  }
  if (lastValidBlockHeight) {
    const height = await umi.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }])
    if (Number(height) > Number(lastValidBlockHeight)) {
      // One more look: it may have landed in the last moment.
      const [again] = await umi.rpc.getSignatureStatuses([sig], { searchTransactionHistory: true })
      if (!again) return { state: 'failed', error: 'expired' }
      return check(signature, null)
    }
  }
  return { state: 'pending' }
}

/** Wait up to `ms` for a sent mint to settle. */
export async function settle(signature, lastValidBlockHeight, ms = 25_000) {
  const until = Date.now() + ms
  let last = { state: 'pending' }
  while (Date.now() < until) {
    last = await check(signature, lastValidBlockHeight)
    if (last.state !== 'pending') return last
    await new Promise((r) => setTimeout(r, 1500))
  }
  return last
}

/** SOL left in the minting wallet. */
export async function treasury() {
  const { umi } = chain()
  const bal = await umi.rpc.getBalance(umi.identity.publicKey)
  return { address: umi.identity.publicKey.toString(), sol: Number(bal.basisPoints) / 1e9 }
}

export const explorer = (kind, id, network = nftNetwork()) =>
  `https://solscan.io/${kind}/${id}${network === 'devnet' ? '?cluster=devnet' : ''}`
