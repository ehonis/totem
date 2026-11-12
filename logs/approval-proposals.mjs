// One inbox proposal as the approval checks see it, computed from the exact
// value its accept will use.
//
// bridge.mjs reads a proposal's staged file once, through the same readers the
// accept uses (loadInboxProposal), and hands that value here and to the accept
// itself, so what is screened, shown, fingerprinted and sent are one reading. The
// file is never read a second time between the owner seeing it and it going out.
//
//   shape.parts        every string shown on the card or transmitted: screened
//                      for hidden characters (logs/approval-hardening.mjs)
//   shape.fingerprint  kind, destination and payload, whitespace folded: what
//                      makes two proposals "the same" for a denial's hold
//   digest             everything the accept will use, exactly: the dashboard
//                      sends back the one it displayed, and a proposal that
//                      changed since is refused rather than approved unseen

import { createHash } from 'node:crypto'
import { proposalFingerprint } from './approval-hardening.mjs'

// The provenance line buildInboxIssue appends names the inbox id, so it is not
// part of what makes two issues the same.
const stagedIssueBody = (body) => {
  const text = String(body || '')
  const cut = text.lastIndexOf('\n\n---\n_Staged by Totem as inbox ')
  return cut === -1 ? text : text.slice(0, cut)
}

const people = (list) => (Array.isArray(list) ? list : [])

/**
 * @param {{ kind: string, title: string, when?: string|null, meta: Record<string,string> }} item
 *   A parsed inbox line (parseInboxLine), never the display copy readInboxItems builds.
 * @param {any} value  What the accept will use: the email, the message text, the
 *   prompt, the command, the issue; null for kinds with nothing staged.
 */
export function proposalShape(item, value) {
  const meta = item?.meta || {}
  const kind = String(item?.kind || '').toLowerCase()
  let destination = [meta.project || meta.area || '', meta.sync || '']
  let payload = [item?.title, item?.when || '', meta.goal || '', meta.metric || '', meta.delta ?? '', meta.value ?? '']
  let shown = []
  if (kind === 'email' && value) {
    const all = [...people(value.to), ...people(value.cc), ...people(value.bcc)]
    destination = [value.account || meta.account || '', all.map((x) => String(x?.email || '').toLowerCase()).sort().join(',')]
    payload = [value.subject, value.body]
    // Names go out in the headers and are shown on the card; so is the message it answers.
    shown = [value.from, all.map((x) => [x?.name, x?.email]), value.inReplyToMessage ? Object.values(value.inReplyToMessage) : []]
  } else if (kind === 'imessage') {
    destination = [meta.to || '']
    payload = [value ?? '']
  } else if (kind === 'prompt') {
    destination = []
    payload = [value?.promptText ?? '']
    shown = [value?.provider, value?.model, value?.effort]
  } else if (kind === 'command') {
    destination = [meta.cwd || '']
    payload = [value ?? '']
  } else if (kind === 'linkedin' && value) {
    // Nothing is sent: the owner copies the draft and acts himself. The draft is
    // still what he pastes, so it is screened with everything shown on the card.
    destination = [value.targetUrl]
    payload = [value.action, value.draftText]
    shown = [value.authorName, value.postExcerpt, value.reason]
  } else if (value && typeof value === 'object' && 'repo' in value) {
    destination = [value.repo]
    payload = [value.title, stagedIssueBody(value.body)]
    shown = [value.labels]
  }
  return {
    destination,
    payload,
    parts: [item?.title, Object.values(meta), destination, payload, shown],
    fingerprint: proposalFingerprint({ kind, destination, payload }),
  }
}

/** sha256 of everything the accept will use: the line's fields and the staged value, exactly. */
export function proposalDigest(item, value) {
  const meta = item?.meta || {}
  const sortedMeta = Object.fromEntries(Object.keys(meta).sort().map((k) => [k, meta[k]]))
  return createHash('sha256')
    .update(JSON.stringify({ id: item?.id, kind: item?.kind, title: item?.title, when: item?.when ?? null, meta: sortedMeta, value: value ?? null }))
    .digest('hex')
}

/** The sentence a held proposal's accept is refused with. */
export function heldMessage(held) {
  return `Held: you denied the same proposal as ${held.id} on ${String(held.deniedAt).slice(0, 10)}. Choose "Show anyway" in the Inbox to decide it again.`
}
