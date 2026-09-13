/**
 * APM resource and latency metrics driven by the resolved `.ores-otel.toml`
 * metrics policy (`@oresoftware/next-loggers/apm`, Node-compatible runtimes).
 *
 * OpenTelemetry providers stay application-owned: callers pass a `Meter`. The
 * meter is typed structurally so this package keeps no @opentelemetry/api
 * dependency; an `@opentelemetry/api` `Meter` satisfies {@link OresOtelMeter}.
 *
 * Pure evaluation (thresholds, pressure checks, histogram snapshots) is kept
 * separate from the sampling effects (`process`, `statfs`, event-loop hooks).
 */
import { statfs } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { validateHistogramBoundaries, type ResolvedOresOtelConfig } from './ores-otel-config.js';

declare const process: {
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number };
  cpuUsage(): { user: number; system: number };
  constrainedMemory?: () => number | undefined;
};

// ---------------------------------------------------------------------------
// Structural OpenTelemetry meter surface
// ---------------------------------------------------------------------------

export type OresOtelAttributes = Record<string, string | number | boolean>;

export interface OresOtelObservableResult {
  observe(value: number, attributes?: OresOtelAttributes): void;
}

export type OresOtelObservableCallback = (result: OresOtelObservableResult) => void;

export interface OresOtelObservable {
  addCallback(callback: OresOtelObservableCallback): void;
  removeCallback(callback: OresOtelObservableCallback): void;
}

export interface OresOtelHistogram {
  record(value: number, attributes?: OresOtelAttributes): void;
}

export interface OresOtelInstrumentOptions {
  description?: string;
  unit?: string;
  advice?: { explicitBucketBoundaries?: number[] };
}

export interface OresOtelMeter {
  createObservableGauge(name: string, options?: OresOtelInstrumentOptions): OresOtelObservable;
  createObservableCounter(name: string, options?: OresOtelInstrumentOptions): OresOtelObservable;
  createHistogram(name: string, options?: OresOtelInstrumentOptions): OresOtelHistogram;
}

export const ORES_APM_METRICS = Object.freeze({
  memoryUsage: 'process.memory.usage',
  heapUsed: 'process.runtime.heap.used',
  heapTotal: 'process.runtime.heap.total',
  cpuTime: 'process.cpu.time',
  filesystemUsage: 'system.filesystem.usage',
  filesystemUtilization: 'system.filesystem.utilization',
  resourcePressure: 'ores.apm.resource.pressure',
  latency: 'ores.apm.latency',
  eventLoopDelayP50: 'nodejs.eventloop.delay.p50',
  eventLoopDelayP99: 'nodejs.eventloop.delay.p99',
  eventLoopDelayMax: 'nodejs.eventloop.delay.max',
  eventLoopUtilization: 'nodejs.eventloop.utilization',
} as const);

// ---------------------------------------------------------------------------
// Pure thresholds and pressure evaluation
// ---------------------------------------------------------------------------

export interface OresOtelResourceThresholds {
  readonly minFreeBytes?: number;
  readonly minFreeRatio?: number;
  readonly minInodeFreeRatio?: number;
  readonly diskFreeRatioWarning?: number;
  readonly cpuRatioWarning?: number;
  readonly memoryRatioWarning?: number;
  readonly queueDepthWarning?: number;
}

function defined<T extends object>(value: Record<string, unknown>): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))) as T;
}

/**
 * Thresholds from a resolved config. Disk thresholds are kept only when
 * `metrics.enabled` and `metrics.filesystem.enabled` are true; saturation
 * thresholds only when `metrics.enabled` and `metrics.saturation.enabled` are.
 */
export function oresOtelResourceThresholds(config: ResolvedOresOtelConfig): OresOtelResourceThresholds {
  const metrics = config.metrics;
  const disk = metrics.enabled && metrics.filesystem.enabled;
  const saturation = metrics.enabled && metrics.saturation.enabled;
  return defined<OresOtelResourceThresholds>({
    minFreeBytes: disk ? metrics.filesystem.minFreeBytes : undefined,
    minFreeRatio: disk ? metrics.filesystem.minFreeRatio : undefined,
    minInodeFreeRatio: disk ? metrics.filesystem.minInodeFreeRatio : undefined,
    diskFreeRatioWarning: saturation ? metrics.saturation.diskFreeRatioWarning : undefined,
    cpuRatioWarning: saturation ? metrics.saturation.cpuRatioWarning : undefined,
    memoryRatioWarning: saturation ? metrics.saturation.memoryRatioWarning : undefined,
    queueDepthWarning: saturation ? metrics.saturation.queueDepthWarning : undefined,
  });
}

