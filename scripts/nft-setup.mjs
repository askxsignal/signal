#!/usr/bin/env node
// One-time setup for the signal NFT (run on your own computer, not on Netlify).
//
//   node scripts/nft-setup.mjs keygen                      new minting wallet → .nft/minter.json
//   node scripts/nft-setup.mjs balance                     its address and SOL balance
//   node scripts/nft-setup.mjs tree [--depth 16 --buffer 64 --canopy 8] [--yes] [--new]
//        small test tree (32 NFTs, ~0.014 SOL):  tree --depth 5 --buffer 8 --canopy 0 --yes
//   node scripts/nft-setup.mjs collection --site https://asksignal.chat [--yes]
//   node scripts/nft-setup.mjs test-mint --to <wallet> --site https://asksignal.chat
//
// RPC: --rpc <url> or NFT_RPC_URL. Wallet: NFT_SECRET_KEY, else .nft/minter.json.
// Mainnet: --rpc https://mainnet.helius-rpc.com/?api-key=…  (devnet: https://devnet.helius-rpc.com/?api-key=…).
// Without --yes, `tree` and `collection` only print what they would do and what it costs.

import fs from 'node:fs'
import path from 'node:path'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createSignerFromKeypair, generateSigner, none, publicKey, signerIdentity, some } from '@metaplex-foundation/umi'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { createTreeV2, mintV2, mplBubblegum, parseLeafFromMintV2Transaction } from '@metaplex-foundation/mpl-bubblegum'
import { createCollection, mplCore } from '@metaplex-foundation/mpl-core'
import { getMerkleTreeSize } from '@metaplex-foundation/spl-account-compression'
import { setComputeUnitPrice } from '@metaplex-foundation/mpl-toolbox'

const KEYFILE = path.join(process.cwd(), '.nft', 'minter.json')
const [cmd, ...rest] = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : fallback
}
const flag = (name) => rest.includes(`--${name}`)
const die = (msg) => {
  console.error(`\n${msg}\n`)
  process.exit(1)
}

function secret() {
  const raw = process.env.NFT_SECRET_KEY || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, 'utf8') : '')
  if (!raw) die('No wallet. Run `node scripts/nft-setup.mjs keygen` or set NFT_SECRET_KEY.')
  const s = raw.trim()
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : base58.serialize(s)
  if (bytes.length !== 64) die('The secret key must be 64 bytes.')
  return bytes
}

function connect() {
  const rpc = arg('rpc', process.env.NFT_RPC_URL)
  if (!rpc) die('Pass --rpc <url> or set NFT_RPC_URL.')
  const umi = createUmi(rpc, { commitment: 'confirmed' }).use(mplBubblegum()).use(mplCore())
  umi.use(signerIdentity(createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(secret()))))
  const network = /devnet/.test(rpc) ? 'devnet' : 'mainnet'
  return { umi, network }
}
const sig58 = (s) => base58.deserialize(s)[0]
const scan = (kind, id, network) => `https://solscan.io/${kind}/${id}${network === 'devnet' ? '?cluster=devnet' : ''}`
const sol = async (umi) => Number((await umi.rpc.getBalance(umi.identity.publicKey)).basisPoints) / 1e9
// Mainnet: a priority fee so setup transactions land when the network is busy (--priority µlamports/CU).
const withFee = (umi, network, builder) =>
  network === 'mainnet' ? builder.prepend(setComputeUnitPrice(umi, { microLamports: Number(arg('priority', 50_000)) })) : builder

