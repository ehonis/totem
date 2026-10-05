// First, so pre-rename localStorage keys are moved before any module reads them.
import './legacyStorage'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
// Display face, used only by the wordmark in the sidebar.
import '@fontsource-variable/unbounded'
import App from './App'
import { registerServiceWorker, reportNotificationOpen } from './push'
import './tailwind.css'
import './styles.css'
import './shell.css'

// Registered on every load, not only when push is switched on: iOS keeps the
// service worker alive with the installed web app, and a registration that only
// happens behind a settings toggle is one that is missing after a reinstall.
if ('serviceWorker' in navigator) {
  void registerServiceWorker().catch(() => {
    // A failed registration must not take the dashboard down with it.
  })
}

// A notification tap lands on /whatever?n=<entryId>. Reporting that back is the
// strongest feedback signal there is and costs the user nothing.
reportNotificationOpen()

createRoot(document.getElementById('root')!).render(<App />)
