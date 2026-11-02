// The recommendations ledger (recs/service.mjs on the bridge).

export type RecDecision = 'pending' | 'accepted' | 'declined' | 'deferred'
export type RecOutcome = 'worked' | 'partly' | 'failed'

export interface Rec {
  id: string
  title: string
  body: string
  evidence: string
  costUsd: number | null
  /** Who recommended it: `chat:<id>`, `totem:<id>`, or `owner`. */
  source: string
  createdAt: string
  updatedAt: string
  actBy: string | null
  reviewOn: string | null
  decision: RecDecision
  decidedAt: string | null
  decisionNote: string | null
  outcome: RecOutcome | null
  outcomeNote: string | null
  outcomeAt: string | null
  /** Who reported the outcome; an agent's report is labelled and the owner's is final. */
  outcomeBy: 'owner' | 'agent' | null
  /** What an agent said had changed since a similar recommendation was declined. */
  changedNote: string | null
  /** Set when a deferral came due and put it back to pending. */
  resurfacedAt: string | null
}

export interface RecStats {
  total: number
  pending: number
  accepted: number
  declined: number
  deferred: number
  worked: number
  partly: number
  failed: number
  measured: number
  acceptRate: number | null
  hitRate: number | null
  agentReported: number
  acceptedCostUsd: number
  /** The one-line track record, written by the bridge. */
  line: string
}

/** GET /api/recs/ledger: everything open, plus one page of decided history. */
export interface RecLedger {
  open: Rec[]
  history: Rec[]
  /** Pass back as `before` for the next page; null when there is no more. */
  nextBefore: string | null
  stats: RecStats
}
