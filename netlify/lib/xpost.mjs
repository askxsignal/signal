// Check a public X post without the paid X API: X's oEmbed endpoint (publish.twitter.com) returns the
// post's author and text for public posts. Used to check reply / card post links.
// Not part of X's paid API; if X ever changes it, callers get 'unavailable' and decide what to do.

const POST_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/i
// An attached image shows up in the oEmbed HTML as a pic.twitter.com (or pic.x.com) link.
const MEDIA = /pic\.(?:twitter|x)\.com\//i

/**
 * @param {string} url
 * @param {string} handle  the signed-in handle; the post must be theirs
 * @param {{ must?: string[], media?: boolean } | string | null} need  text the post must contain, and whether it needs an image
 * @returns {Promise<{ status: 'ok' | 'bad_url' | 'mismatch' | 'not_found' | 'missing_text' | 'no_media' | 'unavailable', author?: string }>}
 */
export async function checkPost(url, handle, need = null) {
  const want = typeof need === 'string' ? { must: [need] } : (need ?? {})
  const m = String(url ?? '').trim().match(POST_URL)
  if (!m) return { status: 'bad_url' }
  const me = String(handle ?? '').toLowerCase()
  if (m[1].toLowerCase() !== me) return { status: 'mismatch', author: m[1].toLowerCase() }
  const canonical = `https://twitter.com/${m[1]}/status/${m[2]}`
  try {
    const res = await fetch(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(canonical)}`, {
      signal: AbortSignal.timeout(4500),
      headers: { accept: 'application/json' },
    })
    if (res.status === 404 || res.status === 403) return { status: 'not_found' }
    if (!res.ok) return { status: 'unavailable' }
    const data = await res.json()
    // author_url is the real author even when the URL was typed with someone else's handle.
    const author = String(data.author_url ?? '').toLowerCase().replace(/\/$/, '').split('/').pop()
    if (author && author !== me) return { status: 'mismatch', author }
    // Only the post body counts: the trailing "— Name (@handle) date" line is not the post.
    const html = String(data.html ?? '')
    const cut = html.lastIndexOf('&mdash;')
    const body = (cut > 0 ? html.slice(0, cut) : html).toLowerCase()
    for (const word of want.must ?? []) if (!body.includes(String(word).toLowerCase())) return { status: 'missing_text', author }
    if (want.media && !MEDIA.test(body)) return { status: 'no_media', author }
    return { status: 'ok', author }
  } catch (e) {
    console.error('oembed check failed', e?.name ?? e)
    return { status: 'unavailable' }
  }
}
