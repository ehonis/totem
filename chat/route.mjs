// chat/route.mjs — which model a chat turn runs on.
//
// The owner picks the account and model in the composer's model picker; there
// is no automatic routing. (Auto, Instant and Thinking were retired on
// 2026-10-07: guessing the model from the message never made sense.)

/**
 * The hand-picked model (and effort) a manual turn should run, given the
 * account it was picked on (`requested`) and the account the turn actually
 * lands on (`provider`). A temporary chat is held to the default account, so a
 * model picked on another account would mean nothing there: drop it and let
 * that account's default answer. A request that names no account keeps its
 * model, as it always has.
 */
export function manualModelFor({ requested, provider, model, effort }) {
  const sameAccount = !requested || requested === provider
  return sameAccount ? { model: model ?? null, effort: effort ?? null } : { model: null, effort: null }
}
