// chat/visuals.mjs — charts, graphs and diagrams the agent shows inline in a reply.
//
// T3 Code's html_preview / html_render, on each chat run's /agent-mcp endpoint
// beside the browser and ask_questions. The agent writes one self-contained HTML
// page; `html_preview` loads it in the box's headless Chromium (browser/
// manager.mjs `renderPage`) and returns a screenshot, the page's height and its
// console, so the agent can see what it made and fix it; `html_render` stores the
// page as a chat upload and adds a `visual` part to the reply, which the
// dashboard shows in a sandboxed frame fitted to the page's height
// (web/src/chat/VisualFrame.tsx) and the iPhone app in a WebView held to the
// same rules (mobile/src/ui/BridgeWebView.tsx).
//
// The page never runs with Totem's origin. It is served only with VISUAL_CSP,
// whose `sandbox` gives it an opaque origin even when opened on its own, and the
// dashboard's frame is sandboxed too, so a page cannot read Totem's storage or
// call its API as the owner. Scripts and styles may load from the three CDNs a
// chart library comes from; fetch, XHR, WebSockets, remote images, frames and
// forms are refused. That is not a seal: CSP cannot stop a page navigating
// itself (or WebRTC), so a page can still carry data out in a URL. The preview
// refuses every navigation (it runs with nobody watching) and the dashboard
// closes a frame that leaves its page. The tools are offered only beside the
// agent browser (grantChatAccess), whose run already has the network through
// it, so a chart adds no new way out; a run without it (a Codex sandbox with the
// browser off) gets no charts.
//
// The bootstrap (theme variables, base sheet, height reports, link handling) is
// adapted from T3 Code's packages/shared/src/htmlRender.ts, MIT licensed,
// Copyright (c) 2026 T3 Tools Inc. Totem is dark only, so the theme is fixed
// rather than sent by the host.

export const PREVIEW_TOOL = 'html_preview'
export const RENDER_TOOL = 'html_render'

export const VISUAL_MAX_CHARS = 512_000
export const VISUAL_MIN_HEIGHT = 80
export const VISUAL_MAX_HEIGHT = 2000
export const VISUAL_DEFAULT_WIDTH = 728
export const VISUAL_MAX_TITLE = 200

/** Where scripts, styles and fonts may come from; the tool descriptions name them. */
export const VISUAL_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com']

// `sandbox` without allow-same-origin: an opaque origin, wherever the page is opened.
export const VISUAL_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

