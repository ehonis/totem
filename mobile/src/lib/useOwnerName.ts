import { useEffect, useState } from 'react'
import { getAppConfig } from './api'

/** The owner's display name from OWNER_NAME on the server, or '' when unset. */
export function useOwnerName(): string {
  const [name, setName] = useState('')
  useEffect(() => {
    let cancelled = false
    getAppConfig().then((c) => { if (!cancelled) setName(c.ownerName || '') }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return name
}
