//! Synchronous ores-otel startup logging followed by Unix process replacement.
//!
//! This is not an options parser, init system, secret loader, or OTLP exporter.
//! The executable and its options are an opaque native argument vector. The
//! application remains responsible for flags-2-env, signal handling and children.

mod redaction;

use crate::{json, JsonObject, LogRecord, Logger, LoggerError, Options, Transport};
use std::ffi::OsString;
use std::io::{self, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};
use std::sync::Arc;

/// Local transport for the canonical ores-otel record, not a second log schema.
/// No worker thread, global provider, socket, retry or network flush is started.
struct StderrTransport;

impl Transport for StderrTransport {
    fn write(&self, record: &LogRecord) -> Result<(), LoggerError> {
        let encoded = record.to_json()?;
        let mut stderr = io::stderr().lock();
        stderr
            .write_all(encoded.as_bytes())
            .and_then(|()| stderr.write_all(b"\n"))
            .and_then(|()| stderr.flush())
            .map_err(|error| LoggerError(error.to_string()))
    }

    fn flush(&self) -> Result<(), LoggerError> {
        io::stderr()
            .flush()
            .map_err(|error| LoggerError(error.to_string()))
    }
}

fn startup_logger() -> Logger {
    let service = std::env::var("OTEL_SERVICE_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| redaction::bounded(&value))
        .unwrap_or_else(|| "ores-launcher".into());
    Logger::new(
        Options {
            app_name: service,
            name: Some("ores-launcher".into()),
            // The SDK's human console output uses stdout. Only our canonical
            // JSON stderr transport is enabled; child stdout is untouched.
            console: false,
            ..Options::default()
        }
        .with_transport(Arc::new(StderrTransport)),
    )
}

fn command_fields(argv: &[OsString]) -> JsonObject {
    JsonObject::from_iter([
        ("process.pid".into(), json!(std::process::id())),
        ("process.command_args".into(), json!(redaction::argv(argv))),
        ("process.command_args_count".into(), json!(argv.len())),
        ("launcher.log_policy".into(), json!("redacted-bounded-v1")),
    ])
}

/// Log a display copy, then execute the original argv without a shell or fork.
///
/// Success never returns. Failure returns 64 for missing/empty executable, 127
/// for NotFound (including a missing interpreter/loader), and 126 otherwise.
/// Write/flush errors are best-effort and never replace the application's result.
/// Like ordinary stderr writes, a blocked log consumer can exert backpressure.
pub fn run(argv: Vec<OsString>) -> ExitCode {
    let logger = startup_logger();
    let Some((program, arguments)) = argv.split_first().filter(|(p, _)| !p.is_empty()) else {
        let _ = logger
            .error(vec![json!(
                "usage: ores-launcher <executable> [arguments...]"
            )])
            .add_fields(JsonObject::from_iter([(
                "event.name".into(),
                json!("process.exec.invalid_command"),
            )]))
            .send();
        let _ = logger.flush(false);
        return ExitCode::from(64);
    };

    let mut fields = command_fields(&argv);
    fields.insert("event.name".into(), json!("process.exec.attempt"));
    let _ = logger.info(vec![json!("command is")]).add_fields(fields).send();
    // exec does not run destructors. Explicitly finish synchronous logging first.
    let _ = logger.flush(false);

    // Never execute the redacted/truncated representation. No env/cwd/uid/stdin
    // changes are made, and the application takes over the same PID.
    let error = Command::new(program).args(arguments).exec();

    let mut fields = command_fields(&argv);
    fields.insert("event.name".into(), json!("process.exec.failed"));
    fields.insert("error.kind".into(), json!(format!("{:?}", error.kind())));
    fields.insert("error.os_code".into(), json!(error.raw_os_error()));
    // Avoid error strings that might embed raw command arguments in the future.
    let _ = logger
        .error(vec![json!("cannot execute command")])
        .add_fields(fields)
        .send();
    let _ = logger.flush(false);
    ExitCode::from(if error.kind() == io::ErrorKind::NotFound {
        127
    } else {
        126
    })
}
