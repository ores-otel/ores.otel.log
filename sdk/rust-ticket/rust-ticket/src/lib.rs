//! One-time tickets for `ores-otel/ws-ingest/v1`.
//!
//! The app backend (which already knows the authenticated user) mints a short-lived ticket bound
//! to exactly one user, app, Supabase project and nonce; the Edge Function verifies the HMAC,
//! consumes the nonce once, and only then accepts telemetry batches. Clients never see a Supabase
//! key. Wire format: `base64url(payload_json) + "." + base64url(hmac_sha256(secret, payload_json))`
//! — identical to `supabase/functions/telemetry-ws-ingest/index.ts`.
#![forbid(unsafe_code)]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketClaims {
    pub user_id: String,
    pub app_name: String,
    pub project_ref: String,
    /// Unix seconds.
    pub exp: u64,
    pub nonce: String,
}

#[derive(Debug, Clone)]
pub struct TicketMinter {
    secret: Vec<u8>,
    app_name: String,
    project_ref: String,
    ttl: Duration,
    ingest_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssuedTicket {
    /// `wss://<project-ref>.supabase.co/functions/v1/telemetry-ws-ingest`
    pub url: String,
    pub ticket: String,
    /// RFC 3339 UTC.
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketError {
    WeakSecret,
    Malformed,
    BadSignature,
    Expired,
}

impl std::fmt::Display for TicketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TicketError::WeakSecret => "ticket secret must be at least 32 bytes",
            TicketError::Malformed => "malformed ticket",
            TicketError::BadSignature => "bad signature",
            TicketError::Expired => "ticket expired",
        })
    }
}
impl std::error::Error for TicketError {}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn rfc3339(secs: u64) -> String {
    // minimal UTC formatter (no chrono dependency)
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

impl TicketMinter {
    /// `secret` is shared with the Edge Function (`TELEMETRY_TICKET_SECRET`); keep it in env/secret store only.
    pub fn new(
        secret: impl AsRef<[u8]>,
        app_name: impl Into<String>,
        project_ref: impl Into<String>,
        ttl: Duration,
    ) -> Result<Self, TicketError> {
        let secret = secret.as_ref().to_vec();
        if secret.len() < 32 {
            return Err(TicketError::WeakSecret);
        }
        let project_ref = project_ref.into();
        Ok(Self {
            ingest_url: format!("wss://{project_ref}.supabase.co/functions/v1/telemetry-ws-ingest"),
            secret,
            app_name: app_name.into(),
            project_ref,
            ttl,
        })
    }

    /// Override the ingest URL (self-hosted Supabase or a custom domain).
    pub fn with_ingest_url(mut self, url: impl Into<String>) -> Self {
        self.ingest_url = url.into();
        self
    }

    pub fn mint_for(&self, user_id: &str) -> IssuedTicket {
        self.mint_at(user_id, now_secs(), random_nonce())
    }

    pub fn mint_at(&self, user_id: &str, now: u64, nonce: String) -> IssuedTicket {
        let claims = TicketClaims {
            user_id: user_id.to_owned(),
            app_name: self.app_name.clone(),
            project_ref: self.project_ref.clone(),
            exp: now + self.ttl.as_secs(),
            nonce,
        };
        let payload = serde_json::to_vec(&claims).expect("claims serialize");
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("hmac accepts any key length");
        mac.update(&payload);
        let sig = mac.finalize().into_bytes();
        IssuedTicket {
            url: self.ingest_url.clone(),
            ticket: format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(payload),
                URL_SAFE_NO_PAD.encode(sig)
            ),
            expires_at: rfc3339(claims.exp),
        }
    }

    /// Verify a ticket (used by tests and by any Rust-side ingest). Mirrors the Edge Function.
    pub fn verify(&self, ticket: &str) -> Result<TicketClaims, TicketError> {
        self.verify_at(ticket, now_secs())
    }

    pub fn verify_at(&self, ticket: &str, now: u64) -> Result<TicketClaims, TicketError> {
        let (p, s) = ticket.split_once('.').ok_or(TicketError::Malformed)?;
        let payload = URL_SAFE_NO_PAD
            .decode(p)
            .map_err(|_| TicketError::Malformed)?;
        let sig = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|_| TicketError::Malformed)?;
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("hmac accepts any key length");
        mac.update(&payload);
        mac.verify_slice(&sig)
            .map_err(|_| TicketError::BadSignature)?;
        let claims: TicketClaims =
            serde_json::from_slice(&payload).map_err(|_| TicketError::Malformed)?;
        if claims.exp < now {
            return Err(TicketError::Expired);
        }
        Ok(claims)
    }
}

