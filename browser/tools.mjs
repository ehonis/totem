// The browser as MCP tools, named and shaped like T3 Code's `preview_*` toolkit
// so a model that has learned one drives the other the same way: snapshot
// first, act with the role locators the snapshot hands back, snapshot again.
//
// A snapshot answers with text *and* the PNG, so the model sees the page even
// when nobody asked it to show anything. To show the user, it saves the
// screenshot (`save: true`) and puts the returned path in its reply as a
// Markdown image; the bridge turns that into an attachment when the turn ends.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserError, VIEWPORT_PRESETS } from './manager.mjs'

const tabId = { type: 'string', description: "Exact browser tab to target. Omit to use this chat's current tab." }
const timeoutMs = { type: 'integer', minimum: 1, maximum: 60000, description: 'Maximum wait in milliseconds. Defaults to 15000; maximum 60000.' }
const locator = { type: 'string', description: "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use preview_snapshot first to inspect the page." }
const selector = { type: 'string', description: "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting." }
const URL_GUIDANCE = 'Absolute http(s) URL or a schemeless host such as t3.chat or localhost:5173. Schemeless public hosts use https; loopback hosts use http.'

const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false })

// Annotations: browsing reaches the open web; "destructive" means it can change
// page state (submit a form, click buy), which is every interaction.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const SAFE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
const ACT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

