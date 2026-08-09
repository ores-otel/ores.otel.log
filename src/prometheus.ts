import type { LogRecord, LogTransport } from './base-logger.js';

export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

export interface MetricOptions {
  help: string;
  labelNames?: readonly string[];
  /** Maximum total series, including the reserved overflow series. Default 1000. */
  maxSeries?: number;
  /** Maximum UTF-16 code units per rendered label value. Default 256. */
  maxLabelValueLength?: number;
}

interface NormalizedLabels {
  key: string;
  rendered: string;
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_MAX_SERIES = 1_000;
const DEFAULT_MAX_LABEL_VALUE_LENGTH = 256;
const OVERFLOW_LABEL_VALUE = '__overflow__';

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) {
    throw new TypeError(`Invalid Prometheus metric name: ${name}`);
  }
}

function assertLabelName(name: string): void {
  if (!LABEL_NAME.test(name) || name.startsWith('__')) {
    throw new TypeError(`Invalid or reserved Prometheus label name: ${name}`);
  }
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function boundedLabelValue(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Metric value must be finite, got ${value}`);
  }
  return value;
}

function normalizeLabels(
  labelNames: readonly string[],
  labels: MetricLabels = {},
  maxLabelValueLength = DEFAULT_MAX_LABEL_VALUE_LENGTH,
): NormalizedLabels {
  const unknown = Object.keys(labels).filter((name) => !labelNames.includes(name));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Prometheus labels: ${unknown.join(', ')}`);
  }
  const values = labelNames.map((name) =>
    boundedLabelValue(String(labels[name] ?? ''), maxLabelValueLength),
  );
  const key = JSON.stringify(values);
  const rendered = labelNames.length === 0
    ? ''
    : `{${labelNames.map((name, index) => `${name}="${escapeLabel(values[index] ?? '')}"`).join(',')}}`;
  return { key, rendered };
}

abstract class MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly maxSeries: number;
  readonly maxLabelValueLength: number;
  protected readonly labelText = new Map<string, string>();

  constructor(name: string, options: MetricOptions) {
    assertMetricName(name);
    for (const label of options.labelNames ?? []) {
      assertLabelName(label);
    }
    if (!options.help?.trim()) {
      throw new TypeError(`Prometheus metric ${name} requires non-empty help text`);
    }
    const labels = [...(options.labelNames ?? [])];
    if (new Set(labels).size !== labels.length) {
      throw new TypeError(`Prometheus metric ${name} contains duplicate label names`);
    }
    this.name = name;
    this.help = options.help;
    this.labelNames = Object.freeze(labels);
    this.maxSeries = positiveInteger(options.maxSeries, DEFAULT_MAX_SERIES);
    this.maxLabelValueLength = positiveInteger(
      options.maxLabelValueLength,
      DEFAULT_MAX_LABEL_VALUE_LENGTH,
    );
  }

  protected normalize(labels?: MetricLabels): NormalizedLabels {
    return normalizeLabels(this.labelNames, labels, this.maxLabelValueLength);
  }

  protected labels(labels?: MetricLabels): NormalizedLabels {
    const normalized = this.normalize(labels);
    if (this.labelText.has(normalized.key)) {
      return normalized;
    }

    if (this.labelNames.length === 0) {
      this.labelText.set(normalized.key, normalized.rendered);
      return normalized;
    }

    // Reserve one slot for a bounded overflow series. New unseen combinations
    // collapse there once the ordinary series budget is exhausted.
    const ordinaryBudget = Math.max(0, this.maxSeries - 1);
    if (this.labelText.size >= ordinaryBudget) {
      const overflow: Record<string, MetricLabelValue> = {};
      for (const name of this.labelNames) {
        overflow[name] = OVERFLOW_LABEL_VALUE;
      }
      const overflowLabels = this.normalize(overflow);
      this.labelText.set(overflowLabels.key, overflowLabels.rendered);
      return overflowLabels;
    }

    this.labelText.set(normalized.key, normalized.rendered);
    return normalized;
  }

  protected keyForGet(labels?: MetricLabels): string {
    const normalized = this.normalize(labels);
    if (this.labelText.has(normalized.key) || this.labelNames.length === 0) {
      return normalized.key;
    }
    const overflow: Record<string, MetricLabelValue> = {};
    for (const name of this.labelNames) {
      overflow[name] = OVERFLOW_LABEL_VALUE;
    }
    const overflowKey = this.normalize(overflow).key;
    return this.labelText.has(overflowKey) ? overflowKey : normalized.key;
  }

  expositionNames(): readonly string[] {
    return [this.name];
  }

  abstract render(): string[];
}

export class Counter extends MetricBase {
  private readonly values = new Map<string, number>();

