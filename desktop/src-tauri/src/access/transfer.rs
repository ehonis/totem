//! Cloudflare Access's command-line sign-in, the way `cloudflared access login`
//! does it (cloudflared's token/transfer.go and token/encrypt.go), and the way
//! the iPhone app does it (`mobile/src/lib/cfAccess.ts`).
//!
//! The owner signs in on Access's own page in their usual browser. Access then
//! hands the app token to Cloudflare's transfer service, sealed with NaCl box to
//! a key pair made for this one sign-in, and this side collects and opens it.
//! Nothing here touches Tauri, so it can be tested on its own.

use std::time::Duration;

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE},
    Engine as _,
};
use crypto_box::{aead::Aead, aead::OsRng, PublicKey, SalsaBox, SecretKey};
use url::Url;

pub const TRANSFER: &str = "https://login.cloudflareaccess.org/transfer/";
/// How long one poll may hang: the transfer service holds the request open until
/// the token arrives or it gives up, and answers "not yet" with a non-200.
const POLL_REQUEST: Duration = Duration::from_secs(70);
const POLL_PAUSE: Duration = Duration::from_secs(1);

/// Where Access sent the window to sign in, for the Totem server it loads.
#[derive(Debug, Clone, PartialEq)]
pub struct LoginRedirect {
    /// The Access application's AUD tag, which the command-line sign-in names.
    pub aud: String,
    /// The page on the server the window was going to, to return to after.
    pub return_to: Url,
}

/// Recognises Access's login page for `server`: a hop to
/// `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<server host>?kid=…&meta=…&redirect_url=…`.
/// A login for any other host (a link out to another Access app) is not ours.
pub fn login_redirect(url: &Url, server: &Url) -> Option<LoginRedirect> {
    if url.scheme() != "https" || !url.host_str()?.ends_with(".cloudflareaccess.com") {
        return None;
    }
    let host = url.path().strip_prefix("/cdn-cgi/access/login/")?;
    if !host.eq_ignore_ascii_case(server.host_str()?) {
        return None;
    }
    let param = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    let aud = param("meta")
        .and_then(|meta| jwt_payload(&meta))
        .and_then(|payload| match payload.get("aud")? {
            serde_json::Value::String(aud) => Some(aud.clone()),
            serde_json::Value::Array(auds) => auds.first()?.as_str().map(str::to_owned),
            _ => None,
        })
        .or_else(|| param("kid"))
        .filter(|aud| !aud.is_empty() && aud.bytes().all(|b| b.is_ascii_alphanumeric()))?;
    // `redirect_url` is a path on the server. Anything that resolves off the
    // server's origin falls back to the server's own address.
    let return_to = param("redirect_url")
        .and_then(|path| server.join(&path).ok())
        .filter(|target| target.origin() == server.origin())
        .unwrap_or_else(|| server.clone());
    Some(LoginRedirect { aud, return_to })
}

