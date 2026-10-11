// Back-compat for the 2026-10-02 Vesper→Totem rename: browsers that already ran
// the app hold these localStorage keys under the old prefix (drafts, the voice,
// panel and terminal preferences, old-tab workflows). Move each one across once,
// before any module reads it — main.tsx imports this first. Can go once every
// device has loaded the app after the rename.
const names = ['.terminal.open', '.terminal.width', '.panel.open', '.chat.drafts', '.todo-draft.new', '.voice.name', '.voice.rate', '.device', '_workflows']
for (const name of names) {
  try {
    const old = localStorage.getItem(`vesper${name}`)
    if (old !== null && localStorage.getItem(`totem${name}`) === null) localStorage.setItem(`totem${name}`, old)
    localStorage.removeItem(`vesper${name}`)
  } catch { /* storage unavailable (private mode): nothing to move */ }
}

export {}