/** Value of the `ores.apm.pressure.kind` attribute. */
export type OresOtelPressureKind =
  | 'disk_free_bytes'
  | 'disk_free_ratio'
  | 'disk_inode_free_ratio'
  | 'disk_free_ratio_warning'
  | 'cpu_ratio_warning'
  | 'memory_ratio_warning'
  | 'queue_depth_warning';

export interface OresOtelPressureCheck {
  readonly kind: OresOtelPressureKind;
  readonly target: string;
  readonly breached: boolean;
}

export interface OresOtelDiskMeasurement {
  readonly path: string;
  readonly availableBytes: number;
  readonly capacityBytes: number;
  readonly availableInodes?: number | undefined;
  readonly totalInodes?: number | undefined;
}

export interface OresOtelDiskPressure {
  readonly path: string;
  /** `available / capacity`, or undefined when capacity is 0. */
  readonly freeRatio: number | undefined;
  /** `availableInodes / totalInodes`, or undefined when unknown. */
  readonly inodeFreeRatio: number | undefined;
  /** Every threshold that could be evaluated. */
  readonly checks: readonly OresOtelPressureCheck[];
  readonly underPressure: boolean;
}

type Candidate = readonly [OresOtelPressureKind, number | undefined, number | undefined];

function checksFrom(
  target: string,
  candidates: readonly Candidate[],
  breached: (measured: number, threshold: number) => boolean,
): OresOtelPressureCheck[] {
  return candidates.flatMap(([kind, threshold, measured]) =>
    threshold === undefined || measured === undefined
      ? []
      : [Object.freeze({ kind, target, breached: breached(measured, threshold) })],
  );
}

const nonNegative = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value >= 0);

/** Pure disk-pressure evaluation. Pressure means a measurement fell strictly below its threshold. */
export function evaluateDiskPressure(
  measurement: OresOtelDiskMeasurement,
  thresholds: OresOtelResourceThresholds,
): OresOtelDiskPressure {
  const { path, availableBytes, capacityBytes, availableInodes, totalInodes } = measurement;
  if (![availableBytes, capacityBytes, availableInodes, totalInodes].every(nonNegative)) {
    throw new RangeError('disk measurements must be finite and non-negative');
  }
  const freeRatio = capacityBytes === 0 ? undefined : availableBytes / capacityBytes;
  const inodeFreeRatio =
    availableInodes === undefined || totalInodes === undefined || totalInodes === 0
      ? undefined
      : availableInodes / totalInodes;
  const checks = checksFrom(
    path,
    [
      ['disk_free_bytes', thresholds.minFreeBytes, availableBytes],
      ['disk_free_ratio', thresholds.minFreeRatio, freeRatio],
      ['disk_inode_free_ratio', thresholds.minInodeFreeRatio, inodeFreeRatio],
      ['disk_free_ratio_warning', thresholds.diskFreeRatioWarning, freeRatio],
    ],
    (measured, threshold) => measured < threshold,
  );
  return Object.freeze({
    path,
    freeRatio,
    inodeFreeRatio,
    checks: Object.freeze(checks),
    underPressure: checks.some((check) => check.breached),
  });
}

export interface OresOtelSaturationMeasurement {
  readonly target: string;
  readonly cpuRatio?: number | undefined;
  readonly memoryRatio?: number | undefined;
  readonly queueDepth?: number | undefined;
}

/** Pure saturation evaluation. A warning is breached when a measurement rises strictly above its threshold. */
export function evaluateSaturation(
  measurement: OresOtelSaturationMeasurement,
  thresholds: OresOtelResourceThresholds,
): readonly OresOtelPressureCheck[] {
  return Object.freeze(
    checksFrom(
      measurement.target,
      [
        ['cpu_ratio_warning', thresholds.cpuRatioWarning, measurement.cpuRatio],
        ['memory_ratio_warning', thresholds.memoryRatioWarning, measurement.memoryRatio],
        ['queue_depth_warning', thresholds.queueDepthWarning, measurement.queueDepth],
      ],
      (measured, threshold) => measured > threshold,
    ),
  );
}

/** Renders pressure checks as `ores.apm.resource.pressure` gauge observations (1 while breached, else 0). */
export function pressureObservations(
  checks: readonly OresOtelPressureCheck[],
): ReadonlyArray<readonly [number, OresOtelAttributes]> {
  return checks.map(
    (check) =>
      [
        check.breached ? 1 : 0,
        { 'ores.apm.pressure.kind': check.kind, 'ores.apm.pressure.target': check.target },
      ] as const,
  );
}