  inc(labels?: MetricLabels, value = 1): void {
    finite(value);
    if (value < 0) {
      throw new RangeError('Prometheus counters cannot decrease');
    }
    const normalized = this.labels(labels);
    this.values.set(normalized.key, (this.values.get(normalized.key) ?? 0) + value);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(this.keyForGet(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${this.labelText.get(key) ?? ''} ${value}`);
    }
    return lines;
  }
}

export class Gauge extends MetricBase {
  private readonly values = new Map<string, number>();

  set(labels: MetricLabels | undefined, value: number): void {
    const normalized = this.labels(labels);
    this.values.set(normalized.key, finite(value));
  }

  inc(labels?: MetricLabels, value = 1): void {
    const normalized = this.labels(labels);
    this.values.set(normalized.key, (this.values.get(normalized.key) ?? 0) + finite(value));
  }

  dec(labels?: MetricLabels, value = 1): void {
    this.inc(labels, -finite(value));
  }

  get(labels?: MetricLabels): number {
    return this.values.get(this.keyForGet(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${this.labelText.get(key) ?? ''} ${value}`);
    }
    return lines;
  }
}

interface HistogramState {
  buckets: number[];
  count: number;
  sum: number;
}

export interface HistogramOptions extends MetricOptions {
  buckets?: readonly number[];
}

export class Histogram extends MetricBase {
  readonly buckets: readonly number[];
  private readonly values = new Map<string, HistogramState>();

  constructor(name: string, options: HistogramOptions) {
    super(name, options);
    const buckets = [...(
      options.buckets ?? [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    )]
      .map(finite)
      .sort((left, right) => left - right);
    if (buckets.some((value, index) => index > 0 && value === buckets[index - 1])) {
      throw new TypeError(`Histogram ${name} contains duplicate buckets`);
    }
    this.buckets = Object.freeze(buckets);
  }

  expositionNames(): readonly string[] {
    return [this.name, `${this.name}_bucket`, `${this.name}_sum`, `${this.name}_count`];
  }

  observe(labels: MetricLabels | undefined, value: number): void {
    const observed = finite(value);
    const normalized = this.labels(labels);
    const state = this.values.get(normalized.key) ?? {
      buckets: this.buckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (observed <= (this.buckets[index] ?? Number.POSITIVE_INFINITY)) {
        state.buckets[index] = (state.buckets[index] ?? 0) + 1;
      }
    }
    state.count += 1;
    state.sum += observed;
    this.values.set(normalized.key, state);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const [key, state] of this.values) {
      const rendered = this.labelText.get(key) ?? '';
      const baseLabels = rendered ? rendered.slice(1, -1) : '';
      for (let index = 0; index < this.buckets.length; index += 1) {
        const separator = baseLabels ? ',' : '';
        lines.push(
          `${this.name}_bucket{${baseLabels}${separator}le="${this.buckets[index]}"} ${state.buckets[index] ?? 0}`,
        );
      }
      const separator = baseLabels ? ',' : '';
      lines.push(`${this.name}_bucket{${baseLabels}${separator}le="+Inf"} ${state.count}`);
      lines.push(`${this.name}_sum${rendered} ${state.sum}`);
      lines.push(`${this.name}_count${rendered} ${state.count}`);
    }
    return lines;
  }
}

export class PrometheusRegistry {
  private readonly metrics = new Map<string, MetricBase>();
  private readonly expositionNames = new Set<string>();

  counter(name: string, options: MetricOptions): Counter {
    return this.register(new Counter(name, options));
  }

  gauge(name: string, options: MetricOptions): Gauge {
    return this.register(new Gauge(name, options));
  }

  histogram(name: string, options: HistogramOptions): Histogram {
    return this.register(new Histogram(name, options));
  }

