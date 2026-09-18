//! Contract-aligned APM primitives for process, filesystem, and latency signals.
//!
//! Resource samplers return immutable snapshots. Threshold evaluation is pure:
//! the same snapshot and thresholds always produce the same health report.
//! Latency histogram recording is the deliberate exception: bucket counters are
//! updated in place because this is expected to sit on request hot paths where
//! allocating a new bucket vector for every observation would distort the very
//! latency being measured.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[path = "apm_metrics.rs"]
mod metrics;

pub use metrics::{
    emit_latency_histogram, emit_resource_metrics, resource_metric_points, HistogramPoint,
    LatencyKind, MetricKind, MetricPoint, MetricSink, ATTR_CPU_MODE, ATTR_FILESYSTEM_MOUNTPOINT,
    ATTR_FILESYSTEM_STATE, ATTR_LATENCY_KIND, ATTR_PRESSURE_KIND, ATTR_PRESSURE_TARGET,
    METRIC_FILESYSTEM_USAGE, METRIC_FILESYSTEM_UTILIZATION, METRIC_LATENCY,
    METRIC_PROCESS_CPU_TIME, METRIC_PROCESS_MEMORY_USAGE, METRIC_PROCESS_MEMORY_VIRTUAL,
    METRIC_PROCESS_OPEN_FILE_DESCRIPTORS, METRIC_PROCESS_THREAD_COUNT, METRIC_RESOURCE_PRESSURE,
};

/// A sampled view of process resource usage.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProcessSnapshot {
    pub rss_bytes: Option<u64>,
    pub virtual_memory_bytes: Option<u64>,
    pub cpu_user_seconds: Option<f64>,
    pub cpu_system_seconds: Option<f64>,
    pub thread_count: Option<u64>,
    pub open_file_descriptors: Option<u64>,
}

/// A sampled view of one filesystem.
#[derive(Clone, Debug, PartialEq)]
pub struct FilesystemSnapshot {
    pub path: PathBuf,
    pub capacity_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
    pub free_ratio: f64,
    pub inode_total: u64,
    pub inode_free: u64,
    pub inode_free_ratio: Option<f64>,
}

/// One immutable resource observation suitable for conversion to metrics.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResourceSnapshot {
    pub process: ProcessSnapshot,
    pub filesystems: Vec<FilesystemSnapshot>,
}

/// Warning thresholds evaluated without performing I/O.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResourceThresholds {
    pub max_rss_bytes: Option<u64>,
    pub min_free_bytes: Option<u64>,
    pub min_free_ratio: Option<f64>,
    pub min_inode_free_ratio: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResourcePressureKind {
    ProcessRss,
    FilesystemFreeBytes,
    FilesystemFreeRatio,
    FilesystemInodeFreeRatio,
}

/// One evaluated threshold. `breached` is true when the observation crossed
/// the threshold; unbreached checks are kept so metrics can report recovery.
#[derive(Clone, Debug, PartialEq)]
pub struct ResourcePressure {
    pub kind: ResourcePressureKind,
    pub target: String,
    pub observed: f64,
    pub threshold: f64,
    pub breached: bool,
}

/// Every evaluable configured threshold, breached or not, in evaluation order
/// (process RSS, then per filesystem: free bytes, free ratio, inode free ratio).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResourceHealth {
    pub pressures: Vec<ResourcePressure>,
}

impl ResourceHealth {
    #[must_use]
    pub fn is_healthy(&self) -> bool {
        !self.pressures.iter().any(|pressure| pressure.breached)
    }

    /// Only the breached checks.
    pub fn breaches(&self) -> impl Iterator<Item = &ResourcePressure> {
        self.pressures.iter().filter(|pressure| pressure.breached)
    }
}

