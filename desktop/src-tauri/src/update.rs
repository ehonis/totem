//! Updates, the way T3 Code does them: check in the background, download the
//! new version quietly, then offer "Restart to update" in the page (a button on
//! the rail, see `web/src/components/DesktopUpdate.tsx`) and in the tray.
//!
//! Releases are signed with the key in `tauri.conf.json` (`plugins.updater`)
//! and published by `.github/workflows/desktop.yml`; an update that doesn't
//! verify is never installed. The page learns the state from
//! `window.__TOTEM_DESKTOP__.update` and asks to install by navigating to
//! `totem-desktop://update/install`, which `lib.rs` cancels and hands here. So
//! a remote page gets no IPC for this, as with external links.

use std::{sync::Mutex, time::Duration};

use serde::Serialize;
use tauri::{menu::MenuItem, AppHandle, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

/// First check this long after launch, so it never competes with the page loading.
const FIRST_CHECK: Duration = Duration::from_secs(20);
/// Then this often, for a window that stays open for days.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Idle,
    Checking,
    UpToDate,
    #[serde(rename_all = "camelCase")]
    Downloading { version: String, percent: Option<u8> },
    #[serde(rename_all = "camelCase")]
    Ready { version: String },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

pub struct Updates {
    status: Mutex<Status>,
    downloaded: Mutex<Option<(Update, Vec<u8>)>>,
    tray_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for Updates {
    fn default() -> Self {
        Self { status: Mutex::new(Status::Idle), downloaded: Mutex::new(None), tray_item: Mutex::new(None) }
    }
}

/// The tray's update item, so its label can follow the status.
pub fn set_tray_item(app: &AppHandle, item: MenuItem<Wry>) {
    *app.state::<Updates>().tray_item.lock().unwrap() = Some(item);
    publish(app);
}

/// Checks soon after launch and then every few hours, for as long as the app runs.
pub fn spawn_checks(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Checks now, from the tray or the page. Does nothing while one is under way or
/// an update is already waiting.
pub fn check_now(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check(&app).await });
}

async fn check(app: &AppHandle) {
    {
        let updates = app.state::<Updates>();
        let mut status = updates.status.lock().unwrap();
        if matches!(*status, Status::Checking | Status::Downloading { .. } | Status::Ready { .. }) {
            return;
        }
        *status = Status::Checking;
    }
    publish(app);
    let next = match find_and_download(app).await {
        Ok(Some(version)) => Status::Ready { version },
        Ok(None) => Status::UpToDate,
        Err(message) => {
            eprintln!("totem: update check failed: {message}");
            Status::Failed { message }
        }
    };
    set_status(app, next);
}

async fn find_and_download(app: &AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
    let version = update.version.clone();
    set_status(app, Status::Downloading { version: version.clone(), percent: Some(0) });

    let mut received: u64 = 0;
    let mut last_percent = 0u8;
    let progress_app = app.clone();
    let progress_version = version.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                let Some(total) = total.filter(|t| *t > 0) else { return };
                let percent = ((received * 100) / total).min(100) as u8;
                // Every 5%, not every chunk: each step re-renders the page's button.
                if percent >= last_percent + 5 {
                    last_percent = percent;
                    set_status(&progress_app, Status::Downloading { version: progress_version.clone(), percent: Some(percent) });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    *app.state::<Updates>().downloaded.lock().unwrap() = Some((update, bytes));
    Ok(Some(version))
}

/// Installs the downloaded update and restarts into it. On Windows the
/// installer runs (with a progress bar, no questions), quits the app and starts
/// the new one; on macOS the app is replaced in place and relaunched.
pub fn install(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || install_now(&app));
}

fn install_now(app: &AppHandle) {
    let Some((update, bytes)) = app.state::<Updates>().downloaded.lock().unwrap().take() else {
        check_now(app);
        return;
    };
    match update.install(&bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            eprintln!("totem: update install failed: {e}");
            set_status(app, Status::Failed { message: e.to_string() });
        }
    }
}

fn set_status(app: &AppHandle, status: Status) {
    {
        let updates = app.state::<Updates>();
        let mut current = updates.status.lock().unwrap();
        if *current == status {
            return;
        }
        *current = status;
    }
    publish(app);
}

/// The script that hands the current status to a page, run on every status
/// change and on every page load (`lib.rs`).
pub fn status_script(app: &AppHandle) -> String {
    let status = app.state::<Updates>().status.lock().unwrap().clone();
    let json = serde_json::to_string(&status).unwrap();
    format!(
        "(() => {{ const d = window.__TOTEM_DESKTOP__; if (!d) return; d.update = {json}; window.dispatchEvent(new Event('totem-desktop-update')) }})()"
    )
}

fn publish(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::MAIN) {
        let _ = window.eval(&status_script(app));
    }
    let label = match &*app.state::<Updates>().status.lock().unwrap() {
        Status::Checking => "Checking for updates…".to_string(),
        Status::Downloading { version, .. } => format!("Downloading {version}…"),
        Status::Ready { version } => format!("Restart to update to {version}"),
        Status::UpToDate => "Up to date · Check again".to_string(),
        Status::Idle | Status::Failed { .. } => "Check for updates".to_string(),
    };
    if let Some(item) = app.state::<Updates>().tray_item.lock().unwrap().as_ref() {
        let _ = item.set_text(label);
    }
}

/// The tray item was clicked: restart into a waiting update, otherwise check.
pub fn tray_clicked(app: &AppHandle) {
    let ready = matches!(*app.state::<Updates>().status.lock().unwrap(), Status::Ready { .. });
    if ready {
        install(app);
    } else {
        check_now(app);
    }
}