pub fn random_nonce() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// `POST /api/telemetry/ticket` — the route every `*-api-server.rs` mounts. The caller's authenticated
/// subject is taken from an extension inserted by the server's own auth layer (shared-auth), so this
/// crate never parses tokens itself.
#[cfg(feature = "axum")]
pub mod route {
    use super::{IssuedTicket, TicketMinter};
    use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
    use std::sync::Arc;

    /// Insert this into request extensions from your auth middleware.
    #[derive(Debug, Clone)]
    pub struct TelemetrySubject(pub String);

    async fn ticket(
        State(minter): State<Arc<TicketMinter>>,
        subject: Option<axum::Extension<TelemetrySubject>>,
    ) -> Result<Json<IssuedTicket>, StatusCode> {
        let subject = subject.ok_or(StatusCode::UNAUTHORIZED)?;
        Ok(Json(minter.mint_for(&subject.0 .0)))
    }

    /// `Router::new().merge(telemetry_ticket_router(minter))`
    pub fn telemetry_ticket_router(minter: Arc<TicketMinter>) -> Router {
        Router::new()
            .route("/api/telemetry/ticket", post(ticket))
            .with_state(minter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minter() -> TicketMinter {
        TicketMinter::new(
            b"0123456789abcdef0123456789abcdef",
            "example-app",
            "szzbuljocwprjhaqnbvb",
            Duration::from_secs(120),
        )
        .unwrap()
    }

    #[test]
    fn mint_then_verify_round_trips() {
        let m = minter();
        let t = m.mint_at("user-1", 1_800_000_000, "nonce-0123456789abcdef".into());
        assert_eq!(
            t.url,
            "wss://szzbuljocwprjhaqnbvb.supabase.co/functions/v1/telemetry-ws-ingest"
        );
        assert_eq!(t.expires_at, rfc3339(1_800_000_120));
        assert!(t.expires_at.ends_with('Z') && t.expires_at.len() == 20);
        let c = m.verify_at(&t.ticket, 1_800_000_060).unwrap();
        assert_eq!(c.user_id, "user-1");
        assert_eq!(c.app_name, "example-app");
        assert_eq!(c.exp, 1_800_000_120);
    }

    #[test]
    fn expired_tampered_and_wrong_key_fail() {
        let m = minter();
        let t = m.mint_at("user-1", 1_800_000_000, random_nonce());
        assert!(matches!(
            m.verify_at(&t.ticket, 1_800_000_121),
            Err(TicketError::Expired)
        ));
        let (p, s) = t.ticket.split_once('.').unwrap();
        let tampered = format!("{}.{}", URL_SAFE_NO_PAD.encode(br#"{"userId":"user-2","appName":"example-app","projectRef":"szzbuljocwprjhaqnbvb","exp":1900000000,"nonce":"nonce-0123456789abcdef"}"#), s);
        assert!(matches!(
            m.verify_at(&tampered, 1_800_000_000),
            Err(TicketError::BadSignature)
        ));
        let other = TicketMinter::new(
            b"ffffffffffffffffffffffffffffffff",
            "example-app",
            "szzbuljocwprjhaqnbvb",
            Duration::from_secs(120),
        )
        .unwrap();
        assert!(matches!(
            other.verify_at(&format!("{p}.{s}"), 1_800_000_000),
            Err(TicketError::BadSignature)
        ));
        assert!(matches!(
            m.verify_at("garbage", 0),
            Err(TicketError::Malformed)
        ));
    }

    #[test]
    fn weak_secret_rejected_and_nonces_unique() {
        assert!(matches!(
            TicketMinter::new(b"short", "a", "b", Duration::from_secs(1)),
            Err(TicketError::WeakSecret)
        ));
        assert_ne!(random_nonce(), random_nonce());
        assert!(random_nonce().len() >= 16);
    }

    #[test]
    fn rfc3339_matches_known_dates() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_756_944_000), "2025-09-04T00:00:00Z");
    }
}