/// Purely evaluate a previously sampled resource snapshot.
///
/// Every configured threshold that can be evaluated yields one check. A ratio
/// threshold is not evaluable, and yields nothing, when its denominator is 0:
/// `min_free_ratio` needs `capacity_bytes > 0` and `min_inode_free_ratio`
/// needs `inode_free_ratio`. This matches the TypeScript and Dart SDKs and is
/// pinned by `tests/fixtures/ores-otel-apm-disk-pressure.json`.
#[must_use]
pub fn evaluate_resource_snapshot(
    snapshot: &ResourceSnapshot,
    thresholds: &ResourceThresholds,
) -> ResourceHealth {
    let mut pressures = Vec::new();

    if let (Some(observed), Some(threshold)) =
        (snapshot.process.rss_bytes, thresholds.max_rss_bytes)
    {
        pressures.push(ResourcePressure {
            kind: ResourcePressureKind::ProcessRss,
            target: "process".to_owned(),
            observed: observed as f64,
            threshold: threshold as f64,
            breached: observed > threshold,
        });
    }

    for filesystem in &snapshot.filesystems {
        let target = filesystem.path.to_string_lossy().into_owned();
        if let Some(threshold) = thresholds.min_free_bytes {
            pressures.push(ResourcePressure {
                kind: ResourcePressureKind::FilesystemFreeBytes,
                target: target.clone(),
                observed: filesystem.available_bytes as f64,
                threshold: threshold as f64,
                breached: filesystem.available_bytes < threshold,
            });
        }
        if let Some(threshold) = thresholds.min_free_ratio {
            if filesystem.capacity_bytes > 0 {
                pressures.push(ResourcePressure {
                    kind: ResourcePressureKind::FilesystemFreeRatio,
                    target: target.clone(),
                    observed: filesystem.free_ratio,
                    threshold,
                    breached: filesystem.free_ratio < threshold,
                });
            }
        }
        if let (Some(observed), Some(threshold)) =
            (filesystem.inode_free_ratio, thresholds.min_inode_free_ratio)
        {
            pressures.push(ResourcePressure {
                kind: ResourcePressureKind::FilesystemInodeFreeRatio,
                target,
                observed,
                threshold,
                breached: observed < threshold,
            });
        }
    }

    ResourceHealth { pressures }
}

/// Result plus elapsed wall-clock time, returned as a fresh value.
#[derive(Clone, Debug, PartialEq)]
pub struct Timed<T> {
    pub value: T,
    pub elapsed: Duration,
}

/// Measure a synchronous operation without exposing a mutable timer object.
pub fn measure<T>(operation: impl FnOnce() -> T) -> Timed<T> {
    let started = Instant::now();
    let value = operation();
    Timed {
        value,
        elapsed: started.elapsed(),
    }
}

/// Immutable histogram configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LatencyHistogramConfig {
    boundaries: Vec<Duration>,
}

impl LatencyHistogramConfig {
    pub fn new(boundaries: Vec<Duration>) -> Result<Self, ApmError> {
        if boundaries.is_empty() {
            return Err(ApmError::InvalidHistogram(
                "at least one histogram boundary is required".to_owned(),
            ));
        }
        if boundaries.iter().any(Duration::is_zero) {
            return Err(ApmError::InvalidHistogram(
                "histogram boundaries must be greater than zero".to_owned(),
            ));
        }
        if boundaries.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(ApmError::InvalidHistogram(
                "histogram boundaries must be strictly increasing".to_owned(),
            ));
        }
        Ok(Self { boundaries })
    }

    #[must_use]
    pub fn boundaries(&self) -> &[Duration] {
        &self.boundaries
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LatencyHistogramSnapshot {
    pub boundaries: Vec<Duration>,
    pub bucket_counts: Vec<u64>,
    pub count: u64,
    pub sum_nanos: u128,
    pub max: Option<Duration>,
}

/// Bounded in-memory latency accumulator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LatencyHistogram {
    config: LatencyHistogramConfig,
    bucket_counts: Vec<u64>,
    count: u64,
    sum_nanos: u128,
    max: Option<Duration>,
}