/// The JSON payload of a JWT, unverified: only used to read routing hints
/// (`aud`) and the cookie's expiry, never to trust anything.
pub fn jwt_payload(jwt: &str) -> Option<serde_json::Value> {
    let part = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE.decode(pad(part.trim_end_matches('='))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// When an app token stops working, in seconds since the epoch.
pub fn token_expiry(token: &str) -> Option<i64> {
    jwt_payload(token)?.get("exp")?.as_i64()
}

fn pad(s: &str) -> String {
    let mut s = s.to_owned();
    while s.len() % 4 != 0 {
        s.push('=');
    }
    s
}

/// One sign-in: its key pair, and the page to open in the browser.
pub struct Transfer {
    secret: SecretKey,
    /// The public key, URL-safe base64 with padding, as cloudflared sends it.
    public: String,
    pub login_url: Url,
}

impl Transfer {
    pub fn new(server: &Url, aud: &str) -> Self {
        Self::with_secret(server, aud, SecretKey::generate(&mut OsRng))
    }

    fn with_secret(server: &Url, aud: &str, secret: SecretKey) -> Self {
        let public = URL_SAFE.encode(secret.public_key().as_bytes());
        let origin = server.origin().ascii_serialization();
        let mut back = Url::parse(&format!("{origin}/")).expect("an origin is a URL");
        back.query_pairs_mut().append_pair("token", &public).append_pair("aud", aud);
        let mut login_url = Url::parse(&format!("{origin}/cdn-cgi/access/cli")).expect("an origin is a URL");
        login_url
            .query_pairs_mut()
            .append_pair("token", &public)
            .append_pair("aud", aud)
            .append_pair("redirect_url", back.as_str())
            .append_pair("send_org_token", "true")
            .append_pair("edge_token_transfer", "true")
            .append_pair("close_interstitial", "true");
        Self { secret, public, login_url }
    }

    /// Asks the transfer service once. `Ok(None)` means "not yet".
    pub async fn poll(&self, client: &reqwest::Client) -> Result<Option<String>, String> {
        let response = client
            .get(format!("{TRANSFER}{}", self.public))
            .header("user-agent", "totem-desktop")
            .timeout(POLL_REQUEST)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            // A dropped or timed-out long poll is normal; try again.
            Err(_) => {
                tokio::time::sleep(POLL_PAUSE).await;
                return Ok(None);
            }
        };
        let status = response.status();
        if status.is_server_error() {
            return Err(format!("Cloudflare's sign-in service failed ({}).", status.as_u16()));
        }
        if status.as_u16() != 200 {
            tokio::time::sleep(POLL_PAUSE).await;
            return Ok(None);
        }
        let sender = response
            .headers()
            .get("service-public-key")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = response.text().await.map_err(|_| "Cloudflare's reply was cut off.".to_string())?;
        self.open(&sender, &body).map(Some)
    }

    /// Opens the sealed reply: base64 of a 24-byte nonce followed by the box.
    pub fn open(&self, sender: &str, body: &str) -> Result<String, String> {
        let unreadable = || "Could not read the sign-in Cloudflare sent back.".to_string();
        let sender: [u8; 32] = decode_any(sender).and_then(|key| key.try_into().ok()).ok_or_else(unreadable)?;
        let sealed = decode_any(body).filter(|sealed| sealed.len() > 24).ok_or_else(unreadable)?;
        let (nonce, sealed) = sealed.split_at(24);
        let opened = SalsaBox::new(&PublicKey::from(sender), &self.secret)
            .decrypt(nonce.into(), sealed)
            .map_err(|_| unreadable())?;
        let reply: serde_json::Value = serde_json::from_slice(&opened).map_err(|_| unreadable())?;
        reply
            .get("app_token")
            .and_then(|token| token.as_str())
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "Cloudflare did not send a sign-in for this app.".to_string())
    }
}

