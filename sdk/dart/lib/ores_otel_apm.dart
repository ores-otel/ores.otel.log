/// Pure APM helpers driven by the resolved `.ores-otel.toml` metrics policy.
///
/// Sampling stays application-owned: callers pass measured numbers in and get
/// immutable values and OTel-shaped metric points back.
library;

import 'ores_otel_config.dart';

/// Resource-pressure thresholds taken from a resolved config.
class OresOtelResourceThresholds {
  const OresOtelResourceThresholds({
    this.minFreeBytes,
    this.minFreeRatio,
    this.minInodeFreeRatio,
    this.diskFreeRatioWarning,
    this.cpuRatioWarning,
    this.memoryRatioWarning,
    this.queueDepthWarning,
  });

  /// Disk thresholds are kept only when `metrics.enabled` and
  /// `metrics.filesystem.enabled` are both true; saturation thresholds only
  /// when `metrics.enabled` and `metrics.saturation.enabled` are both true.
  factory OresOtelResourceThresholds.fromResolved(OresOtelConfig config) {
    final metrics = config.metrics;
    final disk = metrics.enabled && metrics.filesystem.enabled;
    final saturation = metrics.enabled && metrics.saturation.enabled;
    return OresOtelResourceThresholds(
      minFreeBytes: disk ? metrics.filesystem.minFreeBytes : null,
      minFreeRatio: disk ? metrics.filesystem.minFreeRatio : null,
      minInodeFreeRatio: disk ? metrics.filesystem.minInodeFreeRatio : null,
      diskFreeRatioWarning:
          saturation ? metrics.saturation.diskFreeRatioWarning : null,
      cpuRatioWarning: saturation ? metrics.saturation.cpuRatioWarning : null,
      memoryRatioWarning:
          saturation ? metrics.saturation.memoryRatioWarning : null,
      queueDepthWarning:
          saturation ? metrics.saturation.queueDepthWarning : null,
    );
  }

  final int? minFreeBytes;
  final double? minFreeRatio;
  final double? minInodeFreeRatio;
  final double? diskFreeRatioWarning;
  final double? cpuRatioWarning;
  final double? memoryRatioWarning;
  final int? queueDepthWarning;
}

/// Value of the `ores.apm.pressure.kind` attribute.
enum OresOtelDiskPressureKind {
  freeBytes('disk_free_bytes'),
  freeRatio('disk_free_ratio'),
  inodeFreeRatio('disk_inode_free_ratio'),
  freeRatioWarning('disk_free_ratio_warning');

  const OresOtelDiskPressureKind(this.wireName);
  final String wireName;
}

/// Result of [evaluateDiskPressure] for one path.
class OresOtelDiskPressure {
  OresOtelDiskPressure._(
    this.path,
    this.freeRatio,
    this.inodeFreeRatio,
    Map<OresOtelDiskPressureKind, bool> checks,
  ) : checks = Map.unmodifiable(checks);

  final String path;

  /// `available / capacity`, or null when capacity is 0.
  final double? freeRatio;

  /// `availableInodes / totalInodes`, or null when inode counts are unknown.
  final double? inodeFreeRatio;

  /// Every threshold that could be evaluated, mapped to whether it is breached.
  final Map<OresOtelDiskPressureKind, bool> checks;

  List<OresOtelDiskPressureKind> get breaches =>
      List.unmodifiable(checks.entries.where((e) => e.value).map((e) => e.key));

  bool get underPressure => checks.containsValue(true);

  /// `ores.apm.resource.pressure` gauge points: 1 while breached, else 0.
  List<Map<String, Object>> metricPoints() => List.unmodifiable([
        for (final MapEntry(:key, :value) in checks.entries)
          Map<String, Object>.unmodifiable({
            'name': 'ores.apm.resource.pressure',
            'type': 'gauge',
            'unit': '1',
            'value': value ? 1 : 0,
            'attributes': Map<String, Object>.unmodifiable({
              'ores.apm.pressure.kind': key.wireName,
              'ores.apm.pressure.target': path,
            }),
          }),
      ]);
}

