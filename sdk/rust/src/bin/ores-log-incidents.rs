use next_loggers::{scan_local_incidents, IncidentScanOptions};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

#[derive(Debug)]
struct Cli {
    app: String,
    root: Option<PathBuf>,
    lookback_seconds: u64,
    max_samples: usize,
    max_bytes: usize,
    max_message_bytes: usize,
    include_messages: bool,
    exit_on_incidents: bool,
}

fn main() -> ExitCode {
    match parse_args().and_then(run) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("ores-log-incidents: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode, String> {
    let mut options = if let Some(root) = cli.root {
        IncidentScanOptions::at_root(root, cli.app)
    } else {
        IncidentScanOptions::for_app(cli.app).map_err(|error| error.to_string())?
    };
    options.lookback = Duration::from_secs(cli.lookback_seconds);
    options.max_samples = cli.max_samples;
    options.max_output_bytes = cli.max_bytes;
    options.max_message_bytes = cli.max_message_bytes;
    options.include_messages = cli.include_messages;

    let bundle = scan_local_incidents(&options).map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::to_string(&bundle).map_err(|error| error.to_string())?
    );
    if cli.exit_on_incidents && bundle.has_incidents() {
        Ok(ExitCode::from(10))
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

fn parse_args() -> Result<Cli, String> {
    let mut args = std::env::args().skip(1);
    let mut app = None;
    let mut root = None;
    let mut lookback_seconds = 20 * 60;
    let mut max_samples = 32;
    let mut max_bytes = 24 * 1024;
    let mut max_message_bytes = 2 * 1024;
    let mut include_messages = false;
    let mut exit_on_incidents = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--app" => app = Some(next_value(&mut args, "--app")?),
            "--root" => root = Some(PathBuf::from(next_value(&mut args, "--root")?)),
            "--lookback-seconds" => {
                lookback_seconds = parse_u64(next_value(&mut args, "--lookback-seconds")?, "--lookback-seconds")?;
            }
            "--max-samples" => {
                max_samples = parse_usize(next_value(&mut args, "--max-samples")?, "--max-samples")?;
            }
            "--max-bytes" => {
                max_bytes = parse_usize(next_value(&mut args, "--max-bytes")?, "--max-bytes")?;
            }
            "--max-message-bytes" => {
                max_message_bytes =
                    parse_usize(next_value(&mut args, "--max-message-bytes")?, "--max-message-bytes")?;
            }
            "--include-messages" => include_messages = true,
            "--exit-on-incidents" => exit_on_incidents = true,
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            unknown => return Err(format!("unknown argument {unknown:?}; use --help")),
        }
    }

    Ok(Cli {
        app: app.ok_or_else(|| "--app is required".to_owned())?,
        root,
        lookback_seconds,
        max_samples,
        max_bytes,
        max_message_bytes,
        include_messages,
        exit_on_incidents,
    })
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn parse_u64(value: String, flag: &str) -> Result<u64, String> {
    value
        .parse()
        .map_err(|_| format!("{flag} requires an unsigned integer"))
}

fn parse_usize(value: String, flag: &str) -> Result<usize, String> {
    value
        .parse()
        .map_err(|_| format!("{flag} requires an unsigned integer"))
}

fn print_help() {
    println!(
        "ores-log-incidents\n\n\
         Scan recent private ORES JSONL journals without network I/O.\n\n\
         Usage:\n  ores-log-incidents --app <name> [options]\n\n\
         Options:\n\
           --app <name>                 App journal under $HOME/tmp/logs (required)\n\
           --root <path>                Override the journal root\n\
           --lookback-seconds <n>       Recent window to scan (default: 1200)\n\
           --max-samples <n>            Maximum unique incidents (default: 32)\n\
           --max-bytes <n>              Maximum JSON bundle bytes (default: 24576)\n\
           --max-message-bytes <n>      Maximum message prefix per incident (default: 2048)\n\
           --include-messages           Include bounded raw message prefixes (default: off)\n\
           --exit-on-incidents          Exit 10 when incidents are present; otherwise exit 0\n"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_requires_app_and_supports_bounded_controls() {
        let args = vec![
            "--app".to_owned(),
            "ores-compose".to_owned(),
            "--lookback-seconds".to_owned(),
            "60".to_owned(),
            "--max-samples".to_owned(),
            "4".to_owned(),
            "--exit-on-incidents".to_owned(),
        ];
        let mut iter = args.into_iter();
        let mut app = None;
        let mut lookback_seconds = 1200_u64;
        let mut max_samples = 32_usize;
        let mut exit_on_incidents = false;
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--app" => app = Some(next_value(&mut iter, "--app").expect("app")),
                "--lookback-seconds" => {
                    lookback_seconds =
                        parse_u64(next_value(&mut iter, "--lookback-seconds").expect("value"), "--lookback-seconds")
                            .expect("seconds");
                }
                "--max-samples" => {
                    max_samples =
                        parse_usize(next_value(&mut iter, "--max-samples").expect("value"), "--max-samples")
                            .expect("samples");
                }
                "--exit-on-incidents" => exit_on_incidents = true,
                other => panic!("unexpected {other}"),
            }
        }
        assert_eq!(app.as_deref(), Some("ores-compose"));
        assert_eq!(lookback_seconds, 60);
        assert_eq!(max_samples, 4);
        assert!(exit_on_incidents);
    }
}
