export const TOOL_DEFS: { name: string; description: string; schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] } }[]
export function instructions(me: unknown, convo?: { userMessages: number; cardsShown: string[] }): string
