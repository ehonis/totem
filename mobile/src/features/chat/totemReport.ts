// A totem's report waiting in its chat. Totems' chats are not in the drawer's list, so the
// drawer's Overview row and the Overview's Totems tile wear a dot for it (one test, here).
import { useChat } from '../../lib/chat/store'

export const useTotemReportWaiting = () => useChat((s) => s.threads.some((t) => t.totemId && t.needsReply && !s.runs[t.id]))
