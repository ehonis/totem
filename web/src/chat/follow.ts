/**
 * Whether the chat follows its bottom (ChatView's scrolling). It follows while
 * the owner is at the bottom and stops the moment he scrolls up to read.
 *
 * A search hit landing on an older message (landing.ts) holds following off
 * until it has landed: opening the chat jumps to the bottom first, and that
 * jump's scroll event arrives a frame later. Read as "he is at the bottom", it
 * pinned the chat again, and every image or code block that grew the log then
 * snapped it back down, away from the message (#266 review).
 */
export const AT_BOTTOM_PX = 80

export interface Follow {
  /** Stick to the bottom as the log grows (new tokens, images loading). */
  readonly following: boolean
  /**
   * Opening (or showing again) a chat starts at its bottom, and ends any landing:
   * one cut short when the chat was hidden never called endLanding, and a landing
   * still pending starts again straight after (#266 review, round 2).
   */
  open(): void
  /**
   * A scroll event, as the distance from the bottom. Returns whether the jump
   * arrow should hide (at the bottom), or null while a landing ignores it.
   */
  scrolled(fromBottom: number): boolean | null
  /** A search hit is landing: stop following, and ignore scroll events until it ends. */
  startLanding(): void
  /**
   * It landed, `fromBottom` pixels from the bottom: follow again only if that is at
   * the bottom (a message too near it to scroll to). Never found: back to following.
   * Returns whether it is following.
   */
  endLanding(found: boolean, fromBottom?: number): boolean
}

export function createFollow(): Follow {
  let pinned = true
  let landing = false
  return {
    get following() { return pinned && !landing },
    open() { pinned = true; landing = false },
    scrolled(fromBottom) {
      if (landing) return null
      pinned = fromBottom < AT_BOTTOM_PX
      return pinned
    },
    startLanding() { landing = true; pinned = false },
    endLanding(found, fromBottom = Infinity) {
      landing = false
      pinned = !found || fromBottom < AT_BOTTOM_PX
      return pinned
    },
  }
}