export const VISUAL_CSP = [
  `sandbox ${VISUAL_SANDBOX}`,
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${VISUAL_CDNS.join(' ')}`,
  `style-src 'unsafe-inline' ${VISUAL_CDNS.join(' ')} https://fonts.googleapis.com`,
  `font-src data: ${VISUAL_CDNS.join(' ')} https://fonts.gstatic.com`,
  'img-src data: blob:',
  'media-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

// Totem's dashboard tokens (web/src/styles.css) under the names T3 gives the
// model, so a page written for one reads right in the other.
export const VISUAL_THEME = {
  '--background': '#0f1115',
  '--foreground': '#e6e8ee',
  '--muted': '#1d212c',
  '--muted-foreground': '#8a91a3',
  '--card': '#161922',
  '--card-foreground': '#e6e8ee',
  '--popover': '#1d212c',
  '--popover-foreground': '#e6e8ee',
  '--secondary': '#1d212c',
  '--secondary-foreground': '#e6e8ee',
  '--border': '#262b38',
  '--input': '#262b38',
  '--ring': '#5b8cff',
  '--primary': '#5b8cff',
  '--primary-foreground': '#ffffff',
  '--accent': '#5b8cff',
  '--accent-foreground': '#ffffff',
  '--accent-surface': 'rgba(91,140,255,0.14)',
  '--accent-surface-foreground': '#a9c1ff',
  '--destructive': '#f0506e',
  '--destructive-foreground': '#ffffff',
  '--destructive-surface': 'rgba(240,80,110,0.14)',
  '--warning': '#e3b341',
  '--warning-foreground': '#1a1405',
  '--warning-surface': 'rgba(227,179,65,0.14)',
  '--success': '#3fb950',
  '--success-foreground': '#04130a',
  '--info': '#5b8cff',
  '--info-foreground': '#ffffff',
  '--code-background': '#161922',
  '--code-foreground': '#e6e8ee',
  '--chart-1': '#5b8cff',
  '--chart-2': '#2dd4bf',
  '--chart-3': '#fbbf24',
  '--chart-4': '#c084fc',
  '--chart-5': '#fb7185',
  '--chart-6': '#a3e635',
  '--radius': '10px',
  '--font-sans': '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  '--font-mono': '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
}

const THEME_GUIDE =
  'Use the theme CSS variables on :root, not fixed colours: --foreground, --muted-foreground, --card, --border, --accent, ' +
  '--destructive, --warning, --success, --info (most have a -foreground; accent, destructive and warning have a -surface), ' +
  '--chart-1 to --chart-6 for series, --radius, --font-sans, --font-mono. The page is dark; the base sheet sets text and font.'

const LAYOUT_GUIDE =
  `The frame is the reply's width (about ${VISUAL_DEFAULT_WIDTH}px on a computer, 360px on a phone) and sits on the chat's own background. ` +
  'Leave html, body and the outer element without a background, card, border, banner title or side padding. ' +
  'There is an 8px gutter on html; use fluid widths inside it. A box that needs its own background gets 16px padding and var(--radius) corners. ' +
  'Give charts a fixed pixel height. Let content set the page height: no vh units, no height:100% on html or body.'

const PAGE_RULES =
  `One complete, self-contained HTML document with inline <style> and <script>. Libraries (Chart.js, D3, ECharts, Plotly, Mermaid…) may load from ${VISUAL_CDNS.map((c) => c.replace('https://', '')).join(', ')} only; ` +
  'put the data in the page itself. fetch, remote images, iframes and forms are blocked; images must be data: URIs. ' +
  'Open a link with <a href> or window.open, never by setting location (a page that navigates away is closed).'

const htmlProp = { type: 'string', minLength: 1, maxLength: VISUAL_MAX_CHARS, description: 'A complete, self-contained HTML document.' }

export const PREVIEW_TOOL_DESCRIPTOR = {
  name: PREVIEW_TOOL,
  title: 'Preview a chart',
  description:
    `Check an HTML page before ${RENDER_TOOL}: returns a screenshot of it as it will look in the chat, its contentHeight, and its console output (blocked requests show there). ` +
    `Fix anything wrong and preview again, then pass the same HTML to ${RENDER_TOOL}. ${PAGE_RULES} Theme and layout rules are in ${RENDER_TOOL}.`,
  inputSchema: {
    type: 'object',
    properties: {
      html: htmlProp,
      width: { type: 'integer', minimum: 240, maximum: 1600, description: `CSS pixels. Default ${VISUAL_DEFAULT_WIDTH}; about 390 to check a phone.` },
    },
    required: ['html'],
  },
  annotations: { title: 'Preview a chart', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

export const RENDER_TOOL_DESCRIPTOR = {
  name: RENDER_TOOL,
  title: 'Show a chart',
  description:
    'Show a finished HTML page (chart, graph, diagram, small interactive visual) inline in this chat, in your reply where you call it. ' +
    `Do not announce, describe or restate it in your text. ${PAGE_RULES} ${LAYOUT_GUIDE} ${THEME_GUIDE}`,
  inputSchema: {
    type: 'object',
    properties: {
      html: htmlProp,
      title: { type: 'string', minLength: 1, maxLength: VISUAL_MAX_TITLE, description: 'A short name for it, e.g. "Weekly mileage".' },
      height: { type: 'integer', minimum: VISUAL_MIN_HEIGHT, maximum: VISUAL_MAX_HEIGHT, description: `Frame height in CSS pixels. Use the contentHeight from ${PREVIEW_TOOL}.` },
    },
    required: ['html', 'title', 'height'],
  },
  annotations: { title: 'Show a chart', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}

/** tools/list for a run's grant: both, when the run has charts. */
export const visualToolDescriptors = (access) => (access?.visual ? [PREVIEW_TOOL_DESCRIPTOR, RENDER_TOOL_DESCRIPTOR] : [])

export const RENDERED_FOR_AGENT =
  "Shown to the owner in your reply. Don't mention or describe it; write only what it doesn't already say."

/** The chat prompt's rule. */
export const VISUAL_RULES =
  'CHARTS: When the answer is data with a trend or a comparison, or the owner asks for a chart, graph, diagram or visual, show it inline: write one self-contained HTML page, '
  + `check it with ${PREVIEW_TOOL} (a screenshot, its contentHeight and console), fix what looks wrong, then call ${RENDER_TOOL} with the same HTML, a short title and that height `
  + `(in the totem-browser server, or browser__${RENDER_TOOL} through totem-gateway). It appears in the chat where you call it, so do not describe or restate it; write only what it doesn't say. `
  + 'Use it for a visual, not for text or tables Markdown already shows. Never start a server or save a file just to show a chart. For an image to post or send elsewhere, make a .png file instead.'

// Units that follow the frame's height: vh and its small/large/dynamic forms, vb, vmax
// (the height, once a page is taller than wide), and container units, which fall
// back to the viewport when nothing is a container.
const VIEWPORT_UNIT = /(?:^|[^\w-])(?:\d+(?:\.\d+)?|\.\d+)(?:(?:s|l|d)?(?:vh|vb|vmax)|cq(?:h|b|max))\b/i
// Every scan over agent HTML runs on the bridge's one thread, so a tag's attributes
// are read to a bound: an unclosed tag repeated through 512k must not rescan to the end.
const STYLE_BLOCK = /<style\b[^>]{0,512}>([\s\S]*?)(?:<\/style\s*>|$)|\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const HEAD_SCAN = 64 * 1024

/** Why this HTML cannot be shown, or '' when it can. */
export function checkVisualHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return 'html is required: one complete HTML document.'
  if (html.length > VISUAL_MAX_CHARS) return `The page is ${html.length} characters; the limit is ${VISUAL_MAX_CHARS}. Put less data in it or compute it in the page's script.`
  for (const m of html.matchAll(STYLE_BLOCK)) {
    const css = (m[1] ?? m[2] ?? m[3] ?? '').replace(/[A-Za-z0-9+/=]{200,}/g, '')
    if (VIEWPORT_UNIT.test(css)) return 'The page sizes something from the frame\'s height (vh, vb, vmax or a cq unit). The frame fits the page\'s height, so that grows without end: give charts a fixed pixel height instead.'
  }
  return ''
}

/** A title fit for the card and a file name. */
export function visualTitle(title) {
  const t = String(title ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, VISUAL_MAX_TITLE).trim()
  return t || 'Chart'
}

export const clampVisualHeight = (h) => Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(Number(h) || 320)))

const BASE_CSS =
  'html{box-sizing:border-box;padding:8px;background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}' +
  'html::-webkit-scrollbar{display:none}body{margin:0}*,*::before,*::after{box-sizing:inherit}code,kbd,pre,samp{font-family:var(--font-mono)}' +
  'a{color:var(--accent)}:where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}'

// Messages to the host (web/src/chat/visuals.ts reads them).
export const SIZE_MESSAGE = 'totem-visual:size'
export const OPEN_LINK_MESSAGE = 'totem-visual:open'

// Framed: report the page's height whenever it changes, and hand http(s) links
// to the host to open, both <a href> clicks and window.open from a chart's own
// click handler (the frame has no popups). Opened on its own (a new tab, the
// iPhone app's WebView, which injects its own height report): links open in a new window.
const BOOTSTRAP_SCRIPT = `(function(){var f=window.parent!==window;if(f)window.open=function(t){var u;if(t==null||t==="")return null;try{u=new URL(String(t),document.baseURI);}catch(x){return null;}if(/^https?:$/.test(u.protocol)&&u.href.split("#")[0]!==location.href.split("#")[0])window.parent.postMessage({type:${JSON.stringify(OPEN_LINK_MESSAGE)},url:u.href},"*");return null;};document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;e.preventDefault();if(f)window.parent.postMessage({type:${JSON.stringify(OPEN_LINK_MESSAGE)},url:u.href},"*");else window.open(u.href,"_blank","noopener");},true);if(!f)return;var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({type:${JSON.stringify(SIZE_MESSAGE)},height:v},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);})();`

function bootstrapMarkup(markup) {
  const vars = Object.entries(VISUAL_THEME).map(([k, v]) => `${k}:${v};`).join('')
  return [
    /<meta\s[^>]{0,512}charset/i.test(markup.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    /<meta\s[^>]{0,512}name\s*=\s*["']?viewport/i.test(markup.slice(0, HEAD_SCAN)) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="totem-theme">:root{color-scheme:dark;${vars}}${BASE_CSS}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join('')
}

// Blank inert content without moving offsets, so the bootstrap never lands inside
// a comment, a script, a style or a template.
function blankNonMarkup(html) {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => ' '.repeat(match.length),
  )
  const parts = []
  let depth = 0
  let start = 0
  let at = 0
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]{0,512})?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length
      parts.push(scan.slice(at, start), ' '.repeat(end - start))
      at = end
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), ' '.repeat(scan.length - start))
    at = scan.length
  }
  parts.push(scan.slice(at))
  return parts.join('')
}