// ---------------------------------------------------------------------------
// Pure latency histogram snapshots
// ---------------------------------------------------------------------------

export interface OresOtelLatencyHistogramSnapshot {
  readonly boundariesMs: readonly number[];
  /** Bucket `i` counts values `<= boundariesMs[i]`; the last bucket counts the rest. */
  readonly bucketCounts: readonly number[];
  readonly count: number;
  readonly sum: number;
  readonly min: number | undefined;
  readonly max: number | undefined;
}

/** An empty explicit-bucket histogram. Throws OresOtelConfigError for invalid boundaries. */
export function createLatencyHistogramSnapshot(boundariesMs: readonly unknown[]): OresOtelLatencyHistogramSnapshot {
  const bounds = Object.freeze(validateHistogramBoundaries(boundariesMs, 'boundariesMs'));
  return Object.freeze({
    boundariesMs: bounds,
    bucketCounts: Object.freeze(new Array<number>(bounds.length + 1).fill(0)),
    count: 0,
    sum: 0,
    min: undefined,
    max: undefined,
  });
}

/** Returns a new snapshot with `valueMs` recorded (an O(buckets) copy of at most 33 counts). */
export function recordLatency(
  snapshot: OresOtelLatencyHistogramSnapshot,
  valueMs: number,
): OresOtelLatencyHistogramSnapshot {
  if (!Number.isFinite(valueMs) || valueMs < 0) throw new RangeError('latency must be finite and >= 0');
  const found = snapshot.boundariesMs.findIndex((bound) => valueMs <= bound);
  const bucket = found < 0 ? snapshot.boundariesMs.length : found;
  return Object.freeze({
    boundariesMs: snapshot.boundariesMs,
    bucketCounts: Object.freeze(snapshot.bucketCounts.map((count, index) => (index === bucket ? count + 1 : count))),
    count: snapshot.count + 1,
    sum: snapshot.sum + valueMs,
    min: snapshot.min === undefined ? valueMs : Math.min(snapshot.min, valueMs),
    max: snapshot.max === undefined ? valueMs : Math.max(snapshot.max, valueMs),
  });
}

// ---------------------------------------------------------------------------
// Sampling effects
// ---------------------------------------------------------------------------

export interface OresOtelProcessMemorySample {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
}

export function sampleProcessMemory(): OresOtelProcessMemorySample {
  const usage = process.memoryUsage();
  return Object.freeze({
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
  });
}

export interface OresOtelFilesystemSample {
  readonly path: string;
  readonly capacityBytes: number;
  readonly freeBytes: number;
  /** Bytes available to unprivileged users (excludes root-reserved blocks). */
  readonly availableBytes: number;
  readonly totalInodes: number;
  readonly freeInodes: number;
}

export async function sampleFilesystem(path: string): Promise<OresOtelFilesystemSample> {
  const stats = await statfs(path);
  return Object.freeze({
    path,
    capacityBytes: stats.blocks * stats.bsize,
    freeBytes: stats.bfree * stats.bsize,
    availableBytes: stats.bavail * stats.bsize,
    totalInodes: stats.files,
    freeInodes: stats.ffree,
  });
}

// ---------------------------------------------------------------------------
// Latency recorder
// ---------------------------------------------------------------------------

/** Value of the `ores.apm.latency.kind` attribute. */
export type OresOtelLatencyKind = 'request' | 'operation' | 'queue_wait';

export interface OresOtelLatencyRecorder {
  readonly enabled: boolean;
  record(kind: OresOtelLatencyKind, valueMs: number, attributes?: OresOtelAttributes): void;
  time<T>(kind: OresOtelLatencyKind, operation: () => T, attributes?: OresOtelAttributes): T;
  timeAsync<T>(kind: OresOtelLatencyKind, operation: () => Promise<T>, attributes?: OresOtelAttributes): Promise<T>;
}

const LATENCY_SIGNALS = Object.freeze({
  request: 'requestDurationMs',
  operation: 'operationDurationMs',
  queue_wait: 'queueWaitMs',
} as const);

const NOOP_LATENCY_RECORDER: OresOtelLatencyRecorder = Object.freeze({
  enabled: false,
  record: () => undefined,
  time: <T>(_kind: OresOtelLatencyKind, operation: () => T): T => operation(),
  timeAsync: <T>(_kind: OresOtelLatencyKind, operation: () => Promise<T>): Promise<T> => operation(),
});

