export interface ApprovalLeaseLike {
  approvalSessionId: string
  status: string
  legacy?: boolean
}

export function partitionApprovalLeases<T extends ApprovalLeaseLike>(grants: T[]) {
  const pending: T[] = []
  const active: T[] = []
  const decided: T[] = []

  for (const grant of grants) {
    if (!grant.legacy && grant.status === 'pending') pending.push(grant)
    else if (!grant.legacy && grant.status === 'approved') active.push(grant)
    else decided.push(grant)
  }

  return { pending, active, decided }
}