/// Base64 in either alphabet, padded or not, ignoring surrounding whitespace.
fn decode_any(text: &str) -> Option<Vec<u8>> {
    let text = text.trim().trim_end_matches('=');
    let normal: String = text.chars().map(|c| match c { '-' => '+', '_' => '/', c => c }).collect();
    STANDARD.decode(pad(&normal)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Url {
        Url::parse("https://totem.example.com/").unwrap()
    }

    fn meta(aud: &str) -> String {
        let payload = URL_SAFE.encode(format!(r#"{{"type":"meta","aud":"{aud}"}}"#));
        format!("eyJhbGciOiJSUzI1NiJ9.{}.sig", payload.trim_end_matches('='))
    }

    #[test]
    fn recognises_the_login_hop_for_this_server() {
        let url = Url::parse(&format!(
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/totem.example.com?kid=abc123&meta={}&redirect_url=%2Fchat%3Fthread%3Dx",
            meta("abc123")
        ))
        .unwrap();
        let found = login_redirect(&url, &server()).unwrap();
        assert_eq!(found.aud, "abc123");
        assert_eq!(found.return_to.as_str(), "https://totem.example.com/chat?thread=x");
    }

    #[test]
    fn falls_back_to_kid_and_to_the_server() {
        let url = Url::parse("https://team.cloudflareaccess.com/cdn-cgi/access/login/TOTEM.example.com?kid=def456&redirect_url=https%3A%2F%2Fevil.example%2F").unwrap();
        let found = login_redirect(&url, &server()).unwrap();
        assert_eq!(found.aud, "def456");
        assert_eq!(found.return_to, server());
    }

    #[test]
    fn ignores_other_hosts_and_pages() {
        for url in [
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/other.example.com?kid=abc",
            "https://team.cloudflareaccess.com/cdn-cgi/access/logout",
            "https://cloudflareaccess.com.evil.example/cdn-cgi/access/login/totem.example.com?kid=abc",
            "http://team.cloudflareaccess.com/cdn-cgi/access/login/totem.example.com?kid=abc",
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/totem.example.com",
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/totem.example.com?kid=a%26b",
        ] {
            assert_eq!(login_redirect(&Url::parse(url).unwrap(), &server()), None, "{url}");
        }
    }

    #[test]
    fn builds_the_cli_login_url() {
        let transfer = Transfer::new(&Url::parse("https://totem.example.com/some/path").unwrap(), "abc123");
        let url = &transfer.login_url;
        assert_eq!(url.origin().ascii_serialization(), "https://totem.example.com");
        assert_eq!(url.path(), "/cdn-cgi/access/cli");
        let get = |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned()).unwrap();
        assert_eq!(get("token"), transfer.public);
        assert_eq!(get("aud"), "abc123");
        assert_eq!(get("edge_token_transfer"), "true");
        let back = Url::parse(&get("redirect_url")).unwrap();
        assert_eq!(back.path(), "/");
        assert_eq!(back.host_str(), Some("totem.example.com"));
    }

    #[test]
    fn opens_a_sealed_reply() {
        let transfer = Transfer::new(&server(), "abc");
        let service = SecretKey::generate(&mut OsRng);
        let mine = PublicKey::from(<[u8; 32]>::try_from(URL_SAFE.decode(&transfer.public).unwrap()).unwrap());
        let nonce = [7u8; 24];
        let sealed = SalsaBox::new(&mine, &service)
            .encrypt((&nonce).into(), br#"{"app_token":"a.b.c","org_token":"x"}"#.as_slice())
            .unwrap();
        let body = STANDARD.encode([nonce.as_slice(), &sealed].concat());
        let sender = STANDARD.encode(service.public_key().as_bytes());
        assert_eq!(transfer.open(&sender, &body).unwrap(), "a.b.c");
        // Tampered or meant for someone else: refused.
        let other = SecretKey::generate(&mut OsRng);
        assert!(transfer.open(&STANDARD.encode(other.public_key().as_bytes()), &body).is_err());
    }

    /// Sealed by tweetnacl (what the iPhone app opens Cloudflare's replies with),
    /// to the key pair whose secret is 1, 2, …, 32, from the one whose secret is
    /// 200, 199, …, 169, with the nonce 0, 3, 6, ….
    #[test]
    fn opens_a_reply_sealed_by_tweetnacl() {
        let secret: [u8; 32] = std::array::from_fn(|i| i as u8 + 1);
        let transfer = Transfer::with_secret(&server(), "abc", SecretKey::from(secret));
        let sender = "ja/P7q6QRe6aeNeKmfzzLneB5EHrBzCWw0K44tzDthI=";
        let body = "AAMGCQwPEhUYGx4hJCcqLTAzNjk8P0JFdSoxjpYCakqSpB3c8LaHlU8V6T6Ff7RbWHmbAeyItiJaiiG4mR/a1NKG1bOUf3+KT10AUgs=";
        assert_eq!(transfer.open(sender, body).unwrap(), "h.p.s");
        // The same reply in URL-safe base64 without padding reads the same.
        let url_safe = |s: &str| s.replace('+', "-").replace('/', "_").trim_end_matches('=').to_owned();
        assert_eq!(transfer.open(&url_safe(sender), &url_safe(body)).unwrap(), "h.p.s");
    }

    #[test]
    fn reads_the_token_expiry() {
        let payload = URL_SAFE.encode(r#"{"exp":1900000000}"#);
        assert_eq!(token_expiry(&format!("h.{}.s", payload.trim_end_matches('='))), Some(1900000000));
        assert_eq!(token_expiry("not a jwt"), None);
    }
}