/**
 * An `ores.apm.latency` histogram (unit `ms`) using the configured boundaries.
 * Returns a no-op recorder unless `enabled`, `metrics.enabled`, and
 * `metrics.latency.enabled` are all true; each kind also honours its signal flag.
 */
export function createLatencyRecorder(meter: OresOtelMeter, config: ResolvedOresOtelConfig): OresOtelLatencyRecorder {
  const latency = config.metrics.latency;
  if (!(config.enabled && config.metrics.enabled && latency.enabled)) return NOOP_LATENCY_RECORDER;
  const histogram = meter.createHistogram(ORES_APM_METRICS.latency, {
    unit: 'ms',
    description: 'Request, operation, and queue-wait latency.',
    advice: { explicitBucketBoundaries: [...latency.histogramBoundariesMs] },
  });
  const record = (kind: OresOtelLatencyKind, valueMs: number, attributes: OresOtelAttributes = {}): void => {
    if (!Number.isFinite(valueMs) || valueMs < 0) throw new RangeError('latency must be finite and >= 0');
    if (!latency[LATENCY_SIGNALS[kind]]) return;
    histogram.record(valueMs, { ...attributes, 'ores.apm.latency.kind': kind });
  };
  return Object.freeze({
    enabled: true,
    record,
    time: <T>(kind: OresOtelLatencyKind, operation: () => T, attributes?: OresOtelAttributes): T => {
      const started = performance.now();
      try {
        return operation();
      } finally {
        record(kind, performance.now() - started, attributes);
      }
    },
    timeAsync: async <T>(
      kind: OresOtelLatencyKind,
      operation: () => Promise<T>,
      attributes?: OresOtelAttributes,
    ): Promise<T> => {
      const started = performance.now();
      try {
        return await operation();
      } finally {
        record(kind, performance.now() - started, attributes);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

export interface StartOresOtelApmOptions {
  readonly meter: OresOtelMeter;
  readonly config: ResolvedOresOtelConfig;
  /** Memory limit for `memory_ratio_warning`; defaults to `process.constrainedMemory()` when known. */
  readonly memoryLimitBytes?: number | undefined;
  /** Receives filesystem sampling failures (a path that cannot be statfs'd). */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface OresOtelApmHandle {
  readonly latency: OresOtelLatencyRecorder;
  readonly thresholds: OresOtelResourceThresholds;
  /** The most recent filesystem samples (refreshed every `process.sample_interval_ms`). */
  filesystemSamples(): readonly OresOtelFilesystemSample[];
  /** Samples every configured path now. Never rejects; failures go to `onError`. */
  refreshFilesystem(): Promise<void>;
  /** Removes every callback, stops event-loop monitoring and the sampling timer. Idempotent. */
  stop(): void;
}

/**
 * EFFECT BOUNDARY (imperative by design): registers observable instruments on
 * the application's meter and owns the sampling timer and event-loop monitor.
 * Every registration is recorded so `stop()` undoes all of them.
 *
 * Node exposes no portable virtual-memory, thread-count, or open-fd reading, so
 * those process signals are not emitted here (the Rust SDK samples them).
 */
export function startOresOtelApm(options: StartOresOtelApmOptions): OresOtelApmHandle {
  const { meter, config } = options;
  const metrics = config.metrics;
  const active = config.enabled && metrics.enabled;
  const thresholds = oresOtelResourceThresholds(config);
  const cleanups: Array<() => void> = [];
  let samples: readonly OresOtelFilesystemSample[] = Object.freeze([]);
  let stopped = false;

  const observe = (instrument: OresOtelObservable, callback: OresOtelObservableCallback): void => {
    instrument.addCallback(callback);
    cleanups.push(() => instrument.removeCallback(callback));
  };
  const gauge = (name: string, unit: string, description: string, callback: OresOtelObservableCallback): void =>
    observe(meter.createObservableGauge(name, { unit, description }), callback);

  const processMetrics = metrics.process;
  if (active && processMetrics.enabled) {
    if (processMetrics.rssBytes) {
      gauge(ORES_APM_METRICS.memoryUsage, 'By', 'Resident set size.', (result) =>
        result.observe(process.memoryUsage().rss),
      );
    }
    if (processMetrics.heapBytes) {
      gauge(ORES_APM_METRICS.heapUsed, 'By', 'V8 heap in use.', (result) =>
        result.observe(process.memoryUsage().heapUsed),
      );
      gauge(ORES_APM_METRICS.heapTotal, 'By', 'V8 heap reserved.', (result) =>
        result.observe(process.memoryUsage().heapTotal),
      );
    }
    if (processMetrics.cpuSeconds) {
      observe(
        meter.createObservableCounter(ORES_APM_METRICS.cpuTime, { unit: 's', description: 'Process CPU time.' }),
        (result) => {
          const usage = process.cpuUsage();
          result.observe(usage.user / 1e6, { 'cpu.mode': 'user' });
          result.observe(usage.system / 1e6, { 'cpu.mode': 'system' });
        },
      );
    }
  }

  if (active && metrics.latency.enabled && metrics.latency.eventLoopLagMs) {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    cleanups.push(() => void delay.disable());
    const delayGauge = (name: string, read: () => number): void =>
      gauge(name, 's', 'Event-loop delay.', (result) => {
        if (delay.count > 0) result.observe(read() / 1e9);
      });
    delayGauge(ORES_APM_METRICS.eventLoopDelayP50, () => delay.percentile(50));
    delayGauge(ORES_APM_METRICS.eventLoopDelayP99, () => delay.percentile(99));
    delayGauge(ORES_APM_METRICS.eventLoopDelayMax, () => delay.max);
  }

  if (active && metrics.runtime.enabled && metrics.runtime.eventLoopUtilization) {
    let previous = performance.eventLoopUtilization();
    gauge(ORES_APM_METRICS.eventLoopUtilization, '1', 'Event-loop utilization since the last collection.', (result) => {
      const current = performance.eventLoopUtilization();
      result.observe(performance.eventLoopUtilization(current, previous).utilization);
      previous = current;
    });
  }

  const filesystem = metrics.filesystem;
  const filesystemActive = active && filesystem.enabled;
  const refreshFilesystem = async (): Promise<void> => {
    if (!filesystemActive || stopped) return;
    const settled = await Promise.allSettled(filesystem.paths.map((path) => sampleFilesystem(path)));
    settled.forEach((outcome) => {
      if (outcome.status === 'rejected') options.onError?.(outcome.reason);
    });
    samples = Object.freeze(settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : [])));
  };

  if (filesystemActive) {
    if (filesystem.capacityBytes || filesystem.freeBytes) {
      gauge(ORES_APM_METRICS.filesystemUsage, 'By', 'Filesystem space by state.', (result) =>
        samples.forEach((sample) => {
          const mountpoint = { 'system.filesystem.mountpoint': sample.path };
          result.observe(sample.capacityBytes - sample.freeBytes, { ...mountpoint, 'system.filesystem.state': 'used' });
          result.observe(sample.availableBytes, { ...mountpoint, 'system.filesystem.state': 'free' });
          result.observe(sample.freeBytes - sample.availableBytes, {
            ...mountpoint,
            'system.filesystem.state': 'reserved',
          });
        }),
      );
    }
    if (filesystem.freeRatio) {
      gauge(ORES_APM_METRICS.filesystemUtilization, '1', 'Fraction of filesystem capacity in use.', (result) =>
        samples.forEach((sample) => {
          if (sample.capacityBytes > 0) {
            result.observe((sample.capacityBytes - sample.availableBytes) / sample.capacityBytes, {
              'system.filesystem.mountpoint': sample.path,
            });
          }
        }),
      );
    }
    const timer = setInterval(() => void refreshFilesystem(), processMetrics.sampleIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    cleanups.push(() => clearInterval(timer));
    void refreshFilesystem();
  }

  const memoryLimit = options.memoryLimitBytes ?? (process.constrainedMemory?.() || undefined);
  if (active && Object.keys(thresholds).length > 0) {
    gauge(ORES_APM_METRICS.resourcePressure, '1', '1 while a configured resource threshold is breached.', (result) => {
      const checks = [
        ...samples.flatMap((sample) =>
          evaluateDiskPressure(
            {
              path: sample.path,
              availableBytes: sample.availableBytes,
              capacityBytes: sample.capacityBytes,
              availableInodes: sample.freeInodes,
              totalInodes: sample.totalInodes,
            },
            thresholds,
          ).checks,
        ),
        ...evaluateSaturation(
          {
            target: 'process',
            memoryRatio: memoryLimit === undefined ? undefined : process.memoryUsage().rss / memoryLimit,
          },
          thresholds,
        ),
      ];
      pressureObservations(checks).forEach(([value, attributes]) => result.observe(value, attributes));
    });
  }

  return Object.freeze({
    latency: createLatencyRecorder(meter, config),
    thresholds,
    filesystemSamples: () => samples,
    refreshFilesystem,
    stop: () => {
      if (stopped) return;
      stopped = true;
      cleanups.splice(0).forEach((cleanup) => cleanup());
    },
  });
}
