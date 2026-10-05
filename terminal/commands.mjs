/**
 * Command detection for the web terminal.
 *
 * A PTY carries keystrokes, not commands. To make "commands run" a real metric on
 * the Totem activity card we have to reconstruct the line the user submitted from
 * the raw input stream, and — just as importantly — decide when *not* to count.
 *
 * This module is pure: it takes the bytes flowing each way and emits command
 * events. No PTY, no logging, no I/O, so `terminal/commands.test.mjs` can pin the
 * awkward cases (backspace, ctrl-c, vim, password prompts) without spawning a shell.
 *
 * What it deliberately gets wrong, and why that is the right trade:
 *
 *   - It mirrors only *basic* line editing (printable chars, backspace, ctrl-u/w,
 *     ctrl-c). It does not emulate readline. Recall a command with the up arrow and
 *     the reconstructed text is wrong, so the line is marked unreliable: we still
 *     count the command (a command really did run) but log no label rather than a
 *     misleading one. Counting is the metric; the label is a convenience.
 *   - Full-screen programs (vim, less, htop, an agent TUI) turn every Enter into a
 *     "command" unless suppressed. They announce themselves by switching to the
 *     alternate screen buffer, so tracking `\e[?1049h` / `\e[?1049l` in the OUTPUT
 *     stream gates the whole detector off for their lifetime. That single trick
 *     removes nearly all of the false positives.
 *
 * Passwords are the one case where being wrong is expensive. `sudo` reads with echo
 * off, but the keystrokes still reach us — so the password would land in the label
 * of a "command". We watch the tail of the output for a password-ish prompt and mark
 * the next submitted line sensitive: counted, never labeled. See SENSITIVE_PROMPT_RE.
 */

