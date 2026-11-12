// Pages the agent renders inline with `html_render` (chat/visuals.mjs on the bridge).
// The reply's visual part stands for the call, so its tool card is not shown.

/** The tool's name; through the gateway it is `browser__html_render`. */
export const RENDER_TOOL = 'html_render'

export const isRenderTool = (tool?: string) => tool === RENDER_TOOL || !!tool?.endsWith(`__${RENDER_TOOL}`)