// Each created account's address is written down BEFORE its transaction is sent, so a timeout never
// leads to paying for a second tree / collection: the next run checks the chain first.
const noteFile = (kind, network) => path.join(process.cwd(), '.nft', `${kind}-${network}.json`)
async function previous(umi, kind, network) {
  const f = noteFile(kind, network)
  if (!fs.existsSync(f)) return null
  const note = JSON.parse(fs.readFileSync(f, 'utf8'))
  const acc = await umi.rpc.getAccount(publicKey(note.address))
  if (acc.exists && acc.data.length > 0) return { ...note, exists: true } // a real account with data, not just SOL sent to it
  const age = (Date.now() - note.at) / 1000
  if (age < 150 && !flag('force')) {
    die(`The last ${kind} attempt (${note.address}) may still land. Wait ${Math.ceil(150 - age)} s and run again.`)
  }
  return null // it never landed: safe to create a new one
}
function remember(kind, network, address) {
  fs.mkdirSync(path.dirname(noteFile(kind, network)), { recursive: true })
  fs.writeFileSync(noteFile(kind, network), JSON.stringify({ address: String(address), at: Date.now() }))
}
/** Send and wait by polling (no websocket needed): confirmed, failed on chain, or expired. */
async function sendAndPoll(umi, builder) {
  const bh = await umi.rpc.getLatestBlockhash({ commitment: 'confirmed' })
  const tx = await builder.setBlockhash(bh).buildAndSign(umi)
  const signature = tx.signatures[0]
  await umi.rpc.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 })
  process.stdout.write(`sent ${sig58(signature).slice(0, 16)}… waiting`)
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const [st] = await umi.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })
    if (st?.error) throw new Error(`failed on chain: ${JSON.stringify(st.error)}`)
    if (st && (st.commitment === 'confirmed' || st.commitment === 'finalized')) {
      process.stdout.write(' ✓\n')
      return { signature }
    }
    if (!st && Number(await umi.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }])) > bh.lastValidBlockHeight) {
      throw new Error('expired: the network did not take it (nothing was charged)')
    }
    process.stdout.write('.')
  }
  throw new Error('still not confirmed after 3 minutes')
}

async function sendCreate(umi, network, kind, address, builder) {
  console.log(`\nCreating ${kind} ${address} on ${network}…`)
  try {
    return await sendAndPoll(umi, withFee(umi, network, builder))
  } catch (e) {
    die(`Sending failed: ${e?.message ?? e}\n\nDo NOT just retry: first check ${scan('account', address, network)}\n(or run this command again in 2–3 minutes — it checks the chain before creating anything).`)
  }
}

