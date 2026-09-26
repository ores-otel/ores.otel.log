use next_loggers::desktop::DesktopSession;
use next_loggers::{LogRecord, LoggerError, MemoryTransport, Transport};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn lifetime_emits_two_records_without_stdout_console_or_credentials() {
    let transport = Arc::new(MemoryTransport::default());
    {
        let _session = DesktopSession::with_transport("native-app", "1.2.3", transport.clone())
            .expect("start");
        assert_eq!(transport.records().len(), 1);
        assert!(!transport.is_closed());
    }
    let records = transport.records();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].message, "desktop.starting");
    assert_eq!(records[1].message, "desktop.stopped");
    assert_eq!(records[0].app_name, "native-app");
    assert_eq!(records[0].runtime, "rust");
    assert_eq!(records[0].fields.len(), 1);
    assert_eq!(records[0].fields["app_version"], "1.2.3");
    assert!(records[0].logged_in_user.is_none());
    assert!(transport.is_closed());
}

#[test]
fn explicit_finish_does_not_emit_a_second_stop_on_drop() {
    let transport = Arc::new(MemoryTransport::default());
    let session = DesktopSession::with_transport("native-app", "1", transport.clone())
        .expect("start");
    session.finish().expect("finish");
    assert_eq!(transport.records().len(), 2);
    assert_eq!(transport.flush_count(), 1);
}

struct FailingTransport {
    writes: AtomicUsize,
    closes: AtomicUsize,
    fail_at: usize,
}

impl Transport for FailingTransport {
    fn write(&self, _record: &LogRecord) -> Result<(), LoggerError> {
        let count = self.writes.fetch_add(1, Ordering::SeqCst);
        if count == self.fail_at {
            return Err(LoggerError("delivery failed".to_owned()));
        }
        return Ok(());
    }

    fn close(&self) -> Result<(), LoggerError> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        return Ok(());
    }
}

#[test]
fn failed_start_closes_transport_and_returns_error() {
    let transport = Arc::new(FailingTransport {
        writes: AtomicUsize::new(0),
        closes: AtomicUsize::new(0),
        fail_at: 0,
    });
    assert!(DesktopSession::with_transport("native-app", "1", transport.clone()).is_err());
    assert_eq!(transport.closes.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_stop_still_closes_once_and_returns_error() {
    let transport = Arc::new(FailingTransport {
        writes: AtomicUsize::new(0),
        closes: AtomicUsize::new(0),
        fail_at: 1,
    });
    let session = DesktopSession::with_transport("native-app", "1", transport.clone())
        .expect("start");
    assert!(session.finish().is_err());
    assert_eq!(transport.closes.load(Ordering::SeqCst), 1);
    assert_eq!(transport.writes.load(Ordering::SeqCst), 2);
}

#[test]
fn unwinding_is_not_reported_as_normal_shutdown() {
    let transport = Arc::new(MemoryTransport::default());
    let captured = transport.clone();
    let result = std::panic::catch_unwind(move || {
        let _session = DesktopSession::with_transport("native-app", "1", captured)
            .expect("start");
        panic!("test unwind");
    });
    assert!(result.is_err());
    assert_eq!(transport.records()[1].message, "desktop.unwinding");
    assert!(transport.is_closed());
}
