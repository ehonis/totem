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
- No title bar: Totem runs to the window's top edge. On Windows its minimize,
  maximize and close buttons sit in the top-right corner of the page, and on
  macOS the traffic lights sit over the top of the sidebar. Drag the window by
  the top of any page, the sidebar or the chats panel; double-click there to
  maximize. A page that isn't Totem's own (a sign-in page in between, or a Totem
  server too old to draw the buttons) gets the normal title bar back.
- Links that leave Totem, or that would open a new tab, open in your normal browser.
- Drop photos and files from Finder or File Explorer anywhere on the chat to
  attach them to your next message.

Totem's own keyboard chords (`g t`, `c c`, …) work in the window as they do in
the browser.

## Install

Download the installer from the latest **Totem desktop** release on GitHub:
`Totem_<version>_x64-setup.exe` for Windows, `Totem_<version>_universal.dmg` for
macOS. After that it updates itself (see Updates).

The builds aren't code-signed, so each OS warns you once:

- **macOS**: open the `.dmg`, drag Totem to Applications, then right-click it and
  choose **Open** the first time. If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/Totem.app`.
- **Windows**: SmartScreen shows "Windows protected your PC". Click
  **More info → Run anyway**.

On first launch, enter your dashboard's address, the one you use in a browser
(it must be reachable from that computer: a Tailscale or public HTTPS address, not
`localhost` on the server). Voice recording needs an `https://` address.

## Updates

The app checks for a new version 20 seconds after it starts and every six hours
after that, and downloads it in the background. Then a **Restart to update**
button appears at the foot of the sidebar, a toast offers **Restart**, and the
tray's **Check for updates** item turns into **Restart to update to …**. On
Windows the installer runs with a progress bar and no questions, then reopens
Totem; on macOS the app is replaced and relaunched. Nothing installs until you
click.

Every update is signed, and the app installs only what verifies against the key
in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). It looks for
`latest.json` on the newest release of the public repository.

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

Add `"nativeTitleBar": true` to keep the system's title bar instead.

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
`desktop/`, on every merge to main that does, and by hand from the Actions tab.
Each build is version `0.2.<run number>`. With the updater's private key in the
repository's secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
it also writes the signed update files (`*-setup.exe.sig`, `*.app.tar.gz` and its
`.sig`); without the key it builds installers only. A main build is published as
a release, with its `latest.json`, by the owner's release tooling once the code it
was built from is public. Running your own copy? Make a key with
`npx tauri signer generate`, put the public half in `tauri.conf.json` and the
endpoint at your own releases. `npm run icons` regenerates `src-tauri/icons/` from
`web/assets-src/totem-logo.svg`. Delete the `android/`, `ios/` and `Square*`
outputs it also writes.

The dashboard side is `web/src/desktop.ts`: the hotkeys call
`window.totemDesktop.run('chat.new' | 'todo.new')`. A new hotkey action goes
there and in `register_shortcuts` in `src-tauri/src/lib.rs`.

The main webview disables Tauri's native file-drop handler so the dashboard's
HTML5 drag-and-drop upload flow receives files. Changes to that window setting
need a new desktop build; reloading the dashboard alone does not apply them.

File downloads use the webview's streaming download handler and its default
Downloads destination, including filename collision handling. The dashboard shows
an indeterminate transfer until Tauri reports success or failure. Tauri exposes
no byte progress here. Once a file is saved, the panel offers **Show in folder**
(**Show in Finder** on a Mac), which opens the file manager with the file
selected, or its folder if the file has since moved. The app keeps the saved
path itself (macOS reports none when a download finishes, so it keeps the
destination it chose when the download started); the page asks for it by the
download's URL through a cancelled `totem-desktop://reveal?u=` navigation, so it
never sees a path and can only reveal what this window downloaded. This handler
needs a new desktop build. An older wrapper can show browser handoff feedback after a
dashboard reload, but cannot confirm saving (and older macOS wrappers cancel
native downloads).