impl LatencyHistogram {
    #[must_use]
    pub fn new(config: LatencyHistogramConfig) -> Self {
        let bucket_counts = vec![0; config.boundaries.len() + 1];
        Self {
            config,
            bucket_counts,
            count: 0,
            sum_nanos: 0,
            max: None,
        }
    }

    /// Record one latency observation.
    ///
    /// ores-functional: allow-mutation reason="histogram recording is a request hot path; reusing bounded bucket storage avoids an allocation and full bucket copy per observation"
    pub fn record(&mut self, elapsed: Duration) {
        let index = self
            .config
            .boundaries
            .partition_point(|boundary| elapsed > *boundary);
        self.bucket_counts[index] = self.bucket_counts[index].saturating_add(1);
        self.count = self.count.saturating_add(1);
        self.sum_nanos = self.sum_nanos.saturating_add(elapsed.as_nanos());
        self.max = Some(self.max.map_or(elapsed, |current| current.max(elapsed)));
    }

    /// Ownership-transforming form for pipelines that prefer value flow.
    #[must_use]
    pub fn recorded(mut self, elapsed: Duration) -> Self {
        self.record(elapsed);
        self
    }

    #[must_use]
    pub fn snapshot(&self) -> LatencyHistogramSnapshot {
        LatencyHistogramSnapshot {
            boundaries: self.config.boundaries.clone(),
            bucket_counts: self.bucket_counts.clone(),
            count: self.count,
            sum_nanos: self.sum_nanos,
            max: self.max,
        }
    }
}

#[derive(Debug)]
pub enum ApmError {
    Io(std::io::Error),
    InvalidProcessData(String),
    InvalidHistogram(String),
    Unsupported(&'static str),
}

impl fmt::Display for ApmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "APM sampling I/O failed: {error}"),
            Self::InvalidProcessData(message) => {
                write!(formatter, "APM process data is invalid: {message}")
            }
            Self::InvalidHistogram(message) => {
                write!(formatter, "invalid latency histogram: {message}")
            }
            Self::Unsupported(message) => {
                write!(formatter, "APM sampler is unsupported: {message}")
            }
        }
    }
}

impl std::error::Error for ApmError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidProcessData(_) | Self::InvalidHistogram(_) | Self::Unsupported(_) => None,
        }
    }
}

impl From<std::io::Error> for ApmError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(all(target_os = "linux", feature = "apm"))]
pub fn sample_process() -> Result<ProcessSnapshot, ApmError> {
    let status = std::fs::read_to_string("/proc/self/status")?;
    let stat = std::fs::read_to_string("/proc/self/stat")?;
    let mut snapshot = parse_linux_proc_status(&status)?;
    let ticks = clock_ticks_per_second()?;
    let (user_seconds, system_seconds) = parse_linux_proc_stat_cpu(&stat, ticks)?;
    snapshot.cpu_user_seconds = Some(user_seconds);
    snapshot.cpu_system_seconds = Some(system_seconds);
    snapshot.open_file_descriptors = Some(count_open_file_descriptors()?);
    Ok(snapshot)
}

/// macOS sampler: `proc_pidinfo(PROC_PIDTASKINFO)` for resident/virtual memory
/// and thread count, `getrusage(RUSAGE_SELF)` for CPU time (already in
/// seconds, unlike Mach absolute-time task counters), and
/// `proc_pidinfo(PROC_PIDLISTFDS)` for open descriptors.
#[cfg(all(target_os = "macos", feature = "apm"))]
pub fn sample_process() -> Result<ProcessSnapshot, ApmError> {
    let pid = libc::c_int::try_from(std::process::id())
        .map_err(|_| ApmError::InvalidProcessData("process id does not fit c_int".to_owned()))?;
    let task = macos_task_info(pid)?;
    let (user_seconds, system_seconds) = macos_rusage_cpu_seconds()?;
    Ok(ProcessSnapshot {
        rss_bytes: Some(task.pti_resident_size),
        virtual_memory_bytes: Some(task.pti_virtual_size),
        cpu_user_seconds: Some(user_seconds),
        cpu_system_seconds: Some(system_seconds),
        thread_count: u64::try_from(task.pti_threadnum).ok(),
        open_file_descriptors: Some(macos_open_file_descriptors(pid)?),
    })
}

