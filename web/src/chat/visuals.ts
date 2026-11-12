// Pages the agent renders inline with `html_render` (chat/visuals.mjs on the bridge).
// The reply's visual part stands for the call, so its tool card is not shown.

/** The tool's name; through the gateway it is `browser__html_render`. */
export const RENDER_TOOL = 'html_render'

export const isRenderTool = (tool?: string) => tool === RENDER_TOOL || !!tool?.endsWith(`__${RENDER_TOOL}`)

// The frame's sandbox. With no allow-same-origin the page has an opaque origin:
// it runs its own script but cannot read Totem's storage or call its API. No
// popups either: a link asks the host to open it (totem-visual:open). The bridge
// serves the page under a sandbox of its own too (VISUAL_CSP), for when it is
// opened on its own; chat/visuals.test.mjs keeps this one inside that one.
export const VISUAL_SANDBOX = 'allow-scripts'

export const VISUAL_MIN_HEIGHT = 80
// A page that grows with its frame (script sizing itself from innerHeight) stops
// here; vh, vb and vmax are refused at render.
export const VISUAL_MAX_FIT_HEIGHT = 8000

export type VisualMessage = { kind: 'size'; height: number } | { kind: 'open'; url: string }

/** What the page's bootstrap posted: its height, or a link it wants opened. */
export function readVisualMessage(data: unknown): VisualMessage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type === 'totem-visual:size' && typeof d.height === 'number' && Number.isFinite(d.height) && d.height > 0) {
    return { kind: 'size', height: Math.min(VISUAL_MAX_FIT_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.ceil(d.height))) }
  }
  if (d.type === 'totem-visual:open' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url) && d.url.length <= 4096) {
    return { kind: 'open', url: d.url }
  }
  return null
}

/**
 * Whether a chart's `open` request is let through: only to another site. A chart
 * is agent-written and can post at any time, so a URL on Totem's own origin (a
 * page, a file, an API route the dashboard would open with the owner's sign-in)
 * is dropped.
 */
export const visualOpensOutside = (url: string, origin: string) => {
  try { return new URL(url).origin !== origin } catch { return false }
}
