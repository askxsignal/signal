// Live backend: Netlify functions under /api. Sign-in is X OAuth (/auth/x/start → /auth/x/callback), session in an HttpOnly cookie.

import { ApiUnavailable, type AllocationStatus, type Backend, type LogRow, type Me, type Msg, type NftMint, type NftResult, type SendResult } from './types'
import { store } from '../util'

async function req<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = (res.headers.get('content-type') ?? '').includes('json')
  // Netlify's edge rate limit answers 429 before the function runs, without JSON.
  if (res.status === 429 && !json) {
    return { status: 429, data: { error: 'rate_ip', retryAfter: 60, message: 'too many voices from your network. try again in a minute.' } as T }
  }
  // HTML instead of JSON means the functions are not deployed.
  if (!json) throw new ApiUnavailable('api_unavailable')
  return { status: res.status, data: (await res.json()) as T }
}

export function apiBackend(): Backend {
  return {
    mode: 'api',
    async me() {
      const r = await req<Me>('/api/me')
      return r.status === 200 ? r.data : null
    },
    async history() {
      const r = await req<{ messages: Msg[] }>('/api/history')
      return r.status === 200 ? r.data.messages : []
    },
    async send(text: string): Promise<SendResult> {
      const r = await req<SendResult & { error?: string; message?: string }>('/api/chat', { text })
      if (r.status === 401) return { reply: { role: 'agent', text: '', events: [{ type: 'signin' }] }, me: null, error: 'unauthorized' }
      if (r.status === 429) {
        const d = r.data as { message?: string; retryAfter?: number; error?: string }
        return { reply: { role: 'agent', text: d.message ?? 'slow down. the dish needs a moment.' }, me: null, error: d.error ?? 'rate_limited', retryAfter: d.retryAfter }
      }
      if (r.status !== 200) return { reply: { role: 'agent', text: 'static on the line. try again in a moment.' }, me: null, error: r.data.error ?? 'server' }
      return r.data
    },
    async openTask(id: string) {
      const r = await req<{ ok: boolean; openedAt?: string; error?: string }>('/api/task/open', { task_id: id })
      return { ok: !!r.data.ok, openedAt: r.data.openedAt ? Date.parse(r.data.openedAt) : undefined, error: r.data.error }
    },
    async login() {
      return { ok: false, error: 'use_x', message: 'Sign in with X.' }
    },
    xSignInUrl(returnTo: string) {
      const ref = new URLSearchParams(location.search).get('ref') ?? store.get('signal_ref') ?? ''
      return `/auth/x/start?return=${encodeURIComponent(returnTo)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`
    },
    async logout() {
      await req('/api/logout', {})
    },
    async leaderboard() {
      const r = await req<LogRow[]>('/api/leaderboard')
      return r.status === 200 && Array.isArray(r.data) ? r.data : []
    },
    async nftMint(wallet?: string): Promise<NftResult> {
      const r = await req<NftResult>('/api/nft/mint', wallet ? { wallet } : {})
      if (r.status === 401) return { ok: false, error: 'unauthorized' }
      if (r.status === 429) return { ok: false, error: 'rate_ip' }
      return r.data
    },
    async nftStatus() {
      const r = await req<{ eligible: boolean; allocationStatus: AllocationStatus; mint: NftMint | null }>('/api/nft/status')
      if (r.status !== 200) return { ok: false, error: (r.data as { error?: string }).error ?? 'server' }
      return { ok: true, ...r.data }
    },
    nftPreviewUrl(key: string) {
      return `/api/nft/preview.png?v=${encodeURIComponent(key)}`
    },
  }
}