switch (cmd) {
  case 'keygen': {
    if (fs.existsSync(KEYFILE) && !flag('force')) die(`${KEYFILE} already exists (use --force to replace it — the old wallet's SOL stays there).`)
    const umi = createUmi('https://api.devnet.solana.com')
    const kp = umi.eddsa.generateKeypair()
    fs.mkdirSync(path.dirname(KEYFILE), { recursive: true })
    fs.writeFileSync(KEYFILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 })
    console.log(`
New minting wallet: ${kp.publicKey}
Saved to ${KEYFILE} (never commit it; .nft/ is in .gitignore).

Fund it with SOL (mainnet: send ~0.5 SOL to the address above; devnet: https://faucet.solana.com),
then put the key on Netlify:
  npx netlify-cli env:set NFT_SECRET_KEY "$(cat .nft/minter.json)" --secret --context production deploy-preview
`)
    break
  }

  case 'balance': {
    const { umi, network } = connect()
    console.log(`${network}: ${umi.identity.publicKey} — ${await sol(umi)} SOL`)
    break
  }

  case 'tree': {
    const { umi, network } = connect()
    const maxDepth = Number(arg('depth', 16))
    const maxBufferSize = Number(arg('buffer', 64))
    const canopyDepth = Number(arg('canopy', 8))
    const space = getMerkleTreeSize(maxDepth, maxBufferSize, canopyDepth)
    const rent = Number((await umi.rpc.getRent(space)).basisPoints) / 1e9
    console.log(`${network} tree: depth ${maxDepth} (${2 ** maxDepth} NFTs), buffer ${maxBufferSize}, canopy ${canopyDepth}`)
    console.log(`account ${space} bytes, rent ≈ ${rent.toFixed(4)} SOL (paid once). Wallet has ${await sol(umi)} SOL.`)
    // --new: deliberately make another tree (e.g. the big one after a small test tree).
    const prevTree = flag('new') ? null : await previous(umi, 'tree', network)
    if (prevTree) {
      console.log(`\nA tree already exists: ${prevTree.address} — nothing to do.\n\n  npx netlify-cli env:set NFT_TREE ${prevTree.address}\n  npx netlify-cli env:set NFT_NETWORK ${network}\n`)
      break
    }
    if (!flag('yes')) {
      console.log('\nAdd --yes to create it.')
      break
    }
    const merkleTree = generateSigner(umi)
    const builder = await createTreeV2(umi, { merkleTree, maxDepth, maxBufferSize, canopyDepth, public: false })
    remember('tree', network, merkleTree.publicKey)
    const res = await sendCreate(umi, network, 'tree', merkleTree.publicKey, builder)
    console.log(`
Tree created: ${merkleTree.publicKey}
tx: ${scan('tx', sig58(res.signature), network)}

  npx netlify-cli env:set NFT_TREE ${merkleTree.publicKey}
  npx netlify-cli env:set NFT_NETWORK ${network}
`)
    break
  }

  case 'collection': {
    const { umi, network } = connect()
    const site = arg('site', process.env.SITE_URL)?.replace(/\/$/, '')
    if (!site) die('Pass --site https://asksignal.chat (the collection metadata is served from there).')
    const uri = `${site}/nft/collection.json`
    console.log(`${network} collection "signal", uri ${uri}, BubblegumV2 plugin. Wallet has ${await sol(umi)} SOL.`)
    const prevColl = await previous(umi, 'collection', network)
    if (prevColl) {
      console.log(`\nA collection already exists: ${prevColl.address} — nothing to do.\n\n  npx netlify-cli env:set NFT_COLLECTION ${prevColl.address}\n`)
      break
    }
    if (!flag('yes')) {
      console.log('\nAdd --yes to create it.')
      break
    }
    const collection = generateSigner(umi)
    remember('collection', network, collection.publicKey)
    const res = await sendCreate(umi, network, 'collection', collection.publicKey,
      createCollection(umi, { collection, name: 'signal', uri, plugins: [{ type: 'BubblegumV2' }] }))
    console.log(`
Collection created: ${collection.publicKey}
tx: ${scan('tx', sig58(res.signature), network)}

  npx netlify-cli env:set NFT_COLLECTION ${collection.publicKey}
`)
    break
  }

  case 'test-mint': {
    const { umi, network } = connect()
    const to = arg('to')
    const tree = arg('tree', process.env.NFT_TREE)
    const coll = arg('collection', process.env.NFT_COLLECTION)
    const site = arg('site', process.env.SITE_URL)?.replace(/\/$/, '')
    if (!to || !tree || !site) die('Need --to <wallet>, --tree (or NFT_TREE) and --site (or SITE_URL).')
    const res = await sendAndPoll(umi, withFee(umi, network, mintV2(umi, {
      leafOwner: publicKey(to),
      merkleTree: publicKey(tree),
      ...(coll ? { coreCollection: publicKey(coll) } : {}),
      metadata: { name: 'signal · test', symbol: 'SIG', uri: `${site}/nft/collection.json`, sellerFeeBasisPoints: 0, collection: coll ? some(publicKey(coll)) : none(), creators: [] },
    })))
    const sig = sig58(res.signature)
    let asset = '(read it from the tx)'
    try {
      asset = (await parseLeafFromMintV2Transaction(umi, res.signature)).id.toString()
    } catch {}
    console.log(`Minted a test cNFT to ${to}\ntx: ${scan('tx', sig, network)}\nasset: ${asset}`)
    break
  }

  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).join('\n').replace(/^\/\/ ?/gm, ''))
}