/// Pure disk-pressure evaluation over caller-measured numbers. Pressure means
/// the measured value dropped strictly below a configured threshold.
OresOtelDiskPressure evaluateDiskPressure({
  required String path,
  required int availableBytes,
  required int capacityBytes,
  int? availableInodes,
  int? totalInodes,
  required OresOtelResourceThresholds thresholds,
}) {
  if (availableBytes < 0 || capacityBytes < 0) {
    throw ArgumentError('byte counts must be non-negative');
  }
  if ((availableInodes ?? 0) < 0 || (totalInodes ?? 0) < 0) {
    throw ArgumentError('inode counts must be non-negative');
  }
  final freeRatio = capacityBytes == 0 ? null : availableBytes / capacityBytes;
  final inodeFreeRatio =
      availableInodes == null || totalInodes == null || totalInodes == 0
          ? null
          : availableInodes / totalInodes;
  return OresOtelDiskPressure._(path, freeRatio, inodeFreeRatio, {
    if (thresholds.minFreeBytes case final min?)
      OresOtelDiskPressureKind.freeBytes: availableBytes < min,
    if ((thresholds.minFreeRatio, freeRatio) case (final min?, final ratio?))
      OresOtelDiskPressureKind.freeRatio: ratio < min,
    if ((thresholds.minInodeFreeRatio, inodeFreeRatio)
        case (final min?, final ratio?))
      OresOtelDiskPressureKind.inodeFreeRatio: ratio < min,
    if ((thresholds.diskFreeRatioWarning, freeRatio)
        case (final min?, final ratio?))
      OresOtelDiskPressureKind.freeRatioWarning: ratio < min,
  });
}

/// Value of the `ores.apm.latency.kind` attribute.
enum OresOtelLatencyKind {
  request('request'),
  operation('operation'),
  queueWait('queue_wait');

  const OresOtelLatencyKind(this.wireName);
  final String wireName;
}

/// Immutable explicit-bucket latency histogram in milliseconds.
///
/// [record] returns a new value (an O(buckets) copy, at most 33 counts), so no
/// hot-path mutation exception is needed. Bucket `i` counts values
/// `<= boundariesMs[i]`; the final bucket counts values above the last bound.
class LatencyHistogram {
  /// Throws [OresOtelConfigException] for invalid boundaries.
  factory LatencyHistogram(Iterable<num> boundariesMs) {
    final bounds = validateHistogramBoundaries(boundariesMs, 'boundariesMs');
    return LatencyHistogram._(
        bounds, List.filled(bounds.length + 1, 0), 0, 0, null, null);
  }

  factory LatencyHistogram.fromConfig(OresOtelLatencyMetricsConfig config) =>
      LatencyHistogram(config.histogramBoundariesMs);

  LatencyHistogram._(
    this.boundariesMs,
    List<int> bucketCounts,
    this.count,
    this.sum,
    this.min,
    this.max,
  ) : bucketCounts = List.unmodifiable(bucketCounts);

  final List<double> boundariesMs;
  final List<int> bucketCounts;
  final int count;
  final double sum;
  final double? min;
  final double? max;

  LatencyHistogram record(num valueMs) {
    if (!valueMs.isFinite || valueMs < 0) {
      throw ArgumentError.value(valueMs, 'valueMs', 'must be finite and >= 0');
    }
    final value = valueMs.toDouble();
    final found = boundariesMs.indexWhere((bound) => value <= bound);
    final bucket = found < 0 ? boundariesMs.length : found;
    return LatencyHistogram._(
      boundariesMs,
      [
        for (var i = 0; i < bucketCounts.length; i++)
          bucketCounts[i] + (i == bucket ? 1 : 0),
      ],
      count + 1,
      sum + value,
      min == null || value < min! ? value : min,
      max == null || value > max! ? value : max,
    );
  }

  /// An OTel histogram data point named `ores.apm.latency` with unit `ms`.
  Map<String, Object> toMetricPoint({
    OresOtelLatencyKind kind = OresOtelLatencyKind.request,
    Map<String, Object> attributes = const {},
  }) =>
      Map.unmodifiable({
        'name': 'ores.apm.latency',
        'type': 'histogram',
        'unit': 'ms',
        'attributes': Map<String, Object>.unmodifiable({
          ...attributes,
          'ores.apm.latency.kind': kind.wireName,
        }),
        'explicit_bounds': boundariesMs,
        'bucket_counts': bucketCounts,
        'count': count,
        'sum': sum,
        if (min case final value?) 'min': value,
        if (max case final value?) 'max': value,
      });
}
