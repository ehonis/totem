# Totem desktop

A small macOS and Windows app that opens your Totem dashboard in its own window.
It doesn't run Totem itself. It connects to the server you already use in a
browser, so you sign in the same way, see the same data, and every dashboard
change shows up the next time the page loads.

What it adds over a browser tab:

- Its own window, with a Dock or taskbar icon and Cmd/Alt-Tab, that remembers its
  size and position.
- Global hotkeys that work from any app. You can change them in the config file
  (see below):

  | Hotkey (Mac / Windows) | Does |
  |---|---|
  | ⌘⇧Space / Ctrl+Shift+Space | Show or hide Totem |
  | ⌘⌥N / Ctrl+Alt+N | New chat |
  | ⌘⌥T / Ctrl+Alt+T | New todo |

- A tray or menu-bar icon with the same actions, plus Reload, Change server… and
  Start at login. Closing the window hides it; quit from the tray (or ⌘Q).
- Links that leave Totem, or that would open a new tab, open in your normal browser.

Totem's own keyboard chords (`g t`, `c c`, …) work in the window as they do in
the browser.

## Install

Download the installer from the **Desktop** workflow's run in GitHub Actions
(artifacts `totem-desktop-macOS` / `totem-desktop-Windows`), or from a release.

The builds aren't code-signed, so each OS warns you once:

- **macOS**: open the `.dmg`, drag Totem to Applications, then right-click it and
  choose **Open** the first time. If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/Totem.app`.
- **Windows**: SmartScreen shows "Windows protected your PC". Click
  **More info → Run anyway**.

On first launch, enter your dashboard's address, the one you use in a browser
(it must be reachable from that computer: a Tailscale or public HTTPS address, not
`localhost` on the server). Voice recording needs an `https://` address.

## Settings

Everything lives in one JSON file. The setup window (tray → Change server…)
shows its path:

- macOS: `~/Library/Application Support/app.totem.desktop/desktop.json`
- Windows: `%APPDATA%\app.totem.desktop\desktop.json`

```json
{
  "server": "https://totem.example.com/",
  "shortcuts": {
    "toggle": "CommandOrControl+Shift+Space",
    "newChat": "CommandOrControl+Alt+N",
    "newTodo": "CommandOrControl+Alt+T"
  }
}
```

Shortcuts use [Tauri's accelerator syntax](https://v2.tauri.app/plugin/global-shortcut/).
An empty string turns one off. A hotkey another app already holds is skipped.
Restart the app after editing.

## Limits

- No push notifications. Web Push doesn't work inside a desktop webview; use
  the phone app or an installed browser web app for those.
- On macOS the window is WebKit (Safari's engine) and on Windows it's WebView2
  (Edge's), the same engines Totem already supports.

## Building

It's a [Tauri 2](https://v2.tauri.app) app: `src-tauri/` is the Rust shell and
`setup/` is the one bundled page (first run and Change server…). It has its own
`package.json`; the bridge's install and build never touch it.

Building needs Rust and the platform's toolchain (Xcode command line tools on a Mac,
MSVC build tools on Windows):

```sh
cd desktop
npm install
npm run dev      # run it locally
npm run build    # installers in src-tauri/target/release/bundle/
```

CI builds both platforms in `.github/workflows/desktop.yml` on any PR that touches
`desktop/`, by hand from the Actions tab, and on a `desktop-v*` tag (which also
makes a draft release). `npm run icons` regenerates `src-tauri/icons/` from
`web/assets-src/totem-logo.svg`. Delete the `android/`, `ios/` and `Square*`
outputs it also writes.

The dashboard side is `web/src/desktop.ts`: the hotkeys call
`window.totemDesktop.run('chat.new' | 'todo.new')`. A new hotkey action goes
there and in `register_shortcuts` in `src-tauri/src/lib.rs`.
