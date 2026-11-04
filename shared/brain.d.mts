import type { ChatEvent } from '../src/backend/types'
export function planTurn(text: string, state: unknown): { tool: string; input: Record<string, unknown> }[]
export function composeReply(text: string, state: unknown, results: unknown[]): string
export function brainState(me: unknown): unknown
export function eventsFrom(results: unknown[], tasks?: unknown[]): ChatEvent[]
export function scorePitch(text: string): number
export function followUp(results: unknown[], stateAfter: unknown): { tool: string; input: Record<string, unknown> }[]
export function codeReply(result: unknown, text?: string): string
export const UPLINK: RegExp
export const MINTALLO: RegExp
export function isCommand(text: string): boolean
export function commandReply(text: string, state: unknown): { text: string; events: ChatEvent[] } | null
export const NFT_QUOTE_TASK: string
export function mintCommandReply(state: unknown): { text: string; events: ChatEvent[] }
export function nftMintedMessages(mint: unknown): { role: 'agent'; text: string; events: ChatEvent[] }[]
export function nftQuoteOffer(quote: { id: string; reward: number }): { text: string; events: ChatEvent[] }
export function nftQuoteReply(result: unknown, handle: string): { text: string; events: ChatEvent[] }
export function launchSentence(now?: number): string
export function mintTrialFollow(results: unknown[], state: unknown): { line: string; events: ChatEvent[] } | null