export const BROWSER_TOOLS = [
  {
    name: 'preview_status', title: 'Get browser status', annotations: READ, op: 'status',
    description: "Report whether this chat's browser tab is open, including its URL, title, loading state, viewport size and the other open tabs. Pass tabId to inspect a specific tab.",
    inputSchema: object({ tabId }),
  },
  {
    name: 'preview_open', title: 'Open browser', annotations: SAFE, op: 'open',
    description: "Open this chat's browser tab (headless Chromium on the owner's machine; the chat shows them a live view). Pass url to load a page, tabId to reuse a specific tab, or reuseExistingTab=false for a new tab. Use preview_navigate afterwards when readiness matters.",
    inputSchema: object({
      tabId,
      url: { type: 'string', description: `Optional initial page URL. ${URL_GUIDANCE} Omit to open a blank tab.` },
      reuseExistingTab: { type: 'boolean', description: "Reuse tabId when supplied, otherwise this chat's current tab. Defaults to true; set false to create a new tab." },
    }),
  },
  {
    name: 'preview_navigate', title: 'Navigate browser', annotations: SAFE, op: 'navigate',
    description: "Navigate a browser tab. Pass {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server on this box. Exactly one of url or target is required.",
    inputSchema: object({
      tabId,
      url: { type: 'string', description: `Website URL. ${URL_GUIDANCE}` },
      target: {
        type: 'object', description: "Environment-relative target, for example {kind:'environment-port',port:5173,path:'/settings'}.",
        properties: {
          kind: { type: 'string', enum: ['url', 'environment-port'] },
          url: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          protocol: { type: 'string', enum: ['http', 'https'] },
          path: { type: 'string' },
        },
        required: ['kind'],
      },
      readiness: { type: 'string', enum: ['load', 'domContentLoaded', 'none'], description: "Readiness milestone before returning. 'load' (default) waits for loading to stop." },
      timeoutMs,
    }),
  },
  {
    name: 'preview_resize', title: 'Resize browser viewport', annotations: { ...SAFE, idempotentHint: true }, op: 'resize',
    description: `Resize a browser tab's viewport. Use {mode:'fill'} for the default desktop size, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. Presets: ${Object.keys(VIEWPORT_PRESETS).join(', ')}.`,
    inputSchema: object({
      tabId,
      mode: { type: 'string', enum: ['fill', 'freeform', 'preset'] },
      preset: { type: 'string', enum: Object.keys(VIEWPORT_PRESETS) },
      width: { type: 'integer', minimum: 200, maximum: 3840 },
      height: { type: 'integer', minimum: 200, maximum: 2160 },
      orientation: { type: 'string', enum: ['portrait', 'landscape'] },
      timeoutMs,
    }, ['mode']),
  },
  {
    name: 'preview_set_appearance', title: 'Set page appearance', annotations: { ...SAFE, idempotentHint: true }, op: 'setColorScheme',
    description: "Emulate prefers-color-scheme in a browser tab: {colorScheme:'dark'}, {colorScheme:'light'}, or {colorScheme:'system'} to clear the override.",
    inputSchema: object({ tabId, colorScheme: { type: 'string', enum: ['light', 'dark', 'system'] } }, ['colorScheme']),
  },
  {
    name: 'preview_snapshot', title: 'Look at the page', annotations: READ, op: 'snapshot',
    description: 'Inspect a page before interacting: page state, the accessibility outline, interactive elements with locators, visible text, console errors, failed requests, recent actions, and a PNG screenshot you can see. Text is capped near 20 KB; use preview_evaluate to read more. Set includeImage=false for text only. Set save=true to also write the PNG to disk and get its path as screenshotPath, which you can show the owner by putting ![what it shows](screenshotPath) in your reply.',
    inputSchema: object({
      tabId,
      includeImage: { type: 'boolean', description: 'Include the PNG in the tool response. Defaults to true.' },
      save: { type: 'boolean', description: 'Write the screenshot PNG to disk and return its absolute path as screenshotPath. Defaults to false.' },
    }),
  },
  {
    name: 'preview_click', title: 'Click on the page', annotations: ACT, op: 'click',
    description: 'Click exactly one target. Prefer a Playwright locator from the snapshot; selector accepts CSS; x and y (viewport CSS pixels) must be supplied together.',
    inputSchema: object({ tabId, locator, selector, x: { type: 'number' }, y: { type: 'number' }, timeoutMs }),
  },
  {
    name: 'preview_type', title: 'Type on the page', annotations: ACT, op: 'type',
    description: 'Insert literal text into one input, or the focused element when no target is given. Prefer a Playwright locator; set clear=true to replace existing text.',
    inputSchema: object({ tabId, text: { type: 'string', description: 'Literal text to insert.' }, locator, selector, clear: { type: 'boolean' }, timeoutMs }, ['text']),
  },
  {
    name: 'preview_press', title: 'Press a key', annotations: ACT, op: 'press',
    description: "Press one keyboard key. Examples: {key:'Enter'}, {key:'Escape'}, {key:'a',modifiers:['Control']}.",
    inputSchema: object({
      tabId,
      key: { type: 'string', description: 'Key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.' },
      modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
    }, ['key']),
  },
  {
    name: 'preview_scroll', title: 'Scroll the page', annotations: SAFE, op: 'scroll',
    description: 'Scroll the viewport, or a container given by locator/selector. Positive deltaY scrolls down, positive deltaX scrolls right.',
    inputSchema: object({ tabId, deltaX: { type: 'number' }, deltaY: { type: 'number' }, locator, selector }),
  },
  {
    name: 'preview_evaluate', title: 'Run JavaScript on the page', annotations: ACT, op: 'evaluate',
    description: 'Evaluate a JavaScript expression in the page and return {value}, a JSON-serializable result up to 64 KB. The expression may change page state. Prefer snapshot and semantic actions; use this to read more or for unsupported interactions.',
    inputSchema: object({ tabId, expression: { type: 'string', description: 'For example document.title or (() => ({href: location.href}))().' } }, ['expression']),
  },
  {
    name: 'preview_wait_for', title: 'Wait for the page', annotations: READ, op: 'waitFor',
    description: 'Wait until all supplied conditions match: a locator/selector is visible, text appears, or the URL includes a substring. Use after click/type when the page changes asynchronously.',
    inputSchema: object({
      tabId, locator, selector,
      text: { type: 'string', description: 'Case-sensitive substring that must appear in visible text.' },
      urlIncludes: { type: 'string', description: 'Substring that must appear in the current URL.' },
      timeoutMs,
    }),
  },
]

export const BROWSER_TOOL_INDEX = new Map(BROWSER_TOOLS.map((t) => [t.name, t]))

