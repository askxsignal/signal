// Shared shapes between the UI and both backends (live API and DEMO).

export type TaskStatus = 'todo' | 'opened' | 'done'
export type Verification = 'timer' | 'reply_url' | 'referral' | 'x_api'

export interface Task {
  id: string
  type: string
  title: string
  reward: number
  verification: Verification
  waitSec: number
  actionUrl: string | null
  required: boolean
  status: TaskStatus
  openedAt: number | null // ms, server clock
  params?: Record<string, unknown>
}

export interface Me {
  user: { username: string; name: string; avatar: string | null }
  allocation: number // credited to the pending allocation (not a balance)
  pendingRefs: number // referral rewards waiting for the friend to qualify
  refLink: string
  referrals: { total: number; qualified: number }
  wallet: string | null
  tasks: Task[]
  pitch: { attempts: number; max: number; best: number; unlocked: boolean }
  /** For the operator pass: rank by allocation, how many operators, this operator's number (migration 0005). */
  standing?: { rank: number; total: number; no: number; joinedAt: string } | null
  /** The NFT (migration 0010): may this person mint, the reserve's stamp, their mint. */
  nft?: NftInfo | null
  serverNow: number // ms
}

export type AllocationStatus = 'pending' | 'approved' | 'rejected'
export interface NftMint {
  id: string
  status: 'minting' | 'sent' | 'minted' | 'failed'
  assetId: string | null
  signature: string | null
  owner: string
  network: 'mainnet' | 'devnet' | string
  links?: { tx: string | null; asset: string | null; image: string }
}
export interface NftInfo {
  eligible: boolean
  /** The mint trials (like / repost / reply, migration 0012) are done. */
  ready?: boolean
  allocationStatus: AllocationStatus
  mint: NftMint | null
}
export interface NftResult {
  ok: boolean
  mint?: NftMint | null
  error?: string
  /** signal's messages once the mint landed (receipt + the quote offer); sent once, also stored in the chat. */
  messages?: Msg[]
}

export type ChatEvent =
  | { type: 'task'; taskId: string }
  | { type: 'reward'; amount: number; reason: string }
  | { type: 'invite' }
  | { type: 'token' }
  | { type: 'wallet'; address: string }
  | { type: 'signin' }
  | { type: 'card' }
  | { type: 'nft' }
  | { type: 'minted'; id: string; signature: string | null; assetId: string | null; owner: string; network: string }
  | { type: 'launch' }
  | { type: 'log' }

export interface Msg {
  role: 'user' | 'agent'
  text: string
  events?: ChatEvent[]
  at?: string
}

export interface SendResult {
  reply: Msg
  me: Me | null
  error?: string
  brain?: string
  retryAfter?: number // seconds, when a limit was hit
}

/** One line of the log (the public leaderboard). */
export interface LogRow {
  rank: number
  username: string
  avatar: string | null
  points: number
}

export interface Backend {
  mode: 'api' | 'demo'
  me(): Promise<Me | null>
  history(): Promise<Msg[]>
  send(text: string): Promise<SendResult>
  openTask(id: string): Promise<{ ok: boolean; openedAt?: number; error?: string }>
  /** DEMO only: sign in by typing an X handle. */
  login(handle: string): Promise<LoginResult>
  /** Live: where "Sign in with X" goes (the server's OAuth start). */
  xSignInUrl?(returnTo: string): string
  logout(): Promise<void>
  /** The log: top operators by allocation. */
  leaderboard(): Promise<LogRow[]>
  /** Live only: mint the NFT (wallet only when none is saved), check a mint, the preview image. */
  nftMint?(wallet?: string): Promise<NftResult>
  nftStatus?(): Promise<NftResult & { allocationStatus?: AllocationStatus; eligible?: boolean }>
  nftPreviewUrl?(key: string): string
}

export interface LoginResult {
  ok: boolean
  error?: string
  message?: string
}

export class ApiUnavailable extends Error {}