  register<T extends MetricBase>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Prometheus metric is already registered: ${metric.name}`);
    }
    const collisions = metric.expositionNames().filter((name) => this.expositionNames.has(name));
    if (collisions.length > 0) {
      throw new Error(`Prometheus exposition name is already registered: ${collisions.join(', ')}`);
    }
    this.metrics.set(metric.name, metric);
    for (const name of metric.expositionNames()) {
      this.expositionNames.add(name);
    }
    return metric;
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(...metric.render());
    }
    return `${lines.join('\n')}\n`;
  }

  response(): Response {
    return new Response(this.render(), {
      status: 200,
      headers: {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
}

export interface LoggerMetrics {
  records: Counter;
  transportWrites: Counter;
  transportDurationSeconds: Histogram;
  transportInFlight: Gauge;
  transportDropped: Counter;
  pendingLogs: Gauge;
}

export function createLoggerMetrics(registry = new PrometheusRegistry()): {
  registry: PrometheusRegistry;
  metrics: LoggerMetrics;
} {
  return {
    registry,
    metrics: {
      records: registry.counter('next_loggers_records_total', {
        help: 'Number of next-loggers records observed at the logger boundary.',
        labelNames: ['level', 'runtime'],
      }),
      transportWrites: registry.counter('next_loggers_transport_writes_total', {
        help: 'Number of logger transport writes by outcome.',
        labelNames: ['transport', 'outcome'],
      }),
      transportDurationSeconds: registry.histogram('next_loggers_transport_write_duration_seconds', {
        help: 'Duration of logger transport writes.',
        labelNames: ['transport'],
      }),
      transportInFlight: registry.gauge('next_loggers_transport_in_flight', {
        help: 'Current logger writes in flight.',
        labelNames: ['transport'],
      }),
      transportDropped: registry.counter('next_loggers_transport_dropped_total', {
        help: 'Records dropped by a bounded logger transport.',
        labelNames: ['transport', 'reason'],
      }),
      pendingLogs: registry.gauge('next_loggers_pending_writes', {
        help: 'Current process-wide pending logger writes.',
      }),
    },
  };
}

/** Count a record once at the logger boundary, before fan-out to transports. */
export function observeLoggerRecord(metrics: LoggerMetrics, record: LogRecord): void {
  metrics.records.inc({ level: record.level, runtime: String(record.runtime) });
}

export function updatePendingLogGauge(metrics: LoggerMetrics, pending: number): void {
  metrics.pendingLogs.set(undefined, Math.max(0, finite(pending)));
}

export function observeTransportDrop(
  metrics: LoggerMetrics,
  transport: string,
  reason: string,
  count = 1,
): void {
  metrics.transportDropped.inc({ transport, reason }, count);
}

export interface InstrumentedTransportOptions {
  transport: LogTransport;
  metrics: LoggerMetrics;
  now?: () => number;
  onMetricError?: (error: unknown, operation: string) => void;
}

function reportMetricError(
  callback: InstrumentedTransportOptions['onMetricError'],
  error: unknown,
  operation: string,
): void {
  try {
    callback?.(error, operation);
  } catch {
    // Metrics diagnostics must not create a recursive logger failure.
  }
}

/**
 * Explicit transport decorator. It observes only writes made through this
 * instance and never patches fetch, HTTP clients, console, or runtime modules.
 * Metric failures are isolated so they cannot replace the transport result.
 */
export class InstrumentedTransport implements LogTransport {
  readonly name: string;
  readonly inner: LogTransport;
  readonly metrics: LoggerMetrics;
  private readonly now: () => number;
  private readonly onMetricError: InstrumentedTransportOptions['onMetricError'];

  constructor(options: InstrumentedTransportOptions) {
    if (!options?.transport || typeof options.transport.write !== 'function') {
      throw new TypeError('InstrumentedTransport requires transport.write()');
    }
    this.inner = options.transport;
    this.metrics = options.metrics;
    this.name = options.transport.name ? `metrics:${options.transport.name}` : 'metrics:transport';
    this.now = options.now ?? (() =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
    );
    this.onMetricError = options.onMetricError;
  }

  private metric(operation: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      reportMetricError(this.onMetricError, error, operation);
    }
  }

  async write(record: LogRecord): Promise<void> {
    const transport = this.inner.name || 'anonymous';
    const labels = { transport };
    let started = 0;
    try {
      started = this.now();
    } catch (error) {
      reportMetricError(this.onMetricError, error, 'clock-start');
    }
    this.metric('in-flight-inc', () => this.metrics.transportInFlight.inc(labels));
    try {
      await this.inner.write(record);
      this.metric('write-success', () =>
        this.metrics.transportWrites.inc({ transport, outcome: 'success' }),
      );
    } catch (error) {
      this.metric('write-failure', () =>
        this.metrics.transportWrites.inc({ transport, outcome: 'failure' }),
      );
      throw error;
    } finally {
      this.metric('in-flight-dec', () => this.metrics.transportInFlight.dec(labels));
      let finished = started;
      try {
        finished = this.now();
      } catch (error) {
        reportMetricError(this.onMetricError, error, 'clock-finish');
      }
      const elapsed = Number.isFinite(finished - started) ? Math.max(0, finished - started) : 0;
      this.metric('write-duration', () =>
        this.metrics.transportDurationSeconds.observe(labels, elapsed / 1_000),
      );
    }
  }

  flush(): void | Promise<void> {
    return this.inner.flush?.();
  }

  flushOnExit(records: readonly LogRecord[]): void | Promise<void> {
    return this.inner.flushOnExit?.(records);
  }

  close(): void | Promise<void> {
    return this.inner.close?.();
  }
}
