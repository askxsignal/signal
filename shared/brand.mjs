// Every name, handle, link, token detail and date lives here. Used by the site and by the server functions.
// Rename the project by editing this file (and the seed rows in supabase/migrations if you change task ids).

export const BRAND = {
  name: 'signal', // the satellite you talk to
  project: 'signal',
  site: 'https://asksignal.chat', // production origin (OG image URL, docs); Netlify SITE_URL must match
  ticker: 'SIG',
  unit: '$SIG', // how amounts are shown: "1,250 $SIG"
  tagline: 'a broken satellite made of ascii. it keeps the log of the $SIG reserve.',
  siteTitle: 'signal — is anyone out there',
  description: 'Talk to signal, a broken ASCII satellite in low orbit. Pass its trials on X, make your case, earn a pending $SIG allocation.',

  // X campaign: the account to follow and the post to like / repost / reply to / quote.
  // Task links are built from these two values on the server and in demo mode.
  xHandle: 'asksignal',
  postId: '0000000000000000000',

  github: 'https://github.com/askxsignal/signal', // source code link in the footer; empty to hide

  telegram: '', // e.g. 'https://t.me/asksignal' — leave empty to hide

  // Token module. Leave ca empty until launch: the UI says "Launching soon".
  token: {
    ca: '',
    chain: 'solana',
  },

  // The NFT → $SIG swap under the launch countdown. The button stays locked until the launch; after it,
  // it becomes a link to `url` once you set one (until then it says "opens soon").
  swap: {
    url: '',
  },

  // The launch: shown with a live countdown after the last trial (the NFT quote). ISO time with offset.
  launch: {
    at: '2026-11-09T18:00:00Z',
    label: 'nov 9, 18:00 utc',
  },
}

/** "6h 38m" until the launch (or null once it has started). */
export function launchLeft(now = Date.now()) {
  if (!BRAND.launch.at) return null
  const ms = Date.parse(BRAND.launch.at) - now
  if (!(ms > 0)) return null
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const hh = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return `${d}d ${hh}h`
  if (hh > 0) return `${hh}h ${String(mm).padStart(2, '0')}m`
  return mm > 0 ? `${mm} min` : 'less than a minute'
}

/** Build the intent URL for a task, replacing {handle} / {post} / {ref} placeholders. */
export function taskUrl(template, refLink = '') {
  if (!template) return null
  return template
    .replaceAll('{handle}', encodeURIComponent(BRAND.xHandle))
    .replaceAll('{post}', encodeURIComponent(BRAND.postId))
    .replaceAll('{ref}', encodeURIComponent(refLink))
}

export function tokenLinks(ca = BRAND.token.ca) {
  if (!ca) return []
  return [
    { label: 'pump.fun', url: `https://pump.fun/coin/${ca}` },
    { label: 'Jupiter', url: `https://jup.ag/swap/SOL-${ca}` },
    { label: 'DexScreener', url: `https://dexscreener.com/solana/${ca}` },
    { label: 'Solscan', url: `https://solscan.io/token/${ca}` },
  ]
}

/** Fill {handle} / {ticker} / {name} in task titles and copy. */
export function fillText(s) {
  return String(s ?? '').replaceAll('{handle}', BRAND.xHandle).replaceAll('{ticker}', BRAND.ticker).replaceAll('{name}', BRAND.name)
}
