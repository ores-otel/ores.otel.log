//! Pure conversion of APM snapshots into OpenTelemetry semantic-convention
//! metric points.
//!
//! Nothing here performs I/O or depends on `opentelemetry`: applications plug
//! their own meter in through [`MetricSink`]. Available without the `apm`
//! feature because it only transforms values.

use super::{
    ApmError, FilesystemSnapshot, LatencyHistogramConfig, LatencyHistogramSnapshot,
    ProcessSnapshot, ResourceHealth, ResourcePressure, ResourcePressureKind, ResourceSnapshot,
    ResourceThresholds,
};
use crate::config::ResolvedMetrics;
use std::time::Duration;

pub const METRIC_PROCESS_MEMORY_USAGE: &str = "process.memory.usage";
pub const METRIC_PROCESS_MEMORY_VIRTUAL: &str = "process.memory.virtual";
pub const METRIC_PROCESS_CPU_TIME: &str = "process.cpu.time";
pub const METRIC_PROCESS_THREAD_COUNT: &str = "process.thread.count";
pub const METRIC_PROCESS_OPEN_FILE_DESCRIPTORS: &str = "process.open_file_descriptor.count";
pub const METRIC_FILESYSTEM_USAGE: &str = "system.filesystem.usage";
pub const METRIC_FILESYSTEM_UTILIZATION: &str = "system.filesystem.utilization";
pub const METRIC_RESOURCE_PRESSURE: &str = "ores.apm.resource.pressure";
pub const METRIC_LATENCY: &str = "ores.apm.latency";

pub const ATTR_CPU_MODE: &str = "cpu.mode";
pub const ATTR_FILESYSTEM_STATE: &str = "system.filesystem.state";
pub const ATTR_FILESYSTEM_MOUNTPOINT: &str = "system.filesystem.mountpoint";
pub const ATTR_PRESSURE_KIND: &str = "ores.apm.pressure.kind";
pub const ATTR_PRESSURE_TARGET: &str = "ores.apm.pressure.target";
pub const ATTR_LATENCY_KIND: &str = "ores.apm.latency.kind";

/// Instrument shape for a scalar point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetricKind {
    /// Last observed value.
    Gauge,
    /// Cumulative, monotonically increasing total since process start.
    Counter,
}

/// One scalar observation ready to hand to a meter.
#[derive(Clone, Debug, PartialEq)]
pub struct MetricPoint {
    pub name: &'static str,
    pub unit: &'static str,
    pub kind: MetricKind,
    pub value: f64,
    pub attributes: Vec<(&'static str, String)>,
}

/// Which latency a histogram describes (`ores.apm.latency.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LatencyKind {
    Request,
    Operation,
    QueueWait,
}

impl LatencyKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Operation => "operation",
            Self::QueueWait => "queue_wait",
        }
    }
}

/// An OTel explicit-bucket histogram data point in milliseconds.
/// `bucket_counts` has `boundaries_ms.len() + 1` entries.
#[derive(Clone, Debug, PartialEq)]
pub struct HistogramPoint {
    pub name: &'static str,
    pub unit: &'static str,
    pub boundaries_ms: Vec<f64>,
    pub bucket_counts: Vec<u64>,
    pub count: u64,
    pub sum_ms: f64,
    pub max_ms: Option<f64>,
    pub attributes: Vec<(&'static str, String)>,
}

impl ResourcePressureKind {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ProcessRss => "process_rss",
            Self::FilesystemFreeBytes => "filesystem_free_bytes",
            Self::FilesystemFreeRatio => "filesystem_free_ratio",
            Self::FilesystemInodeFreeRatio => "filesystem_inode_free_ratio",
        }
    }
}

