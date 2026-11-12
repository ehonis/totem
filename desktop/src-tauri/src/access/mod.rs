//! Signing in through Cloudflare Access in the owner's own browser.
//!
//! When the Totem server is behind Access, loading it sends the window to
//! Access's login page. Signing in there, inside the app, is the wrong place:
//! no saved passwords, passkeys or existing Google session, and Google refuses
//! embedded browsers outright. So the window never follows that hop. The hop is
//! cancelled (`intercept`, called from `on_navigation` in `lib.rs`), the window
//! shows the bundled `signin.html`, and Access's command-line sign-in opens in
//! the default browser (`transfer.rs`). Once the owner signs in there, the app
//! collects the app token, sets it in the window as the `CF_Authorization`
//! cookie Access reads, and goes back to the page it was loading.
//!
//! The page asks for things the same way the update button does, by navigating
//! to `totem-desktop://signin/<action>`, which `lib.rs` cancels and hands to
//! `action`. No IPC is granted for it.
//!
//! Both entry points are called inside the webview's navigation callback, on
//! the main thread, where Tauri runs a window call at once rather than queueing
//! it (and WebView2 must not be navigated from inside `NavigationStarting`). So
//! they only decide, and do the rest on a blocking-pool thread. The one lock is
//! never held across a window or browser call.

mod transfer;

use std::{
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{
    webview::cookie::{time::OffsetDateTime, Cookie, SameSite},
    AppHandle, Manager, Url, WebviewWindow,
};
use tauri_plugin_opener::OpenerExt;

use transfer::{LoginRedirect, Transfer};

/// How long the app waits for the owner to finish signing in in the browser.
const WAIT: Duration = Duration::from_secs(10 * 60);
/// A login hop this soon after a sign-in was handed to the window means Access
/// refused it there; asking again would open the browser in a loop.
const REFUSED_WITHIN: Duration = Duration::from_secs(30);
/// "Sign in in this window instead" lets Access's page load in the window for this long.
const INSIDE_FOR: Duration = Duration::from_secs(10 * 60);
const SIGNIN_PAGE: &str = "signin.html";

#[derive(Clone, Serialize, PartialEq, Debug, Default)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    /// Not signing in.
    #[default]
    Idle,
    /// Access wants a sign-in, but the window was hidden (start at login), so
    /// the browser waits for the owner to ask.
    Needed,
    /// The browser is open on Access's page; waiting for the token.
    Waiting,
    /// Signed in; loading Totem.
    Done,
    Failed { message: String },
}

struct Attempt {
    /// Bumped for every try, so a poll loop left from an earlier one stops by itself.
    id: u64,
    redirect: LoginRedirect,
    /// The Access page the window was sent to, for "sign in in this window".
    access_url: Url,
    /// The browser sign-in of the current try, for "Open the browser again".
    login_url: Option<Url>,
}

#[derive(Default)]
pub struct Access(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    status: Status,
    attempt: Option<Attempt>,
    next_id: u64,
    /// When a token was last put in the window, to spot Access refusing it.
    handed_over: Option<Instant>,
    /// Until when Access's page may load in the window ("sign in in this window").
    inside_until: Option<Instant>,
}

fn state(app: &AppHandle) -> MutexGuard<'_, Inner> {
    app.state::<Access>().inner().0.lock().unwrap()
}

/// Called for every navigation in the main window. Returns false when the
/// navigation is Access's login page for `server` and has been taken over.
pub fn intercept(app: &AppHandle, server: &Url, url: &Url) -> bool {
    let Some(redirect) = transfer::login_redirect(url, server) else { return true };
    if state(app).inside_until.is_some_and(|until| Instant::now() < until) {
        return true;
    }
    let (handle, url) = (app.clone(), url.clone());
    tauri::async_runtime::spawn_blocking(move || take_over(&handle, redirect, url));
    false
}