// Alternate screen buffer on/off. Both the private-mode form (1049, and the older
// 47/1047) matter; ncurses picks whichever the terminfo entry offers.
const ALT_SCREEN_ON_RE = /\x1b\[\?(?:1049|1047|47)h/
const ALT_SCREEN_OFF_RE = /\x1b\[\?(?:1049|1047|47)l/

// A prompt that is about to read a secret with echo disabled. Rather than trying to
// enumerate phrasings — "[sudo] password for ethan:", "Enter passphrase for key
// '/home/user/.ssh/id_ed25519':", "GitHub token?" — the test is structural: the
// last line of output ends in a colon or question mark (so it is a prompt awaiting
// input, not prose) and mentions a secret. Prose like "your password expires in 3
// days" fails the first half; a normal shell prompt ending in $ or # fails it too.
const SENSITIVE_WORD_RE = /\b(?:password|passwd|passphrase|secret|token|pin|passcode)\b/i
const PROMPT_TAIL_RE = /[:?]$/

// How much trailing output to keep for the prompt check. A prompt line is short;
// this is generous enough to survive a wrapped one without holding a screen.
const OUTPUT_TAIL_BYTES = 256

// Longest line we will reconstruct. A pasted payload past this is still counted,
// just not labeled — an 80-char label is all `recordActivity` keeps anyway.
const MAX_LINE_CHARS = 4096

/** Strip ANSI escape sequences so the prompt check sees the text, not the styling. */
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (title sets, shell integration)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')           // CSI (colors, cursor moves)
    .replace(/\x1b[@-Z\\-_]/g, '')                      // remaining two-char escapes
}

/**
 * A command the user submitted.
 *
 * @typedef  {object} DetectedCommand
 * @property {string}  text      Reconstructed command line; '' when not trustworthy.
 * @property {boolean} labeled   Whether `text` is safe and reliable enough to record.
 * @property {string}  [reason]  Why the label was withheld, for debugging.
 */

/**
 * Create a per-session detector.
 *
 * Feed it every chunk in both directions; it returns the commands it recognized.
 * One instance per terminal session — it holds that session's line-edit state.
 */
export function createCommandDetector() {
  let line = ''
  // The reconstruction stopped matching what the shell has. Set by cursor movement,
  // history recall, tab completion — anything readline handles that we do not model.
  let unreliable = false
  // The next submitted line is a secret the user typed at an echo-off prompt.
  let sensitive = false
  // Depth rather than a boolean: nesting (vim shelling out to less) should not let
  // an inner exit re-enable counting for the outer program.
  let altScreenDepth = 0
  let outputTail = ''

  /**
   * Feed a chunk of PTY output (shell → browser).
   *
   * Tracks alternate-screen transitions and watches for password prompts. Returns
   * nothing: output never produces a command, it only changes how input is read.
   */
  function pushOutput(chunk) {
    if (!chunk) return
    // Scan for every transition in order, so a chunk containing both an enter and a
    // leave (a quick `git log` that pages and exits) nets out correctly.
    const transitions = chunk.match(/\x1b\[\?(?:1049|1047|47)[hl]/g)
    if (transitions) {
      for (const seq of transitions) {
        if (ALT_SCREEN_ON_RE.test(seq)) altScreenDepth++
        else if (ALT_SCREEN_OFF_RE.test(seq)) altScreenDepth = Math.max(0, altScreenDepth - 1)
      }
      // Crossing a full-screen boundary invalidates the half-typed line either way:
      // on the way in it belongs to the shell we just left, and on the way out it is
      // leftover keystrokes from vim. Without this reset, pressing Escape inside vim
      // would poison the label of the next real shell command.
      line = ''
      unreliable = false
      sensitive = false
    }

    outputTail = (outputTail + chunk).slice(-OUTPUT_TAIL_BYTES)
    // Only meaningful outside a full-screen program; inside one the "tail" is
    // wherever the cursor happens to have been parked.
    //
    // Latching matters: this only ever ARMS the flag, and pushInput disarms it when
    // the line is submitted or abandoned. Recomputing it per chunk looked right but
    // leaked — `read -p "Enter token: "` echoes what you type, so the tail stopped
    // ending in a colon after the first keystroke and the secret got labeled. (Only
    // echo-off prompts like sudo survived that version, which is exactly the sort of
    // "works in the case I tested" bug worth failing closed on.)
    if (altScreenDepth === 0 && !sensitive) {
      const lastLine = stripAnsi(outputTail).trimEnd().split(/[\r\n]/).pop() || ''
      if (PROMPT_TAIL_RE.test(lastLine) && SENSITIVE_WORD_RE.test(lastLine)) sensitive = true
    }
  }

  /**
   * Feed a chunk of PTY input (browser → shell).
   *
   * @returns {DetectedCommand[]} commands submitted within this chunk, in order.
   */
  function pushInput(chunk) {
    if (!chunk) return []
    const commands = []

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]

      // Escape sequence: arrow keys, Home/End, bracketed paste, function keys. We
      // cannot replay what readline does with these, so the line is now a guess.
      if (ch === '\x1b') {
        unreliable = true
        // Skip the rest of the sequence so its letters do not land in the line.
        // CSI/SS3 run until a byte in @-~; anything else is a two-character escape.
        if (chunk[i + 1] === '[' || chunk[i + 1] === 'O') {
          i++
          while (i + 1 < chunk.length && !/[@-~]/.test(chunk[i + 1])) i++
          i++
        } else if (i + 1 < chunk.length) {
          i++
        }
        continue
      }

      // Enter — submit. Both CR (what a terminal actually sends) and LF.
      if (ch === '\r' || ch === '\n') {
        const text = line.trim()
        line = ''
        const wasUnreliable = unreliable
        const wasSensitive = sensitive
        unreliable = false
        sensitive = false

        // Inside vim/less every Enter is a keystroke, not a command.
        if (altScreenDepth > 0) continue
        // A bare Enter at the prompt just redraws it.
        if (!text && !wasUnreliable && !wasSensitive) continue

        if (wasSensitive) commands.push({ text: '', labeled: false, reason: 'sensitive-prompt' })
        else if (wasUnreliable) commands.push({ text: '', labeled: false, reason: 'line-editing' })
        else commands.push({ text, labeled: true })
        continue
      }

      // Ctrl-C / Ctrl-D / Ctrl-G — abandon the line without running it.
      if (ch === '\x03' || ch === '\x04' || ch === '\x07') {
        line = ''
        unreliable = false
        sensitive = false
        continue
      }

      // Ctrl-U (kill line) and Ctrl-W (kill word) we can model exactly.
      if (ch === '\x15') { line = ''; continue }
      if (ch === '\x17') { line = line.replace(/\S*\s*$/, ''); continue }

      // Backspace / DEL.
      if (ch === '\x7f' || ch === '\b') { line = line.slice(0, -1); continue }

      // Tab completion rewrites the line from the shell's side.
      if (ch === '\t') { unreliable = true; continue }

      // Any other control character is something we do not model.
      if (ch < ' ') { unreliable = true; continue }

      if (line.length >= MAX_LINE_CHARS) { unreliable = true; continue }
      line += ch
    }

    return commands
  }

  return {
    pushInput,
    pushOutput,
    /** Exposed for tests and diagnostics; not part of the counting path. */
    state: () => ({ line, unreliable, sensitive, altScreenDepth }),
  }
}
