//! Explicit browser/server correlation. No global subscriber, provider, executor,
//! network client, authentication context, or panic hook is installed.
#![forbid(unsafe_code)]

use std::{fmt, str::FromStr};

#[cfg(all(feature = "browser", target_arch = "wasm32"))]
pub mod browser;
#[cfg(all(feature = "axum", not(target_arch = "wasm32")))]
pub mod server;

/// Strict W3C traceparent version 00 carrier. Only validated, bounded IDs can
/// enter this type. Unknown versions are deliberately rejected, not truncated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceParent {
    trace_id: String,
    span_id: String,
    flags: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidTraceParent;
impl fmt::Display for InvalidTraceParent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid version-00 trace context")
    }
}
impl std::error::Error for InvalidTraceParent {}

fn valid_id(value: &str, length: usize) -> bool {
    value.len() == length
        && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}

impl TraceParent {
    pub fn new(trace_id: &str, span_id: &str, flags: u8) -> Result<Self, InvalidTraceParent> {
        if !valid_id(trace_id, 32) || !valid_id(span_id, 16) {
            return Err(InvalidTraceParent);
        }
        Ok(Self { trace_id: trace_id.into(), span_id: span_id.into(), flags })
    }
    pub fn trace_id(&self) -> &str { &self.trace_id }
    pub fn span_id(&self) -> &str { &self.span_id }
    pub fn flags(&self) -> u8 { self.flags }
    pub fn sampled(&self) -> bool { self.flags & 1 != 0 }
    pub fn child(&self, span_id: &str) -> Result<Self, InvalidTraceParent> {
        Self::new(&self.trace_id, span_id, self.flags)
    }
}

impl FromStr for TraceParent {
    type Err = InvalidTraceParent;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        // Check ASCII BEFORE byte slicing: untrusted UTF-8 must never panic.
        if value.len() != 55 || !value.is_ascii() || &value[..3] != "00-"
            || value.as_bytes()[35] != b'-' || value.as_bytes()[52] != b'-'
            || !value[53..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(InvalidTraceParent);
        }
        Self::new(&value[3..35], &value[36..52], u8::from_str_radix(&value[53..], 16).map_err(|_| InvalidTraceParent)?)
    }
}
impl fmt::Display for TraceParent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "00-{}-{}-{:02x}", self.trace_id, self.span_id, self.flags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    #[test]
    fn round_trip() { assert_eq!(VALID.parse::<TraceParent>().unwrap().to_string(), VALID); }
    #[test]
    fn child_preserves_trace_and_flags() {
        let parent: TraceParent = VALID.parse().unwrap();
        let child = parent.child("1234567890abcdef").unwrap();
        assert_eq!(child.trace_id(), parent.trace_id());
        assert_ne!(child.span_id(), parent.span_id());
        assert!(child.sampled());
    }
    #[test]
    fn sampled_out_is_not_promoted() {
        let parent = TraceParent::new("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", 0).unwrap();
        assert!(!parent.child("1234567890abcdef").unwrap().sampled());
    }
    #[test]
    fn rejects_zero_ids() {
        assert!(TraceParent::new(&"0".repeat(32), "00f067aa0ba902b7", 0).is_err());
        assert!(TraceParent::new("4bf92f3577b34da6a3ce929d0e0e4736", &"0".repeat(16), 0).is_err());
    }
    #[test]
    fn rejects_untrusted_inputs_without_panics() {
        let cases = [String::new(), VALID.to_uppercase(), format!(" {VALID}"),
            format!("{VALID}\r\nAuthorization: secret"), format!("{VALID}-extra"),
            VALID.replacen("00-", "ff-", 1), VALID.replacen("00-", "01-", 1),
            "é".repeat(27) + "a", "a".repeat(65_536)];
        for value in cases { assert!(value.parse::<TraceParent>().is_err()); }
    }
    #[test]
    fn every_truncation_is_invalid() {
        for end in 0..VALID.len() { assert!(VALID[..end].parse::<TraceParent>().is_err()); }
    }
    #[test]
    fn flags_round_trip_without_enabling_sampling() {
        for flag in 0..=255 {
            let parent = TraceParent::new("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", flag).unwrap();
            assert_eq!(parent.to_string().parse::<TraceParent>().unwrap(), parent);
            assert_eq!(parent.sampled(), flag & 1 != 0);
        }
    }
}
