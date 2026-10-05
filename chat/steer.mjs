// chat/steer.mjs — the owner talking to a chat while it is still answering.
//
// The T3 Code model: a message sent mid-run steers that run rather than waiting
// for it. How it reaches the agent depends on what the CLI can take:
//
//   live     — Claude Code reads stream-json on stdin for the whole run, so the
//              message goes straight into the running turn (`priority: "now"`
//              cuts off the tool in flight). The streamer registers `deliver`.
//   restart  — Codex, Cursor and OpenCode run one turn per process with stdin
//              closed. The run kills the attempt and resumes the same session
//              with the steer as the next message (`interrupt`).
//
// Anything that could not be delivered live (the process was already finishing)
// waits in `pending` and becomes the next attempt once the current one ends, so
// a steer is never dropped because it arrived at an awkward moment.

export function createSteering() {
  let deliver = null // (steer) => boolean, while a streamer can take input mid-turn
  let interrupt = null // () => void, ends the current attempt so it can restart
  let open = true
  const pending = []

  return {
    /** A streamer that accepts input mid-turn. Returns the detach function. */
    attachLive(fn) {
      deliver = fn
      return () => { if (deliver === fn) deliver = null }
    },
    /** The current attempt, for providers that restart instead. */
    attachInterrupt(fn) {
      interrupt = fn
      return () => { if (interrupt === fn) interrupt = null }
    },
    /** Hand a steer to the run. Returns how it went, or null once the run is closing. */
    send(steer) {
      if (!open) return null
      if (deliver && deliver(steer)) return 'live'
      pending.push(steer)
      interrupt?.()
      return 'restart'
    },
    /** Steers still waiting for an attempt, removed from the queue. */
    take() { return pending.splice(0) },
    get waiting() { return pending.length },
    /** No more steers: the run is wrapping up. */
    close() { open = false; deliver = null; interrupt = null },
  }
}

/**
 * What the reply had done before it was cut off, so a resumed session (or a
 * fresh one, if the CLI lost it) carries on rather than starting over.
 */
export function progressNote(msg, { textTail = 1200, tools = 12 } = {}) {
  const parts = msg?.parts || []
  const steps = parts.filter((p) => p.type === 'tool').slice(-tools)
    .map((p) => `- ${p.title}${p.detail ? `: ${String(p.detail).slice(0, 160)}` : ''}${p.status === 'running' ? ' (cut off)' : ''}`)
  const said = String(msg?.content || '').trim()
  const out = []
  if (steps.length) out.push(`Steps you had taken in this reply:\n${steps.join('\n')}`)
  if (said) out.push(`What you had written so far:\n${said.length > textTail ? `…${said.slice(-textTail)}` : said}`)
  return out.join('\n\n')
}

/** The message a restarted attempt sends: the owner's words, with what came before. */
export function steerPrompt(steers, { owner = 'Owner', progress = '' } = {}) {
  const words = steers.map((s) => s.text).join('\n\n')
  return [
    'The owner interrupted your reply to add the message below. Take it into account and carry on with their request from where you were, changing course if they ask you to. Do not start over or repeat work you have already done.',
    progress,
    `${owner}: ${words}`,
  ].filter(Boolean).join('\n\n')
}