fn take_over(app: &AppHandle, mut redirect: LoginRedirect, url: Url) {
    let window = main_window(app);
    let visible = window.as_ref().and_then(|window| window.is_visible().ok()).unwrap_or(false);
    // On macOS a frame's navigation comes here too (wry doesn't tell frames
    // apart), so an expired session seen by a chart or PDF frame lands here
    // with that file as `redirect_url`. Come back to the page the window
    // shows instead, or the server's root.
    if redirect.return_to.path().starts_with("/api/") {
        let origin = redirect.return_to.origin();
        let showing = window
            .as_ref()
            .and_then(|window| window.url().ok())
            .filter(|current| current.origin() == origin && !current.path().starts_with("/api/"));
        if let Some(page) = showing.or_else(|| server_of(&redirect.return_to)) {
            redirect.return_to = page;
        }
    }
    // Decided under one lock, and a sign-in claimed (Waiting) before the lock
    // is let go, so a second hop close behind (a frame and the page together)
    // joins this sign-in instead of opening a second browser tab.
    let begin = {
        let mut guard = state(app);
        let inner = &mut *guard;
        let refused = inner.handed_over.take().is_some_and(|at| at.elapsed() < REFUSED_WITHIN);
        // The hop again while the browser is already open on this app's
        // sign-in (a reload, another link) keeps that sign-in.
        let same = inner.status == Status::Waiting
            && inner.attempt.as_ref().is_some_and(|a| a.redirect.aud == redirect.aud);
        if let Some(current) = inner.attempt.as_mut().filter(|_| same) {
            current.redirect.return_to = redirect.return_to;
            current.access_url = url;
        } else {
            inner.next_id += 1;
            inner.attempt = Some(Attempt { id: inner.next_id, redirect, access_url: url, login_url: None });
        }
        if refused {
            inner.status = Status::Failed {
                message: "Cloudflare didn't accept the sign-in in this window. Try again, or sign in in this window instead."
                    .into(),
            };
            false
        } else if same {
            false
        } else if visible {
            inner.status = Status::Waiting;
            true
        } else {
            // Started hidden at login: don't throw a browser at the owner unasked.
            inner.status = Status::Needed;
            false
        }
    };
    show_page(app);
    if begin {
        start(app);
    } else {
        publish(app);
    }
}

/// A `totem-desktop://signin/<action>` from the sign-in page.
pub fn action(app: &AppHandle, action: &str) {
    let (handle, action) = (app.clone(), action.to_owned());
    tauri::async_runtime::spawn_blocking(move || run_action(&handle, &action));
}

fn run_action(app: &AppHandle, action: &str) {
    // Only the sign-in page's own buttons: on macOS a frame on another page
    // could navigate here too.
    if !main_window(app).and_then(|window| window.url().ok()).is_some_and(|url| is_signin_page(&url)) {
        return;
    }
    match action {
        // Start, or open the same sign-in in the browser again.
        "/open" => {
            let reopen = {
                let inner = state(app);
                let waiting = inner.status == Status::Waiting;
                inner.attempt.as_ref().and_then(|a| a.login_url.clone()).filter(|_| waiting)
            };
            match reopen {
                Some(url) => open_browser(app, &url),
                None => start(app),
            }
        }
        // Let Access's own page load in the window, for a setup the browser
        // sign-in can't handle. Only for a sign-in under way.
        "/inside" => {
            let target = {
                let mut inner = state(app);
                let target = inner.attempt.take().map(|attempt| attempt.access_url);
                if target.is_some() {
                    inner.inside_until = Some(Instant::now() + INSIDE_FOR);
                    inner.status = Status::Idle;
                }
                target
            };
            if let (Some(window), Some(target)) = (main_window(app), target) {
                let _ = window.navigate(target);
            }
        }
        // Give up on this try and go back to the server, which asks again.
        "/retry" => {
            let target = {
                let mut inner = state(app);
                inner.handed_over = None;
                inner.status = Status::Idle;
                inner.attempt.as_ref().map(|attempt| attempt.redirect.return_to.clone())
            };
            if let (Some(window), Some(target)) = (main_window(app), target) {
                let _ = window.navigate(target);
            }
        }
        _ => {}
    }
}

/// The script that tells the sign-in page where things stand.
pub fn status_script(app: &AppHandle) -> String {
    let status = serde_json::to_string(&state(app).status).unwrap();
    format!("window.totemSignin && window.totemSignin({status})")
}

/// Whether `url` is the bundled sign-in page.
pub fn is_signin_page(url: &Url) -> bool {
    // By scheme and host: `tauri://localhost` has an opaque origin, which
    // never compares equal, not even to itself.
    let bundled = bundled_origin();
    url.scheme() == bundled.scheme()
        && url.host_str() == bundled.host_str()
        && url.path().trim_start_matches('/') == SIGNIN_PAGE
}