#[cfg(all(target_os = "macos", feature = "apm"))]
fn macos_task_info(pid: libc::c_int) -> Result<libc::proc_taskinfo, ApmError> {
    use std::mem::{size_of, MaybeUninit};

    let size = size_of::<libc::proc_taskinfo>();
    let size_c = libc::c_int::try_from(size)
        .map_err(|_| ApmError::InvalidProcessData("proc_taskinfo size overflow".to_owned()))?;
    let mut raw = MaybeUninit::<libc::proc_taskinfo>::uninit();
    // SAFETY: `raw` is writable storage of exactly `size_c` bytes for one
    // proc_taskinfo, which is what PROC_PIDTASKINFO fills.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            raw.as_mut_ptr().cast::<libc::c_void>(),
            size_c,
        )
    };
    if written <= 0 {
        return Err(ApmError::Io(std::io::Error::last_os_error()));
    }
    if written != size_c {
        return Err(ApmError::InvalidProcessData(
            "proc_pidinfo returned a truncated task info".to_owned(),
        ));
    }
    // SAFETY: the kernel reported writing the full structure above.
    Ok(unsafe { raw.assume_init() })
}

#[cfg(all(target_os = "macos", feature = "apm"))]
fn macos_rusage_cpu_seconds() -> Result<(f64, f64), ApmError> {
    use std::mem::MaybeUninit;

    let mut raw = MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: `raw` points to valid writable storage for one rusage value.
    let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, raw.as_mut_ptr()) };
    if status != 0 {
        return Err(ApmError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: a zero getrusage return initialized the output object above.
    let usage = unsafe { raw.assume_init() };
    let seconds = |time: libc::timeval| time.tv_sec as f64 + f64::from(time.tv_usec) / 1e6;
    Ok((seconds(usage.ru_utime), seconds(usage.ru_stime)))
}

#[cfg(all(target_os = "macos", feature = "apm"))]
fn macos_open_file_descriptors(pid: libc::c_int) -> Result<u64, ApmError> {
    use std::mem::size_of;

    let entry = size_of::<libc::proc_fdinfo>();
    // SAFETY: a null buffer with zero size asks only for the required size.
    let needed =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Err(ApmError::Io(std::io::Error::last_os_error()));
    }
    // Headroom for descriptors opened between the two calls.
    let capacity = usize::try_from(needed).unwrap_or(0) / entry + 32;
    let buffer = vec![
        libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0,
        };
        capacity
    ];
    let bytes = libc::c_int::try_from(capacity * entry)
        .map_err(|_| ApmError::InvalidProcessData("fd buffer size overflow".to_owned()))?;
    // HOT-PATH (imperative by design): the kernel writes descriptor entries
    // into a caller-provided buffer, so a fresh value per entry is impossible;
    // the mutation is confined to this local vector and callers receive only
    // the immutable count.
    let mut buffer = buffer;
    // SAFETY: `buffer` holds `capacity` initialized entries, exactly `bytes`
    // bytes of writable storage.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            buffer.as_mut_ptr().cast::<libc::c_void>(),
            bytes,
        )
    };
    if written < 0 {
        return Err(ApmError::Io(std::io::Error::last_os_error()));
    }
    u64::try_from(usize::try_from(written).unwrap_or(0) / entry).map_err(|_| {
        ApmError::InvalidProcessData("open file descriptor count does not fit u64".to_owned())
    })
}

#[cfg(not(any(
    all(target_os = "linux", feature = "apm"),
    all(target_os = "macos", feature = "apm")
)))]
pub fn sample_process() -> Result<ProcessSnapshot, ApmError> {
    Err(ApmError::Unsupported(
        "process sampling currently requires Linux or macOS and the `apm` feature",
    ))
}