/** The page as it is stored and served: the theme, base sheet and bootstrap first in <head>. */
export function prepareVisualHtml(html) {
  const scan = blankNonMarkup(html)
  const markup = bootstrapMarkup(scan)
  // <head> and <html> open a document; looking past its start only costs time.
  const top = scan.slice(0, HEAD_SCAN)
  const headOpen = /<head(?:\s[^>]{0,512})?>/i.exec(top)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + markup + html.slice(at)
  }
  const htmlOpen = /<html(?:\s[^>]{0,512})?>/i.exec(top)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  return `<!doctype html><head>${markup}</head>${html}`
}

const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * html_preview. `renderPage` is the browser manager's: it loads the prepared page
 * under VISUAL_CSP at a width and returns { contentHeight, capturedHeight,
 * consoleMessages, screenshot (PNG Buffer) }.
 */
export async function previewVisual(args, { renderPage }) {
  const html = args?.html
  const problem = checkVisualHtml(html)
  if (problem) return toolError(problem)
  const width = Math.min(1600, Math.max(240, Math.round(Number(args?.width) || VISUAL_DEFAULT_WIDTH)))
  let shot
  try {
    shot = await renderPage({ html: prepareVisualHtml(html), csp: VISUAL_CSP, width })
  } catch (e) {
    return toolError(`The preview failed: ${e?.message || e}. You can still call ${RENDER_TOOL} with a height that fits the page.`)
  }
  const info = { width, contentHeight: shot.contentHeight, capturedHeight: shot.capturedHeight, consoleMessages: shot.consoleMessages || [] }
  // No structuredContent: Codex sends only that to the model when it is there,
  // which would drop the screenshot this tool exists for.
  return {
    content: [
      { type: 'text', text: JSON.stringify(info) },
      { type: 'image', mimeType: 'image/png', data: shot.screenshot.toString('base64') },
    ],
  }
}

/**
 * html_render: store the page and return the part to add to the reply. `uploads`
 * is the chat upload store; the page is kept as a `visual` upload, which the
 * uploads route serves inline under VISUAL_CSP.
 */
export async function storeVisual(args, { uploads }) {
  const html = args?.html
  const problem = checkVisualHtml(html)
  if (problem) return { error: problem }
  const title = visualTitle(args?.title)
  const saved = await uploads.save({ buffer: Buffer.from(prepareVisualHtml(html), 'utf8'), name: `${title}.html`, mime: 'text/html', visual: true })
  return { part: { type: 'visual', id: saved.id, uploadId: saved.id, title, height: clampVisualHeight(args?.height) } }
}

export function renderedResult(part) {
  // Text only, for the same reason as previewVisual: the note must reach Codex too.
  return { content: [{ type: 'text', text: `${JSON.stringify({ shown: true, title: part.title })}\n${RENDERED_FOR_AGENT}` }] }
}

export const visualToolError = toolError
