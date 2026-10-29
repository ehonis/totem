//! Totem's desktop app: one native window around the owner's Totem server.
//!
//! Nothing here reimplements Totem. The window loads the server's own dashboard,
//! and this adds what a browser tab can't: a window that remembers where it was,
//! global hotkeys, a tray icon and start at login. See `desktop/README.md`.

use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

#[cfg(target_os = "macos")]
use tauri::RunEvent;

const MAIN: &str = "main";
const SETUP: &str = "setup";
/// Start-at-login passes this so the app comes up in the tray, not in your face.
const HIDDEN_ARG: &str = "--hidden";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    /// The Totem dashboard's address, e.g. `https://totem.example.com`.
    server: Option<String>,
    shortcuts: Shortcuts,
}

/// Global hotkeys, in Tauri's accelerator syntax. An empty string turns one off.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Shortcuts {
    toggle: String,
    new_chat: String,
    new_todo: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle: "CommandOrControl+Shift+Space".into(),
            new_chat: "CommandOrControl+Alt+N".into(),
            new_todo: "CommandOrControl+Alt+T".into(),
        }
    }
}

#[derive(Clone, Copy)]
enum Hotkey {
    Toggle,
    /// An action id from `web/src/desktop.ts`.
    Run(&'static str),
}

struct AppState {
    config: Mutex<Config>,
    path: PathBuf,
    bindings: Mutex<Vec<(Shortcut, Hotkey)>>,
}

fn load_config(path: &PathBuf) -> Config {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_config(path: &PathBuf, config: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

/// Sends links that would open a new tab, or leave the Totem server, to the
/// system browser. Only on the server's own pages: a sign-in page in between
/// (Cloudflare Access, say) keeps its links in the window, or sign-in breaks.
fn external_links_script(server: &Url) -> String {
    let origin = serde_json::to_string(&server.origin().ascii_serialization()).unwrap();
    format!(
        r#"(() => {{
  if (location.origin !== {origin} || window.__totemExternalLinks) return;
  window.__totemExternalLinks = true;
  const send = (href) => {{ location.href = 'totem-external://open?u=' + encodeURIComponent(href) }};
  const resolve = (href) => {{
    try {{ const u = new URL(href, location.href); return /^https?:$/.test(u.protocol) ? u : null }} catch {{ return null }}
  }};
  document.addEventListener('click', (e) => {{
    if (e.defaultPrevented || e.button > 1) return;
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    const u = a && !a.hasAttribute('download') ? resolve(a.href) : null;
    if (!u) return;
    if (u.origin === location.origin && a.target !== '_blank' && e.button === 0 && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    send(u.href);
  }}, true);
  window.open = (href) => {{ const u = resolve(href ?? ''); if (u) send(u.href); return null }};
}})();"#
    )
}

fn build_main(app: &AppHandle, server: Option<&Url>, visible: bool) -> tauri::Result<WebviewWindow> {
    let url = match server {
        Some(server) => WebviewUrl::External(server.clone()),
        None => WebviewUrl::App("index.html".into()),
    };
    let opener = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, MAIN, url)
        .title("Totem")
        .inner_size(1280.0, 860.0)
        .min_inner_size(420.0, 560.0)
        .zoom_hotkeys_enabled(true)
        .visible(visible)
        .on_navigation(move |url| {
            if url.scheme() != "totem-external" {
                return true;
            }
            if let Some((_, target)) = url.query_pairs().find(|(key, _)| key == "u") {
                let _ = opener.opener().open_url(target.into_owned(), None::<&str>);
            }
            false
        });
    if let Some(server) = server {
        builder = builder.initialization_script(&external_links_script(server));
    }
    builder.build()
}

fn show_main(app: &AppHandle) -> Option<WebviewWindow> {
    let window = app.get_webview_window(MAIN)?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Some(window)
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let showing = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    if showing && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show_main(app);
    }
}

fn run_action(app: &AppHandle, id: &str) {
    if let Some(window) = show_main(app) {
        let id = serde_json::to_string(id).unwrap();
        let _ = window.eval(&format!("window.totemDesktop && window.totemDesktop.run({id})"));
    }
}