#[cfg(all(unix, feature = "apm"))]
pub fn sample_filesystem(path: impl AsRef<Path>) -> Result<FilesystemSnapshot, ApmError> {
    use std::ffi::CString;
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt as _;

    let path = path.as_ref();
    let encoded = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        ApmError::InvalidProcessData("filesystem path contains an interior NUL byte".to_owned())
    })?;
    let mut raw = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `encoded` is a live NUL-terminated path and `raw` points to valid
    // writable storage for exactly one libc::statvfs value.
    let status = unsafe { libc::statvfs(encoded.as_ptr(), raw.as_mut_ptr()) };
    if status != 0 {
        return Err(ApmError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: a zero statvfs return initialized the output object above.
    let raw = unsafe { raw.assume_init() };

    let fragment_size = if raw.f_frsize == 0 {
        raw.f_bsize
    } else {
        raw.f_frsize
    };
    let block_bytes = u128::from(fragment_size);
    let capacity_bytes = bounded_u64(u128::from(raw.f_blocks).saturating_mul(block_bytes));
    let free_bytes = bounded_u64(u128::from(raw.f_bfree).saturating_mul(block_bytes));
    let available_bytes = bounded_u64(u128::from(raw.f_bavail).saturating_mul(block_bytes));
    let free_ratio = ratio(available_bytes, capacity_bytes).unwrap_or(0.0);
    let inode_total = bounded_u64(u128::from(raw.f_files));
    let inode_free = bounded_u64(u128::from(raw.f_favail));
    let inode_free_ratio = ratio(inode_free, inode_total);

    Ok(FilesystemSnapshot {
        path: path.to_path_buf(),
        capacity_bytes,
        free_bytes,
        available_bytes,
        free_ratio,
        inode_total,
        inode_free,
        inode_free_ratio,
    })
}

#[cfg(not(all(unix, feature = "apm")))]
pub fn sample_filesystem(path: impl AsRef<Path>) -> Result<FilesystemSnapshot, ApmError> {
    let _ = path;
    Err(ApmError::Unsupported(
        "filesystem sampling currently requires Unix and the `apm` feature",
    ))
}

pub fn sample_resources<P>(paths: impl IntoIterator<Item = P>) -> Result<ResourceSnapshot, ApmError>
where
    P: AsRef<Path>,
{
    let process = sample_process()?;
    let filesystems = paths
        .into_iter()
        .map(sample_filesystem)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ResourceSnapshot {
        process,
        filesystems,
    })
}

#[cfg(all(target_os = "linux", feature = "apm"))]
fn parse_linux_proc_status(status: &str) -> Result<ProcessSnapshot, ApmError> {
    let rss_bytes = parse_status_kib(status, "VmRSS:")?;
    let virtual_memory_bytes = parse_status_kib(status, "VmSize:")?;
    let thread_count = parse_status_integer(status, "Threads:")?;
    Ok(ProcessSnapshot {
        rss_bytes,
        virtual_memory_bytes,
        thread_count,
        ..ProcessSnapshot::default()
    })
}

#[cfg(all(target_os = "linux", feature = "apm"))]
fn parse_status_kib(status: &str, key: &str) -> Result<Option<u64>, ApmError> {
    let Some(line) = status.lines().find(|line| line.starts_with(key)) else {
        return Ok(None);
    };
    let raw = line[key.len()..]
        .split_whitespace()
        .next()
        .ok_or_else(|| ApmError::InvalidProcessData(format!("{key} has no value")))?;
    let kib = raw
        .parse::<u64>()
        .map_err(|_| ApmError::InvalidProcessData(format!("{key} is not an integer")))?;
    Ok(Some(kib.saturating_mul(1024)))
}

#[cfg(all(target_os = "linux", feature = "apm"))]
fn parse_status_integer(status: &str, key: &str) -> Result<Option<u64>, ApmError> {
    let Some(line) = status.lines().find(|line| line.starts_with(key)) else {
        return Ok(None);
    };
    let raw = line[key.len()..]
        .split_whitespace()
        .next()
        .ok_or_else(|| ApmError::InvalidProcessData(format!("{key} has no value")))?;
    raw.parse::<u64>()
        .map(Some)
        .map_err(|_| ApmError::InvalidProcessData(format!("{key} is not an integer")))
}