/** tools/list descriptors (no internal fields). */
export const browserToolDescriptors = () => BROWSER_TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }))

const json = (v) => JSON.stringify(v, null, 1)

// Models guess at shapes. {role:'link', name:'408 comments'} or {text:'Sign in'}
// on a click mean exactly one Playwright locator, so take them as that rather
// than spend a round trip on an error.
const quote = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
function forgiving(op, args) {
  if (!['click', 'type', 'scroll', 'waitFor'].includes(op) || args.locator || args.selector) return args
  const { role, name, ...rest } = args
  if (role) return { ...rest, locator: `role=${role}${name ? `[name="${quote(name)}"]` : ''}` }
  if (op === 'click' && args.text && args.x === undefined) { const { text, ...r } = args; return { ...r, locator: `text="${quote(text)}"` } }
  return args
}

/** A snapshot as the model reads it: the useful parts first, capped near 20 KB. */
export function snapshotText(snap, { screenshotPath } = {}) {
  const out = [`${snap.title || '(untitled)'} — ${snap.url}${snap.loading ? ' (still loading)' : ''}`, `tabId: ${snap.tabId}`]
  if (screenshotPath) out.push(`screenshotPath: ${screenshotPath}`)
  let budget = 19_000
  const add = (heading, body) => {
    if (!body || budget <= 200) return
    const text = body.length > budget ? `${body.slice(0, budget)}\n… (cut; ${body.length - budget} more characters)` : body
    budget -= text.length
    out.push('', `## ${heading}`, text)
  }
  add('Interactive elements (pass selector as locator)', snap.interactiveElements.map((e) => `- ${e.role || e.tag} "${e.name}" → ${e.selector} @ ${e.x},${e.y}`).join('\n'))
  add('Accessibility outline', String(snap.accessibilityTree || ''))
  add('Visible text', snap.visibleText)
  const errs = snap.consoleEntries.filter((c) => c.level === 'error' || c.level === 'warning')
  if (errs.length) add('Console', errs.map((c) => `${c.level}: ${c.text}`).join('\n'))
  if (snap.networkEntries.length) add('Failed requests', snap.networkEntries.map((n) => `${n.method} ${n.url} → ${n.failed ? n.errorText || 'failed' : n.status}`).join('\n'))
  if (snap.actionTimeline.length) add('Recent actions', snap.actionTimeline.map((a) => `${a.status}: ${a.action}${a.error ? ` (${a.error})` : ''}`).join('\n'))
  return out.join('\n')
}

/**
 * Run one tool for a chat. `ctx.key` names the chat's browser session;
 * `ctx.saveDir` is where `save: true` writes screenshots.
 */
export async function callBrowserTool(manager, name, args = {}, ctx = {}) {
  const tool = BROWSER_TOOL_INDEX.get(name)
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}.` }] }
  const key = ctx.key || 'default'
  args = forgiving(tool.op, args || {})
  try {
    if (tool.op === 'snapshot') {
      const { includeImage = true, save = false, ...rest } = args || {}
      const snap = await manager.snapshot(key, rest)
      let screenshotPath
      if (save) {
        const dir = ctx.saveDir || join(process.cwd(), 'data', 'browser-shots')
        await mkdir(dir, { recursive: true })
        screenshotPath = join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
        await writeFile(screenshotPath, snap.screenshot.data)
      }
      const content = [{ type: 'text', text: snapshotText(snap, { screenshotPath }) }]
      if (includeImage) content.push({ type: 'image', mimeType: 'image/png', data: snap.screenshot.data.toString('base64') })
      return { content, structuredContent: { url: snap.url, title: snap.title, tabId: snap.tabId, ...(screenshotPath ? { screenshotPath } : {}) } }
    }
    const result = await manager[tool.op](key, args || {})
    const text = tool.op === 'evaluate' ? json(result.value ?? null) : json(result)
    return { content: [{ type: 'text', text }], structuredContent: result }
  } catch (e) {
    const message = e instanceof BrowserError ? e.message : `The browser failed: ${e?.message || e}`
    return { isError: true, content: [{ type: 'text', text: message }] }
  }
}
