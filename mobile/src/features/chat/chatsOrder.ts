// How the drawer orders the chats in play (web tasksnav/order.ts): Recent (latest
// first) or By task (chats on one task gathered under it, the next tasks below).
// Kept per device under the web's key; By task unless he picked Recent.
import { useSyncExternalStore } from 'react'

export type ChatsOrder = 'recent' | 'task'

const KEY = 'totem.chats.order'
const read = (): ChatsOrder => { try { return localStorage.getItem(KEY) === 'recent' ? 'recent' : 'task' } catch { return 'task' } }

let order: ChatsOrder = read()
const subs = new Set<() => void>()

export function setChatsOrder(next: ChatsOrder) {
  order = next
  try { localStorage.setItem(KEY, next) } catch { /* kept for this session */ }
  subs.forEach((fn) => fn())
}

export const useChatsOrder = () => useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn) } }, () => order, () => order)
