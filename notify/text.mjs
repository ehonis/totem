// notify/text.mjs — how a notification reads on a lock screen.
//
// iOS gives a notification ONE bold line for the title, truncated around 34
// characters on a phone, then the app name, then the body — which wraps to
// several lines. So the title is a LABEL and the body is the CONTENT.
//
// Getting this backwards is not cosmetic. "A single firm is behind OpenAI,
// An…" with "631 points on Hacker News." underneath puts the interesting half
// behind an ellipsis and the boring half in full, and there is no way to read
// the rest without opening the app.

// Deliberately under the real cut-off. The exact number depends on the device,
// the text size setting and how wide the characters are, and a title that fits
// on a Pro Max and not on a Mini is a title that does not fit.
export const TITLE_MAX = 32

/**
 * A title that stays specific when it can and degrades to its label when it
 * cannot — rather than being truncated by the phone, which always cuts the end
 * and the end is usually the point.
 *
 * The detail belongs in the body either way; this only decides whether it is
 * *also* worth putting in the title.
 */
export function fitTitle(label, detail = '', max = TITLE_MAX) {
  const full = detail ? `${label}: ${detail}` : label
  if (full.length <= max) return full
  return label
}

/**
 * Join the parts of a body, dropping the empty ones.
 *
 * Capitalised, because these are assembled from fragments — "your mom, Marion,
 * turns 65 today." reads like a broken sentence on a lock screen.
 */
export function bodyOf(...parts) {
  const text = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}
