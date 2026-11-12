// Copy text, also where the Clipboard API is missing: it only exists in a secure
// context, and Totem is often opened over plain http on a tailnet address.
// Resolves to whether the copy happened, so a caller can say so either way.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the old way */ }
  // select() moves focus to the textarea; give it back, or a keyboard user in a
  // dialog loses their place (and the dialog's Tab trap with it).
  const before = document.activeElement as HTMLElement | null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  area.setSelectionRange(0, text.length) // iOS Safari ignores select() alone
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    before?.focus?.({ preventScroll: true })
  }
}