#[cfg(all(target_os = "linux", feature = "apm"))]
fn parse_linux_proc_stat_cpu(stat: &str, ticks_per_second: u64) -> Result<(f64, f64), ApmError> {
    if ticks_per_second == 0 {
        return Err(ApmError::InvalidProcessData(
            "clock tick rate must be non-zero".to_owned(),
        ));
    }
    let close = stat.rfind(')').ok_or_else(|| {
        ApmError::InvalidProcessData("/proc/self/stat command terminator is missing".to_owned())
    })?;
    let fields = stat[close + 1..].split_whitespace().collect::<Vec<_>>();
    if fields.len() <= 12 {
        return Err(ApmError::InvalidProcessData(
            "/proc/self/stat has too few fields".to_owned(),
        ));
    }
    let user_ticks = fields[11]
        .parse::<u64>()
        .map_err(|_| ApmError::InvalidProcessData("user CPU ticks are invalid".to_owned()))?;
    let system_ticks = fields[12]
        .parse::<u64>()
        .map_err(|_| ApmError::InvalidProcessData("system CPU ticks are invalid".to_owned()))?;
    let ticks = ticks_per_second as f64;
    Ok((user_ticks as f64 / ticks, system_ticks as f64 / ticks))
}

#[cfg(all(target_os = "linux", feature = "apm"))]
fn clock_ticks_per_second() -> Result<u64, ApmError> {
    // SAFETY: sysconf has no pointer arguments and `_SC_CLK_TCK` is a read-only
    // process/runtime query.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks <= 0 {
        return Err(ApmError::Io(std::io::Error::last_os_error()));
    }
    u64::try_from(ticks)
        .map_err(|_| ApmError::InvalidProcessData("clock tick rate does not fit u64".to_owned()))
}

#[cfg(all(target_os = "linux", feature = "apm"))]
fn count_open_file_descriptors() -> Result<u64, ApmError> {
    let count = std::fs::read_dir("/proc/self/fd")?
        .filter_map(Result::ok)
        .count();
    u64::try_from(count).map_err(|_| {
        ApmError::InvalidProcessData("open file descriptor count does not fit u64".to_owned())
    })
}