fn reload(app: &AppHandle) {
    if let Some(window) = show_main(app) {
        let _ = window.eval("location.reload()");
    }
}

fn open_setup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETUP) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
        .title("Totem server")
        .inner_size(520.0, 460.0)
        .resizable(false)
        .build();
}

/// Registers each configured hotkey; one that's taken or malformed is skipped
/// rather than stopping the app.
fn register_shortcuts(app: &AppHandle, shortcuts: &Shortcuts) -> Vec<(Shortcut, Hotkey)> {
    let wanted = [
        (&shortcuts.toggle, Hotkey::Toggle),
        (&shortcuts.new_chat, Hotkey::Run("chat.new")),
        (&shortcuts.new_todo, Hotkey::Run("todo.new")),
    ];
    let mut bound = Vec::new();
    for (accelerator, hotkey) in wanted {
        if accelerator.trim().is_empty() {
            continue;
        }
        match accelerator.parse::<Shortcut>() {
            Ok(shortcut) => match app.global_shortcut().register(shortcut) {
                Ok(()) => bound.push((shortcut, hotkey)),
                Err(e) => eprintln!("totem: could not register {accelerator}: {e}"),
            },
            Err(e) => eprintln!("totem: bad shortcut {accelerator}: {e}"),
        }
    }
    bound
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let start_at_login = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "Show Totem", true, None::<&str>)?,
            &MenuItem::with_id(app, "chat", "New chat", true, None::<&str>)?,
            &MenuItem::with_id(app, "todo", "New todo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?,
            &MenuItem::with_id(app, "server", "Change server…", true, None::<&str>)?,
            &start_at_login,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Totem", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("totem")
        .tooltip("Totem")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                show_main(app);
            }
            "chat" => run_action(app, "chat.new"),
            "todo" => run_action(app, "todo.new"),
            "reload" => reload(app),
            "server" => open_setup(app),
            "autostart" => {
                let launcher = app.autolaunch();
                let enable = !launcher.is_enabled().unwrap_or(false);
                let _ = if enable { launcher.enable() } else { launcher.disable() };
                let _ = start_at_login.set_checked(launcher.is_enabled().unwrap_or(enable));
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigView {
    server: Option<String>,
    shortcuts: Shortcuts,
    config_path: String,
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> ConfigView {
    let config = state.config.lock().unwrap();
    ConfigView {
        server: config.server.clone(),
        shortcuts: config.shortcuts.clone(),
        config_path: state.path.display().to_string(),
    }
}

/// Saves the server and restarts, so the window and its link handling start
/// cleanly on the new address.
#[tauri::command]
fn set_server(app: AppHandle, state: tauri::State<AppState>, url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "That isn't a full address. Start it with https://".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Use an http:// or https:// address.".into());
    }
    {
        let mut config = state.config.lock().unwrap();
        config.server = Some(parsed.to_string());
        save_config(&state.path, &config)?;
    }
    app.restart()
}

pub fn run() {
    let app = tauri::Builder::default()
        // First, so a second launch focuses this one before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Never restore "hidden": quitting from the tray would mean the next launch shows nothing.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_denylist(&[SETUP])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let hotkey = app
                        .state::<AppState>()
                        .bindings
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|(bound, _)| bound == shortcut)
                        .map(|(_, hotkey)| *hotkey);
                    match hotkey {
                        Some(Hotkey::Toggle) => toggle_main(app),
                        Some(Hotkey::Run(id)) => run_action(app, id),
                        None => {}
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_config, set_server])
        .on_window_event(|window, event| {
            // Closing the main window hides it; the app stays in the tray for the hotkeys.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let path = app.path().app_config_dir()?.join("desktop.json");
            let config = load_config(&path);
            let server = config.server.as_deref().and_then(|s| Url::parse(s).ok());
            let hidden = std::env::args().any(|arg| arg == HIDDEN_ARG) && server.is_some();

            let bindings = register_shortcuts(&handle, &config.shortcuts);
            app.manage(AppState { config: Mutex::new(config), path, bindings: Mutex::new(bindings) });

            build_main(&handle, server.as_ref(), !hidden)?;
            build_tray(&handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Totem");

    app.run(|_app, _event| {
        // Clicking the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = _event {
            show_main(_app);
        }
    });
}
