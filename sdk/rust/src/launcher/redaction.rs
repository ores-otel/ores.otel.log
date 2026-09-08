use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;

const MAX_ARGUMENTS: usize = 32;
const MAX_CHARACTERS: usize = 128;
const REDACTED: &str = "[REDACTED]";

pub(super) fn bounded(value: &str) -> String {
    let mut chars = value.chars();
    let mut output: String = chars.by_ref().take(MAX_CHARACTERS).collect();
    if chars.next().is_some() {
        output.push_str("...[truncated]");
    }
    output
}

fn sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "apikey",
        "authorization",
        "cookie",
        "credential",
        "privatekey",
        "connectionstring",
        "databaseurl",
        "dsn",
    ]
    .iter()
    .any(|part| normalized.contains(part))
        || matches!(normalized.as_str(), "auth" | "header" | "user")
}

fn sensitive_literal(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    // Hide entire URLs, not just userinfo: query/path components may be signed.
    value.contains("://")
        || lower.starts_with("bearer ")
        || lower.starts_with("basic ")
        || lower.contains("authorization:")
        || lower.contains("cookie:")
        || value.starts_with("eyJ")
}

fn opaque_option_needs_value(argument: &OsString) -> bool {
    let bytes = argument.as_bytes();
    bytes.starts_with(b"-") && !bytes.contains(&b'=')
}

/// This is a display transform only, not an argv parser. It does not promise to
/// recognize arbitrary positional secrets: credentials must never enter argv.
pub(super) fn argv(arguments: &[OsString]) -> Vec<String> {
    let mut redact_next = false;
    let mut output = Vec::new();
    for (index, argument) in arguments.iter().take(MAX_ARGUMENTS).enumerate() {
        if redact_next {
            output.push(REDACTED.into());
            // A masked value may itself be another option. Continue hiding its
            // possible value rather than leaking through a chain of options.
            redact_next = opaque_option_needs_value(argument);
            continue;
        }
        let Some(value) = argument.to_str() else {
            output.push("[NON_UTF8]".into());
            // Do not echo a malformed key's possible value on the next iteration.
            redact_next = index > 0 && opaque_option_needs_value(argument);
            continue;
        };
        if sensitive_literal(value) {
            output.push(REDACTED.into());
            continue;
        }
        if index > 0 {
            // Check attached short values BEFORE treating text as an option name.
            // A value such as -p<text-containing-token> is not a safe key to echo.
            // -p is ambiguous (port/password); hiding it is the safer default.
            if let Some(alias) = ["-p", "-P", "-k", "-u", "-H"]
                .iter()
                .find(|alias| value.starts_with(**alias))
            {
                if value.len() == alias.len() {
                    redact_next = true;
                    output.push((*alias).into());
                } else {
                    output.push(format!("{alias}{REDACTED}"));
                }
                continue;
            }
            let (key, inline) = value
                .split_once('=')
                .map_or((value, false), |(key, _)| (key, true));
            if (inline || key.starts_with('-')) && sensitive_key(key) {
                // Unknown option spellings can embed a secret in the apparent
                // key itself. Hide the entire argument, not just the =value.
                output.push(REDACTED.into());
                redact_next = !inline;
                continue;
            }
        }
        output.push(bounded(value));
    }
    if arguments.len() > MAX_ARGUMENTS {
        output.push(format!(
            "[{} arguments omitted]",
            arguments.len() - MAX_ARGUMENTS
        ));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    fn display(values: &[&str]) -> Vec<String> {
        argv(&values.iter().map(OsString::from).collect::<Vec<_>>())
    }

    #[test]
    fn preserves_display_boundaries_without_shell_interpretation() {
        assert_eq!(
            display(&["/app", "--port", "9090", "two words", "", "*", "a\nb"]),
            ["/app", "--port", "9090", "two words", "", "*", "a\nb"]
        );
    }

    #[test]
    fn masks_named_and_inline_credentials_including_the_apparent_key() {
        assert_eq!(
            display(&[
                "/app",
                "--token",
                "fixture",
                "--api-key=fixture",
                "DB_PASSWORD=fixture"
            ]),
            ["/app", REDACTED, REDACTED, REDACTED, REDACTED]
        );
    }

    #[test]
    fn masked_option_chains_do_not_expose_the_last_value() {
        assert_eq!(
            display(&["/app", "--token", "--password", "fixture", "public"]),
            ["/app", REDACTED, REDACTED, REDACTED, "public"]
        );
    }

    #[test]
    fn masks_short_aliases_headers_urls_and_bearer_values() {
        let output = display(&[
            "/app",
            "-pfixture",
            "-H",
            "X-Custom: fixture",
            "https://example.invalid/signed",
            "Bearer fixture",
            "--header=X-Custom: fixture",
        ]);
        assert!(!output.join(" ").contains("fixture"));
        assert!(!output.join(" ").contains("example.invalid"));
    }

    #[test]
    fn non_utf8_is_hidden_and_original_bytes_are_untouched() {
        let arguments = vec![OsString::from("/app"), OsString::from_vec(vec![0xff, b'x'])];
        assert_eq!(argv(&arguments), ["/app", "[NON_UTF8]"]);
        assert_eq!(arguments[1].clone().into_vec(), vec![0xff, b'x']);
    }

    #[test]
    fn bounds_unicode_and_argument_count_without_changing_execution_data() {
        let values = vec![OsString::from("é".repeat(1000)); 100];
        let output = argv(&values);
        assert_eq!(output.len(), MAX_ARGUMENTS + 1);
        assert!(output[0].ends_with("...[truncated]"));
        assert_eq!(output.last().unwrap(), "[68 arguments omitted]");
        assert_eq!(values.len(), 100);
    }
}