#[cfg(all(unix, feature = "apm"))]
fn bounded_u64(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(all(unix, feature = "apm"))]
fn ratio(part: u64, whole: u64) -> Option<f64> {
    (whole != 0).then(|| part as f64 / whole as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_returns_value_and_elapsed_time() {
        let timed = measure(|| 42_u8);
        assert_eq!(timed.value, 42);
    }

    #[test]
    fn histogram_rejects_non_monotonic_boundaries() {
        let error =
            LatencyHistogramConfig::new(vec![Duration::from_millis(10), Duration::from_millis(5)])
                .expect_err("descending boundaries must fail");
        assert!(error.to_string().contains("strictly increasing"));
    }

    #[test]
    fn histogram_tracks_buckets_without_allocating_per_record() {
        let config = LatencyHistogramConfig::new(vec![
            Duration::from_millis(10),
            Duration::from_millis(100),
        ])
        .expect("valid boundaries");
        let histogram = LatencyHistogram::new(config)
            .recorded(Duration::from_millis(5))
            .recorded(Duration::from_millis(50))
            .recorded(Duration::from_millis(150));
        let snapshot = histogram.snapshot();
        assert_eq!(snapshot.bucket_counts, vec![1, 1, 1]);
        assert_eq!(snapshot.count, 3);
        assert_eq!(snapshot.max, Some(Duration::from_millis(150)));
    }

    #[test]
    fn resource_thresholds_return_new_pressure_report() {
        let snapshot = ResourceSnapshot {
            process: ProcessSnapshot {
                rss_bytes: Some(512),
                ..ProcessSnapshot::default()
            },
            filesystems: vec![FilesystemSnapshot {
                path: PathBuf::from("/data"),
                capacity_bytes: 1_000,
                free_bytes: 100,
                available_bytes: 50,
                free_ratio: 0.05,
                inode_total: 100,
                inode_free: 4,
                inode_free_ratio: Some(0.04),
            }],
        };
        let health = evaluate_resource_snapshot(
            &snapshot,
            &ResourceThresholds {
                max_rss_bytes: Some(500),
                min_free_bytes: Some(100),
                min_free_ratio: Some(0.1),
                min_inode_free_ratio: Some(0.05),
            },
        );
        assert_eq!(health.pressures.len(), 4);
        assert!(health.pressures.iter().all(|pressure| pressure.breached));
        assert_eq!(health.breaches().count(), 4);
        assert!(!health.is_healthy());

        let recovered = evaluate_resource_snapshot(
            &snapshot,
            &ResourceThresholds {
                max_rss_bytes: Some(1_024),
                min_free_bytes: Some(10),
                min_free_ratio: Some(0.01),
                min_inode_free_ratio: Some(0.01),
            },
        );
        assert_eq!(
            recovered.pressures.len(),
            4,
            "unbreached thresholds are still reported"
        );
        assert!(recovered.is_healthy());
    }

    #[cfg(all(target_os = "linux", feature = "apm"))]
    #[test]
    fn linux_proc_status_parser_is_bounded_and_unit_aware() {
        let parsed = parse_linux_proc_status("VmSize:\t100 kB\nVmRSS:\t25 kB\nThreads:\t7\n")
            .expect("valid status");
        assert_eq!(parsed.virtual_memory_bytes, Some(102_400));
        assert_eq!(parsed.rss_bytes, Some(25_600));
        assert_eq!(parsed.thread_count, Some(7));
    }

    #[cfg(all(target_os = "linux", feature = "apm"))]
    #[test]
    fn linux_proc_stat_parser_handles_spaces_in_process_name() {
        let stat = "123 (worker name) R 1 2 3 4 5 6 7 8 9 10 200 100 0 0";
        let (user, system) = parse_linux_proc_stat_cpu(stat, 100).expect("valid stat");
        assert_eq!(user, 2.0);
        assert_eq!(system, 1.0);
    }

    #[cfg(all(target_os = "linux", feature = "apm"))]
    #[test]
    fn live_process_sampler_reports_memory_threads_and_fds() {
        let snapshot = sample_process().expect("sample current process");
        assert!(snapshot.rss_bytes.is_some_and(|value| value > 0));
        assert!(snapshot.virtual_memory_bytes.is_some_and(|value| value > 0));
        assert!(snapshot.thread_count.is_some_and(|value| value > 0));
        assert!(snapshot
            .open_file_descriptors
            .is_some_and(|value| value > 0));
    }

    #[cfg(all(target_os = "macos", feature = "apm"))]
    #[test]
    fn live_macos_process_sampler_reports_memory_cpu_threads_and_fds() {
        let snapshot = sample_process().expect("sample current process");
        assert!(snapshot.rss_bytes.is_some_and(|value| value > 0));
        assert!(snapshot.virtual_memory_bytes.is_some_and(|value| value > 0));
        assert!(snapshot.thread_count.is_some_and(|value| value > 0));
        assert!(snapshot.cpu_user_seconds.is_some_and(|value| value >= 0.0));
        assert!(snapshot
            .cpu_system_seconds
            .is_some_and(|value| value >= 0.0));
        assert!(snapshot
            .open_file_descriptors
            .is_some_and(|value| value >= 3));
    }

    #[cfg(all(unix, feature = "apm"))]
    #[test]
    fn live_filesystem_sampler_reports_capacity() {
        let snapshot = sample_filesystem("/").expect("sample root filesystem");
        assert!(snapshot.capacity_bytes > 0);
        assert!(snapshot.free_ratio >= 0.0 && snapshot.free_ratio <= 1.0);
    }
}