fn gauge(
    name: &'static str,
    unit: &'static str,
    value: f64,
    attributes: Vec<(&'static str, String)>,
) -> MetricPoint {
    MetricPoint {
        name,
        unit,
        kind: MetricKind::Gauge,
        value,
        attributes,
    }
}

fn process_points(process: &ProcessSnapshot) -> impl Iterator<Item = MetricPoint> {
    let cpu = |mode: &str, seconds: f64| MetricPoint {
        name: METRIC_PROCESS_CPU_TIME,
        unit: "s",
        kind: MetricKind::Counter,
        value: seconds,
        attributes: vec![(ATTR_CPU_MODE, mode.to_owned())],
    };
    [
        process
            .rss_bytes
            .map(|bytes| gauge(METRIC_PROCESS_MEMORY_USAGE, "By", bytes as f64, Vec::new())),
        process.virtual_memory_bytes.map(|bytes| {
            gauge(
                METRIC_PROCESS_MEMORY_VIRTUAL,
                "By",
                bytes as f64,
                Vec::new(),
            )
        }),
        process.cpu_user_seconds.map(|seconds| cpu("user", seconds)),
        process
            .cpu_system_seconds
            .map(|seconds| cpu("system", seconds)),
        process.thread_count.map(|count| {
            gauge(
                METRIC_PROCESS_THREAD_COUNT,
                "{thread}",
                count as f64,
                Vec::new(),
            )
        }),
        process.open_file_descriptors.map(|count| {
            gauge(
                METRIC_PROCESS_OPEN_FILE_DESCRIPTORS,
                "{file_descriptor}",
                count as f64,
                Vec::new(),
            )
        }),
    ]
    .into_iter()
    .flatten()
}

/// `used = capacity - free`, `free = available to unprivileged users`,
/// `reserved = free - available` (blocks only root may use).
fn filesystem_points(filesystem: &FilesystemSnapshot) -> impl Iterator<Item = MetricPoint> {
    let mountpoint = filesystem.path.to_string_lossy().into_owned();
    let used = filesystem
        .capacity_bytes
        .saturating_sub(filesystem.free_bytes);
    let reserved = filesystem
        .free_bytes
        .saturating_sub(filesystem.available_bytes);
    let usage = |state: &str, bytes: u64| {
        gauge(
            METRIC_FILESYSTEM_USAGE,
            "By",
            bytes as f64,
            vec![
                (ATTR_FILESYSTEM_STATE, state.to_owned()),
                (ATTR_FILESYSTEM_MOUNTPOINT, mountpoint.clone()),
            ],
        )
    };
    let utilization = (filesystem.capacity_bytes > 0).then(|| {
        gauge(
            METRIC_FILESYSTEM_UTILIZATION,
            "1",
            used as f64 / filesystem.capacity_bytes as f64,
            vec![(ATTR_FILESYSTEM_MOUNTPOINT, mountpoint.clone())],
        )
    });
    [
        Some(usage("used", used)),
        Some(usage("free", filesystem.available_bytes)),
        Some(usage("reserved", reserved)),
        utilization,
    ]
    .into_iter()
    .flatten()
}

fn pressure_point(pressure: &ResourcePressure) -> MetricPoint {
    gauge(
        METRIC_RESOURCE_PRESSURE,
        "1",
        1.0,
        vec![
            (ATTR_PRESSURE_KIND, pressure.kind.as_str().to_owned()),
            (ATTR_PRESSURE_TARGET, pressure.target.clone()),
        ],
    )
}

/// Converts one resource observation into semantic-convention points.
///
/// Absent process fields produce no point. Each breached threshold in `health`
/// produces one `ores.apm.resource.pressure` gauge with value `1`; a threshold
/// that is not breached produces nothing.
#[must_use]
pub fn resource_metric_points(
    snapshot: &ResourceSnapshot,
    health: &ResourceHealth,
) -> Vec<MetricPoint> {
    process_points(&snapshot.process)
        .chain(snapshot.filesystems.iter().flat_map(filesystem_points))
        .chain(health.pressures.iter().map(pressure_point))
        .collect()
}

fn duration_ms(duration: Duration) -> f64 {
    duration.as_nanos() as f64 / 1_000_000.0
}

impl LatencyHistogramSnapshot {
    /// The snapshot as an `ores.apm.latency` histogram point in milliseconds.
    #[must_use]
    pub fn metric_point(&self, kind: LatencyKind) -> HistogramPoint {
        HistogramPoint {
            name: METRIC_LATENCY,
            unit: "ms",
            boundaries_ms: self.boundaries.iter().copied().map(duration_ms).collect(),
            bucket_counts: self.bucket_counts.clone(),
            count: self.count,
            sum_ms: self.sum_nanos as f64 / 1_000_000.0,
            max_ms: self.max.map(duration_ms),
            attributes: vec![(ATTR_LATENCY_KIND, kind.as_str().to_owned())],
        }
    }
}

impl ResourceThresholds {
    /// Filesystem thresholds from resolved configuration. `max_rss_bytes` has
    /// no v1 configuration key and stays unset.
    #[must_use]
    pub fn from_resolved(metrics: &ResolvedMetrics) -> Self {
        Self {
            max_rss_bytes: None,
            min_free_bytes: metrics.filesystem.min_free_bytes,
            min_free_ratio: metrics.filesystem.min_free_ratio,
            min_inode_free_ratio: metrics.filesystem.min_inode_free_ratio,
        }
    }
}

impl LatencyHistogramConfig {
    /// Histogram configuration from resolved `histogram_boundaries_ms`, rounded
    /// to the nearest nanosecond.
    pub fn from_resolved(metrics: &ResolvedMetrics) -> Result<Self, ApmError> {
        metrics
            .latency
            .histogram_boundaries_ms
            .iter()
            .map(|ms| {
                let nanos = (ms * 1_000_000.0).round();
                (nanos.is_finite() && nanos >= 0.0 && nanos <= u64::MAX as f64)
                    .then(|| Duration::from_nanos(nanos as u64))
                    .ok_or_else(|| {
                        ApmError::InvalidHistogram(format!(
                            "histogram boundary {ms} ms is not representable"
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()
            .and_then(Self::new)
    }
}

/// Destination for metric points, typically an adapter over an application's
/// OpenTelemetry `Meter`. Histograms are optional: the default ignores them.
pub trait MetricSink {
    fn record(&self, point: &MetricPoint);

    fn record_histogram(&self, point: &HistogramPoint) {
        let _ = point;
    }
}

impl<F> MetricSink for F
where
    F: Fn(&MetricPoint),
{
    fn record(&self, point: &MetricPoint) {
        self(point);
    }
}

/// Converts and records resource points; returns how many were recorded.
pub fn emit_resource_metrics<S>(
    sink: &S,
    snapshot: &ResourceSnapshot,
    health: &ResourceHealth,
) -> usize
where
    S: MetricSink + ?Sized,
{
    let points = resource_metric_points(snapshot, health);
    points.iter().for_each(|point| sink.record(point));
    points.len()
}

/// Converts and records one latency histogram.
pub fn emit_latency_histogram<S>(sink: &S, snapshot: &LatencyHistogramSnapshot, kind: LatencyKind)
where
    S: MetricSink + ?Sized,
{
    sink.record_histogram(&snapshot.metric_point(kind));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apm::{evaluate_resource_snapshot, LatencyHistogram};
    use crate::config::{
        parse_ores_otel_toml, resolve_ores_otel_config, ResolveOptions, RuntimeRole,
    };
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn snapshot() -> ResourceSnapshot {
        ResourceSnapshot {
            process: ProcessSnapshot {
                rss_bytes: Some(2048),
                virtual_memory_bytes: Some(4096),
                cpu_user_seconds: Some(1.5),
                cpu_system_seconds: Some(0.25),
                thread_count: Some(4),
                open_file_descriptors: Some(9),
            },
            filesystems: vec![FilesystemSnapshot {
                path: PathBuf::from("/data"),
                capacity_bytes: 1_000,
                free_bytes: 300,
                available_bytes: 200,
                free_ratio: 0.2,
                inode_total: 10,
                inode_free: 5,
                inode_free_ratio: Some(0.5),
            }],
        }
    }

    fn find<'a>(
        points: &'a [MetricPoint],
        name: &str,
        attribute: Option<(&str, &str)>,
    ) -> &'a MetricPoint {
        points
            .iter()
            .find(|point| {
                point.name == name
                    && attribute.is_none_or(|(key, value)| {
                        point
                            .attributes
                            .iter()
                            .any(|(k, v)| *k == key && v == value)
                    })
            })
            .unwrap_or_else(|| panic!("missing {name} {attribute:?}"))
    }

    #[test]
    fn resource_points_follow_semantic_conventions() {
        let points = resource_metric_points(&snapshot(), &ResourceHealth::default());
        assert_eq!(points.len(), 10);

        let rss = find(&points, METRIC_PROCESS_MEMORY_USAGE, None);
        assert_eq!(
            (rss.unit, rss.kind, rss.value),
            ("By", MetricKind::Gauge, 2048.0)
        );
        assert_eq!(
            find(&points, METRIC_PROCESS_MEMORY_VIRTUAL, None).value,
            4096.0
        );

        let user = find(
            &points,
            METRIC_PROCESS_CPU_TIME,
            Some((ATTR_CPU_MODE, "user")),
        );
        assert_eq!(
            (user.unit, user.kind, user.value),
            ("s", MetricKind::Counter, 1.5)
        );
        assert_eq!(
            find(
                &points,
                METRIC_PROCESS_CPU_TIME,
                Some((ATTR_CPU_MODE, "system"))
            )
            .value,
            0.25
        );
        assert_eq!(
            find(&points, METRIC_PROCESS_THREAD_COUNT, None).unit,
            "{thread}"
        );
        assert_eq!(
            find(&points, METRIC_PROCESS_OPEN_FILE_DESCRIPTORS, None).unit,
            "{file_descriptor}"
        );

        let state = |value| Some((ATTR_FILESYSTEM_STATE, value));
        assert_eq!(
            find(&points, METRIC_FILESYSTEM_USAGE, state("used")).value,
            700.0
        );
        assert_eq!(
            find(&points, METRIC_FILESYSTEM_USAGE, state("free")).value,
            200.0
        );
        let reserved = find(&points, METRIC_FILESYSTEM_USAGE, state("reserved"));
        assert_eq!(reserved.value, 100.0);
        assert!(reserved
            .attributes
            .contains(&(ATTR_FILESYSTEM_MOUNTPOINT, "/data".to_owned())));
        let utilization = find(&points, METRIC_FILESYSTEM_UTILIZATION, None);
        assert_eq!((utilization.unit, utilization.value), ("1", 0.7));
    }

    #[test]
    fn empty_process_and_zero_capacity_emit_no_undefined_points() {
        let snapshot = ResourceSnapshot {
            process: ProcessSnapshot::default(),
            filesystems: vec![FilesystemSnapshot {
                path: PathBuf::from("/empty"),
                capacity_bytes: 0,
                free_bytes: 0,
                available_bytes: 0,
                free_ratio: 0.0,
                inode_total: 0,
                inode_free: 0,
                inode_free_ratio: None,
            }],
        };
        let points = resource_metric_points(&snapshot, &ResourceHealth::default());
        assert_eq!(points.len(), 3);
        assert!(points
            .iter()
            .all(|point| point.name == METRIC_FILESYSTEM_USAGE));
    }

    #[test]
    fn pressures_become_breach_gauges() {
        let thresholds = ResourceThresholds {
            min_free_bytes: Some(500),
            min_free_ratio: Some(0.5),
            ..ResourceThresholds::default()
        };
        let health = evaluate_resource_snapshot(&snapshot(), &thresholds);
        let points = resource_metric_points(&snapshot(), &health);
        let pressures = points
            .iter()
            .filter(|point| point.name == METRIC_RESOURCE_PRESSURE)
            .collect::<Vec<_>>();
        assert_eq!(pressures.len(), 2);
        assert!(pressures.iter().all(|point| point.value == 1.0));
        assert!(pressures[0]
            .attributes
            .contains(&(ATTR_PRESSURE_KIND, "filesystem_free_bytes".to_owned())));
        assert!(pressures[0]
            .attributes
            .contains(&(ATTR_PRESSURE_TARGET, "/data".to_owned())));
    }

    #[test]
    fn latency_snapshot_exports_millisecond_histogram() {
        let config = LatencyHistogramConfig::new(vec![
            Duration::from_micros(50_500),
            Duration::from_millis(100),
        ])
        .expect("valid");
        let snapshot = LatencyHistogram::new(config)
            .recorded(Duration::from_millis(10))
            .recorded(Duration::from_micros(75_250))
            .recorded(Duration::from_millis(400))
            .snapshot();
        let point = snapshot.metric_point(LatencyKind::QueueWait);
        assert_eq!(point.name, METRIC_LATENCY);
        assert_eq!(point.unit, "ms");
        assert_eq!(point.boundaries_ms, vec![50.5, 100.0]);
        assert_eq!(point.bucket_counts, vec![1, 1, 1]);
        assert_eq!(point.count, 3);
        assert_eq!(point.sum_ms, 485.25);
        assert_eq!(point.max_ms, Some(400.0));
        assert_eq!(
            point.attributes,
            vec![(ATTR_LATENCY_KIND, "queue_wait".to_owned())]
        );
    }

    #[test]
    fn resolved_config_bridges_to_apm_types() {
        let parsed = parse_ores_otel_toml(
            "version = 1\n[server.metrics.filesystem]\nmin_free_bytes = 1024\nmin_inode_free_ratio = 0.05\n[server.metrics.latency]\nhistogram_boundaries_ms = [0.5, 50.5, 1000]\n",
        )
        .expect("valid");
        let resolved = resolve_ores_otel_config(
            &parsed,
            &ResolveOptions::default().with_role(RuntimeRole::Server),
        )
        .expect("resolves");
        assert_eq!(
            ResourceThresholds::from_resolved(&resolved.metrics),
            ResourceThresholds {
                max_rss_bytes: None,
                min_free_bytes: Some(1024),
                min_free_ratio: None,
                min_inode_free_ratio: Some(0.05),
            }
        );
        let histogram =
            LatencyHistogramConfig::from_resolved(&resolved.metrics).expect("valid boundaries");
        assert_eq!(
            histogram.boundaries(),
            &[
                Duration::from_micros(500),
                Duration::from_micros(50_500),
                Duration::from_secs(1)
            ]
        );
    }

    struct RecordingSink {
        points: Mutex<Vec<MetricPoint>>,
        histograms: Mutex<Vec<HistogramPoint>>,
    }

    impl MetricSink for RecordingSink {
        fn record(&self, point: &MetricPoint) {
            if let Ok(mut points) = self.points.lock() {
                points.push(point.clone());
            }
        }

        fn record_histogram(&self, point: &HistogramPoint) {
            if let Ok(mut histograms) = self.histograms.lock() {
                histograms.push(point.clone());
            }
        }
    }

    #[test]
    fn sinks_receive_every_point() {
        let sink = RecordingSink {
            points: Mutex::new(Vec::new()),
            histograms: Mutex::new(Vec::new()),
        };
        let recorded = emit_resource_metrics(&sink, &snapshot(), &ResourceHealth::default());
        assert_eq!(recorded, 10);
        assert_eq!(sink.points.lock().map(|p| p.len()).unwrap_or(0), 10);

        let histogram = LatencyHistogram::new(
            LatencyHistogramConfig::new(vec![Duration::from_millis(1)]).expect("valid"),
        )
        .recorded(Duration::from_millis(2))
        .snapshot();
        emit_latency_histogram(&sink, &histogram, LatencyKind::Request);
        assert_eq!(sink.histograms.lock().map(|h| h.len()).unwrap_or(0), 1);

        let names = Mutex::new(Vec::new());
        let closure_sink = |point: &MetricPoint| {
            if let Ok(mut names) = names.lock() {
                names.push(point.name);
            }
        };
        emit_resource_metrics(&closure_sink, &snapshot(), &ResourceHealth::default());
        emit_latency_histogram(&closure_sink, &histogram, LatencyKind::Operation);
        assert_eq!(names.lock().map(|n| n.len()).unwrap_or(0), 10);
    }
}