fn bundled_origin() -> Url {
    // Tauri serves the bundled pages here (`tauri.conf.json` sets no
    // `useHttpsScheme`), on every webview, including one that loads a server.
    Url::parse(if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" }).unwrap()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(crate::MAIN)
}

/// Shows the sign-in page; it reads the status once it has loaded (`lib.rs`).
fn show_page(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    if !window.url().is_ok_and(|url| is_signin_page(&url)) {
        if let Ok(page) = bundled_origin().join(SIGNIN_PAGE) {
            let _ = window.navigate(page);
        }
    }
}

/// Tells the sign-in page, if it is showing, the current status.
fn publish(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    if window.url().is_ok_and(|url| is_signin_page(&url)) {
        let _ = window.eval(status_script(app));
    }
}

fn set_status(app: &AppHandle, status: Status) {
    state(app).status = status;
    publish(app);
}

/// Fails try `id`, unless something has already moved on from it (a newer
/// try, a failure with its own message, the owner choosing another way).
fn fail(app: &AppHandle, id: u64, message: String) {
    {
        let mut inner = state(app);
        let current = inner.status == Status::Waiting && inner.attempt.as_ref().is_some_and(|a| a.id == id);
        if !current {
            return;
        }
        inner.status = Status::Failed { message };
    }
    publish(app);
}

fn open_browser(app: &AppHandle, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        set_status(app, Status::Failed { message: format!("Couldn't open your browser: {e}") });
    }
}

/// Opens Access's sign-in in the browser and waits for the token in the background.
fn start(app: &AppHandle) {
    let (id, transfer) = {
        let mut guard = state(app);
        let inner = &mut *guard;
        let Some(current) = inner.attempt.as_mut() else { return };
        let Some(server) = server_of(&current.redirect.return_to) else { return };
        let transfer = Transfer::new(&server, &current.redirect.aud);
        inner.next_id += 1;
        current.id = inner.next_id;
        current.login_url = Some(transfer.login_url.clone());
        inner.status = Status::Waiting;
        (current.id, transfer)
    };
    publish(app);
    let login_url = transfer.login_url.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match wait_for_token(&handle, id, &transfer).await {
            Ok(Some(token)) => {
                let app = handle.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || hand_over(&app, id, &token)).await;
            }
            Ok(None) => fail(&handle, id, "The sign-in wasn't finished in time. Try again when you're ready.".into()),
            Err(message) => fail(&handle, id, message),
        }
    });
    open_browser(app, &login_url);
}

fn server_of(url: &Url) -> Option<Url> {
    Url::parse(&format!("{}/", url.origin().ascii_serialization())).ok()
}

/// Polls until the token arrives, the wait runs out (`Ok(None)`), or this try
/// stops being the one under way (also `Ok(None)`; `fail` then leaves it be).
async fn wait_for_token(app: &AppHandle, id: u64, transfer: &Transfer) -> Result<Option<String>, String> {
    let client = http_client()?;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let current = {
            let inner = state(app);
            inner.status == Status::Waiting && inner.attempt.as_ref().is_some_and(|a| a.id == id)
        };
        if !current {
            return Ok(None);
        }
        if let Some(token) = transfer.poll(&client).await? {
            return Ok(Some(token));
        }
    }
    Ok(None)
}

fn http_client() -> Result<reqwest::Client, String> {
    // reqwest is built without a TLS provider (as the updater uses it), so
    // install ring's once, as tauri-plugin-updater does.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder().build().map_err(|e| format!("Couldn't reach Cloudflare: {e}"))
}

/// Puts the token where Access looks for it and loads the page the window was going to.
fn hand_over(app: &AppHandle, id: u64, token: &str) {
    let Some(window) = main_window(app) else { return };
    let return_to = {
        let inner = state(app);
        let current = inner.status == Status::Waiting;
        inner.attempt.as_ref().filter(|a| current && a.id == id).map(|a| a.redirect.return_to.clone())
    };
    let Some(return_to) = return_to else { return };
    if let Err(e) = set_cookie(&window, &return_to, token) {
        fail(app, id, format!("Couldn't keep the sign-in in this window: {e}"));
        return;
    }
    {
        let mut inner = state(app);
        inner.handed_over = Some(Instant::now());
        inner.status = Status::Done;
    }
    publish(app);
    crate::show_main(app);
    let _ = window.navigate(return_to);
}

fn set_cookie(window: &WebviewWindow, server: &Url, token: &str) -> tauri::Result<()> {
    let host = server.host_str().unwrap_or_default().to_owned();
    // Host-only (no leading dot), like the cookie Access sets itself, so it
    // replaces that one rather than sitting beside it.
    let mut cookie = Cookie::build(("CF_Authorization", token.to_owned()))
        .domain(host)
        .path("/")
        .secure(server.scheme() == "https")
        .http_only(true)
        .same_site(SameSite::Lax);
    if let Some(expires) = transfer::token_expiry(token).and_then(|exp| OffsetDateTime::from_unix_timestamp(exp).ok()) {
        cookie = cookie.expires(expires);
    }
    window.set_cookie(cookie.build())
}
