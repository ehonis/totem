// chat/reach.mjs — what an agent run can reach beyond its own tools: the agent
// browser, computer use, and how long it may take.
//
// A chat from the dashboard or the app gets all of it, always: the browser when
// one is installed, computer use when its account can drive the desktop, and the
// long budget. The agent decides per request whether it needs them, and asks the
// owner first when it can't tell (REACH_RULES). Nothing else gets this: a voice
// turn has a person listening, the phone shortcut (`http`) answers in plain text
// with nobody watching, and scheduled jobs and totems run unattended. A totem
// keeps its own explicit `browser` switch; that is its builder's choice, not
// this default.

import { HANDOFF_RULE } from '../browser/handoff.mjs'

/**
 * What a chat run is handed. `body` is the request, read only for the toggles
 * older clients still send (`mode: 'task' | 'computer'`, `browser: true`): they
 * no longer gate anything, but a toggle the owner turned on for this message is
 * his answer to "should I use it?", so it becomes a hint in the prompt.
 */
export function chatReach({ channel = 'web', voice = false, driver = '', computerUseAvailable = false, browserReady = false, body = {} } = {}) {
  if (channel !== 'web' || voice) return { browser: false, computerUse: false, longBudget: false, asked: { browser: false, computer: false } }
  const browser = browserReady === true
  const computerUse = driver === 'codex' && computerUseAvailable === true
  return {
    browser,
    computerUse,
    longBudget: true,
    asked: {
      browser: browser && body?.browser === true,
      computer: computerUse && body?.mode === 'computer',
    },
  }
}

/**
 * runAgent's guard, whatever a caller passes. runAgent serves the phone shortcut,
 * jobs, totems and the inbox, never a dashboard chat, so it never runs computer
 * use; the phone shortcut never gets the browser either. A totem keeps the
 * browser its own switch granted.
 */
export function limitReach(channel, options = {}) {
  const { features: _f, browser, ...rest } = options
  return channel === 'http' || !browser ? rest : { ...rest, browser }
}

export const WORK_RULES =
  'GETTING THINGS DONE: When the owner asks you to do something, treat it as a job to carry out end to end with your ' +
  'tools (shell, files, the Totem app tools, connected services), not a question about how it could be done. Stop to ask ' +
  'only when you are genuinely blocked or unsure what he wants. When you did real work, finish with a short summary: what ' +
  'you did, what changed, and anything only he can do.'

/** The browser's how-to. Also the /agent-mcp server's `instructions`. */
export function browserRules(mcpName, { handoff = false } = {}) {
  return `BROWSER: Your preview_* tools (the ${mcpName} MCP server, or browser__preview_* through totem-gateway) are a real Chromium on the owner's machine that he watches live in the chat. When a request needs a browser, use these rather than any other browser or a headless script: open with preview_open (or preview_navigate), call preview_snapshot to see the page (you get the screenshot and the elements with locators), act with preview_click / preview_type / preview_press using the snapshot's role locators rather than coordinates, then snapshot again to check. It suits pages that need JavaScript, checking how a site or a dev server looks (target {kind:'environment-port',port}), and anything he wants to see. The tab stays open across messages in this chat. To show the owner what you saw, call preview_snapshot with save:true and put ![short description](screenshotPath) in your reply; only do that when the picture helps. ${handoff ? HANDOFF_RULE : 'When a page needs the owner to sign in, ask him to do it himself and stop there.'} Never enter passwords, pay, buy, send messages, or submit anything irreversible on his behalf without asking first.`
}

export const COMPUTER_RULES =
  'COMPUTER USE: Your computer-use tools (screenshots, clicks, typing) operate this computer\'s desktop, including ' +
  'real apps and his signed-in browser. Never type a password, a payment card or a one-time code: if a page needs a ' +
  'sign-in, stop and ask him to sign in himself, then carry on. Confirm with him before anything that cannot be undone ' +
  '(sending, buying, posting, deleting). Between steps, say in a few words what you are doing.'

/** When to reach for the browser or the desktop at all. Only for what the run actually has. */
export function reachRules({ browser = false, computerUse = false, asked = {} } = {}) {
  if (!browser && !computerUse) return ''
  const what = browser && computerUse ? 'a browser and this computer\'s desktop' : browser ? 'a browser' : 'this computer\'s desktop'
  const tools = [browser && 'the browser', computerUse && 'the desktop'].filter(Boolean).join(' or ')
  const lines = [
    `REACH: You can drive ${what} in this chat. They are there for when a request needs them, not by default. ` +
    'Prefer an API, a Totem app tool, a connected service, or a plain web search or fetch first. ' +
    (browser ? 'Use the browser only when the page needs a real browser (it runs JavaScript, he wants to see it, or it is a visual check). ' : '') +
    (computerUse ? 'Use the desktop only when the work needs a real app on this computer or his signed-in session. ' : '') +
    `If you are not sure he wants you to drive ${tools} for this, ask him first in one short question and stop there, rather than doing it.`,
  ]
  if (asked.browser) lines.push('He turned the browser on for this message: use it where it helps, without asking first.')
  if (asked.computer) lines.push('He turned computer use on for this message: use the desktop where it helps, without asking first.')
  return lines.join(' ')
}
