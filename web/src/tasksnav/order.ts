// How the chats panel orders the chats in play: Recent (latest first, as T3 Code
// does) or By task (chats on one task gathered under it, the next tasks below).
// Per device, in localStorage; By task unless he picked Recent.
import { useSyncExternalStore } from 'react'

export type ChatsOrder = 'recent' | 'task'

const KEY = 'totem.chats.order'
const read = (): ChatsOrder => { try { return localStorage.getItem(KEY) === 'recent' ? 'recent' : 'task' } catch { return 'task' } }

let order: ChatsOrder = read()
const subs = new Set<() => void>()

export function setChatsOrder(next: ChatsOrder) {
  order = next
  try { localStorage.setItem(KEY, next) } catch { /* private window */ }
  subs.forEach((fn) => fn())
}

export const useChatsOrder = () => useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn) } }, () => order)
