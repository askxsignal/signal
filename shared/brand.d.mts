export const BRAND: {
  name: string; project: string; site: string; ticker: string; unit: string; tagline: string; siteTitle: string; description: string
  xHandle: string; postId: string; github: string; telegram: string; token: { ca: string; chain: string }
  swap: { url: string }
  launch: { at: string; label: string }
}
export function launchLeft(now?: number): string | null
export function taskUrl(template: string | null, refLink?: string): string | null
export function tokenLinks(ca?: string): { label: string; url: string }[]
export function fillText(s: string): string
