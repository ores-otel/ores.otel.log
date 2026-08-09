import type { LogLevel, LogRecord, LogTransport } from './base-logger.js';

export type PrometheusLabels = Readonly<Record<string, string | number | boolean>>;

export interface PrometheusRegistryOptions {
  /** Maximum unique label sets retained per metric. Default 1000. */
  maxSeriesPerMetric?: number;
  /** Prefix applied to every application metric. Default next_loggers. */
  prefix?: string;
}

export interface CounterOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export interface GaugeOptions extends CounterOptions {}

export interface HistogramOptions extends CounterOptions {
  /** Strictly increasing finite upper bounds. */
  buckets?: readonly number[];
}

interface NormalizedLabels {
  key: string;
  values: Readonly<Record<string, string>>;
}

interface MetricDescriptor {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly maximumSeries: number;
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateName(name: string, pattern: RegExp, label: string): string {
  if (!pattern.test(name)) {
    throw new TypeError(`${label} is not a valid Prometheus identifier: ${name}`);
  }
  return name;
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelsText(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function numberText(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '+Inf';
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return '-Inf';
  }
  return String(value);
}

function normalizeLabelNames(labelNames: readonly string[] | undefined): readonly string[] {
  const names = [...(labelNames ?? [])];
  const seen = new Set<string>();
  for (const name of names) {
    validateName(name, LABEL_NAME, 'label name');
    if (name === 'le') {
      throw new TypeError('label name le is reserved for histogram buckets');
    }
    if (seen.has(name)) {
      throw new TypeError(`duplicate label name in Prometheus metric: ${name}`);
    }
    seen.add(name);
  }
  return names;
}

function normalizeLabels(
  labelNames: readonly string[],
  labels: PrometheusLabels | undefined,
): NormalizedLabels {
  const source = labels ?? {};
  const sourceKeys = Object.keys(source);
  for (const key of sourceKeys) {
    if (!labelNames.includes(key)) {
      throw new TypeError(`unexpected Prometheus label ${key}`);
    }
  }
  const values: Record<string, string> = {};
  for (const name of labelNames) {
    const value = source[name];
    if (value === undefined) {
      throw new TypeError(`missing Prometheus label ${name}`);
    }
    values[name] = String(value);
  }
  return {
    key: labelNames.map((name) => `${name}\u0000${values[name]}`).join('\u0001'),
    values,
  };
}

abstract class MetricBase {
  readonly descriptor: MetricDescriptor;
  protected readonly dropped: (metricName: string) => void;

  abstract readonly kind: 'counter' | 'gauge' | 'histogram';

  protected constructor(descriptor: MetricDescriptor, dropped: (metricName: string) => void) {
    this.descriptor = descriptor;
    this.dropped = dropped;
  }

  abstract render(): string[];

  expositionNames(): readonly string[] {
    return [this.descriptor.name];
  }
}

export class PrometheusCounter extends MetricBase {
  readonly kind = 'counter' as const;
  private readonly series = new Map<string, { labels: Readonly<Record<string, string>>; value: number }>();

  constructor(descriptor: MetricDescriptor, dropped: (metricName: string) => void) {
    super(descriptor, dropped);
  }

  add(value = 1, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Prometheus counters can only increase by a finite non-negative value');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    const existing = this.series.get(normalized.key);
    if (existing) {
      existing.value += value;
      return;
    }
    if (this.series.size >= this.descriptor.maximumSeries) {
      this.dropped(this.descriptor.name);
      return;
    }
    this.series.set(normalized.key, { labels: normalized.values, value });
  }

  inc(labels?: PrometheusLabels): void {
    this.add(1, labels);
  }

  render(): string[] {
    return Array.from(this.series.values(), ({ labels, value }) =>
      `${this.descriptor.name}${labelsText(labels)} ${numberText(value)}`,
    );
  }
}

export class PrometheusGauge extends MetricBase {
  readonly kind = 'gauge' as const;
  private readonly series = new Map<string, { labels: Readonly<Record<string, string>>; value: number }>();

  constructor(descriptor: MetricDescriptor, dropped: (metricName: string) => void) {
    super(descriptor, dropped);
  }

  set(value: number, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value)) {
      throw new RangeError('Prometheus gauges require a finite value');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    const existing = this.series.get(normalized.key);
    if (existing) {
      existing.value = value;
      return;
    }
    if (this.series.size >= this.descriptor.maximumSeries) {
      this.dropped(this.descriptor.name);
      return;
    }
    this.series.set(normalized.key, { labels: normalized.values, value });
  }

  add(value: number, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value)) {
      throw new RangeError('Prometheus gauges require a finite delta');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    const existing = this.series.get(normalized.key);
    if (existing) {
      existing.value += value;
      return;
    }
    if (this.series.size >= this.descriptor.maximumSeries) {
      this.dropped(this.descriptor.name);
      return;
    }
    this.series.set(normalized.key, { labels: normalized.values, value });
  }

  inc(labels?: PrometheusLabels): void {
    this.add(1, labels);
  }

  dec(labels?: PrometheusLabels): void {
    this.add(-1, labels);
  }

  render(): string[] {
    return Array.from(this.series.values(), ({ labels, value }) =>
      `${this.descriptor.name}${labelsText(labels)} ${numberText(value)}`,
    );
  }
}

interface HistogramSeries {
  labels: Readonly<Record<string, string>>;
  buckets: number[];
  count: number;
  sum: number;
}

export class PrometheusHistogram extends MetricBase {
  readonly kind = 'histogram' as const;
  readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    descriptor: MetricDescriptor,
    buckets: readonly number[],
    dropped: (metricName: string) => void,
  ) {
    super(descriptor, dropped);
    this.buckets = buckets;
  }

  override expositionNames(): readonly string[] {
    return [
      this.descriptor.name,
      `${this.descriptor.name}_bucket`,
      `${this.descriptor.name}_sum`,
      `${this.descriptor.name}_count`,
    ];
  }

  observe(value: number, labels?: PrometheusLabels): void {
    if (!Number.isFinite(value)) {
      throw new RangeError('Prometheus histograms require a finite observation');
    }
    const normalized = normalizeLabels(this.descriptor.labelNames, labels);
    let series = this.series.get(normalized.key);
    if (!series) {
      if (this.series.size >= this.descriptor.maximumSeries) {
        this.dropped(this.descriptor.name);
        return;
      }
      series = {
        labels: normalized.values,
        buckets: this.buckets.map(() => 0),
        count: 0,
        sum: 0,
      };
      this.series.set(normalized.key, series);
    }
    series.count += 1;
    series.sum += value;
    for (let index = 0; index < this.buckets.length; index += 1) {
      const boundary = this.buckets[index];
      if (boundary !== undefined && value <= boundary) {
        series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      }
    }
  }

  render(): string[] {
    const lines: string[] = [];
    for (const series of this.series.values()) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        const boundary = this.buckets[index];
        if (boundary === undefined) {
          continue;
        }
        lines.push(
          `${this.descriptor.name}_bucket${labelsText({
            ...series.labels,
            le: numberText(boundary),
          })} ${series.buckets[index] ?? 0}`,
        );
      }
      lines.push(
        `${this.descriptor.name}_bucket${labelsText({ ...series.labels, le: '+Inf' })} ${series.count}`,
      );
      lines.push(`${this.descriptor.name}_sum${labelsText(series.labels)} ${numberText(series.sum)}`);
      lines.push(`${this.descriptor.name}_count${labelsText(series.labels)} ${series.count}`);
    }
    return lines;
  }
}

/**
 * Bounded metric API retained for compatibility with the newer explicit-name
 * registry surface. The object-form API above remains available for existing
 * consumers that rely on registry prefixes and dropped-series diagnostics.
 */
export interface MetricOptions {
  help: string;
  labelNames?: readonly string[];
  /** Maximum total series, including the reserved overflow series. Default 1000. */
  maxSeries?: number;
  /** Maximum UTF-16 code units retained per label value. Default 256. */
  maxLabelValueLength?: number;
}

export type MetricLabels = PrometheusLabels;

interface BoundedNormalizedLabels {
  key: string;
  values: Readonly<Record<string, string>>;
}

const DEFAULT_MAX_LABEL_VALUE_LENGTH = 256;
const OVERFLOW_LABEL_VALUE = '__overflow__';

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function boundedLabelValue(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function normalizeBoundedLabels(
  labelNames: readonly string[],
  labels: MetricLabels | undefined,
  maximum: number,
): BoundedNormalizedLabels {
  const source = labels ?? {};
  const unknown = Object.keys(source).filter((name) => !labelNames.includes(name));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown Prometheus labels: ${unknown.join(', ')}`);
  }
  const values: Record<string, string> = {};
  for (const name of labelNames) {
    values[name] = boundedLabelValue(String(source[name] ?? ''), maximum);
  }
  return {
    key: JSON.stringify(labelNames.map((name) => values[name])),
    values,
  };
}

abstract class BoundedMetricBase extends MetricBase {
  readonly maxLabelValueLength: number;
  protected readonly labelText = new Map<string, Readonly<Record<string, string>>>();

  constructor(name: string, options: MetricOptions) {
    if (!METRIC_NAME.test(name)) {
      throw new TypeError(`Invalid Prometheus metric name: ${name}`);
    }
    if (!options.help?.trim()) {
      throw new TypeError(`Prometheus metric ${name} requires non-empty help text`);
    }
    const labelNames = normalizeLabelNames(options.labelNames);
    for (const labelName of labelNames) {
      if (labelName.startsWith('__')) {
        throw new TypeError(`reserved Prometheus label name: ${labelName}`);
      }
    }
    super(
      {
        name,
        help: options.help,
        labelNames,
        maximumSeries: positiveInteger(options.maxSeries, 1_000),
      },
      () => undefined,
    );
    this.maxLabelValueLength = positiveInteger(
      options.maxLabelValueLength,
      DEFAULT_MAX_LABEL_VALUE_LENGTH,
    );
  }

  private overflow(): BoundedNormalizedLabels {
    const labels: Record<string, string> = {};
    for (const name of this.descriptor.labelNames) {
      labels[name] = OVERFLOW_LABEL_VALUE;
    }
    return normalizeBoundedLabels(
      this.descriptor.labelNames,
      labels,
      Math.max(this.maxLabelValueLength, OVERFLOW_LABEL_VALUE.length),
    );
  }

  protected labels(labels?: MetricLabels): BoundedNormalizedLabels {
    const normalized = normalizeBoundedLabels(
      this.descriptor.labelNames,
      labels,
      this.maxLabelValueLength,
    );
    if (this.labelText.has(normalized.key)) {
      return normalized;
    }
    if (this.descriptor.labelNames.length === 0) {
      this.labelText.set(normalized.key, normalized.values);
      return normalized;
    }
    const overflow = this.overflow();
    const ordinaryBudget = Math.max(0, this.descriptor.maximumSeries - 1);
    const ordinaryCount = this.labelText.has(overflow.key)
      ? this.labelText.size - 1
      : this.labelText.size;
    if (ordinaryCount >= ordinaryBudget) {
      this.labelText.set(overflow.key, overflow.values);
      return overflow;
    }
    this.labelText.set(normalized.key, normalized.values);
    return normalized;
  }

  protected keyForGet(labels?: MetricLabels): string {
    const normalized = normalizeBoundedLabels(
      this.descriptor.labelNames,
      labels,
      this.maxLabelValueLength,
    );
    if (this.labelText.has(normalized.key) || this.descriptor.labelNames.length === 0) {
      return normalized.key;
    }
    const overflow = this.overflow();
    return this.labelText.has(overflow.key) ? overflow.key : normalized.key;
  }
}

export class Counter extends BoundedMetricBase {
  readonly kind = 'counter' as const;
  private readonly values = new Map<string, number>();

  inc(labels?: MetricLabels, value = 1): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Metric value must be finite, got ${value}`);
    }
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
    return Array.from(this.values, ([key, value]) =>
      `${this.descriptor.name}${labelsText(this.labelText.get(key) ?? {})} ${numberText(value)}`,
    );
  }
}

export class Gauge extends BoundedMetricBase {
  readonly kind = 'gauge' as const;
  private readonly values = new Map<string, number>();

  set(labels: MetricLabels | undefined, value: number): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Metric value must be finite, got ${value}`);
    }
    const normalized = this.labels(labels);
    this.values.set(normalized.key, value);
  }

  inc(labels?: MetricLabels, value = 1): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Metric value must be finite, got ${value}`);
    }
    const normalized = this.labels(labels);
    this.values.set(normalized.key, (this.values.get(normalized.key) ?? 0) + value);
  }

  dec(labels?: MetricLabels, value = 1): void {
    this.inc(labels, -value);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(this.keyForGet(labels)) ?? 0;
  }

  render(): string[] {
    return Array.from(this.values, ([key, value]) =>
      `${this.descriptor.name}${labelsText(this.labelText.get(key) ?? {})} ${numberText(value)}`,
    );
  }
}

export interface BoundedHistogramOptions extends MetricOptions {
  buckets?: readonly number[];
}

export class Histogram extends BoundedMetricBase {
  readonly kind = 'histogram' as const;
  readonly buckets: readonly number[];
  private readonly values = new Map<string, HistogramSeries>();

  constructor(name: string, options: BoundedHistogramOptions) {
    super(name, options);
    const buckets = [...(
      options.buckets ?? [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    )].sort((left, right) => left - right);
    if (
      buckets.some((bucket) => !Number.isFinite(bucket)) ||
      buckets.some((bucket, index) => index > 0 && bucket === buckets[index - 1])
    ) {
      throw new TypeError(`Histogram ${name} contains invalid or duplicate buckets`);
    }
    this.buckets = Object.freeze(buckets);
  }

  override expositionNames(): readonly string[] {
    return [
      this.descriptor.name,
      `${this.descriptor.name}_bucket`,
      `${this.descriptor.name}_sum`,
      `${this.descriptor.name}_count`,
    ];
  }

  observe(labels: MetricLabels | undefined, value: number): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Metric value must be finite, got ${value}`);
    }
    const normalized = this.labels(labels);
    const series = this.values.get(normalized.key) ?? {
      labels: normalized.values,
      buckets: this.buckets.map(() => 0),
      count: 0,
      sum: 0,
    };
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= (this.buckets[index] ?? Number.POSITIVE_INFINITY)) {
        series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      }
    }
    series.count += 1;
    series.sum += value;
    this.values.set(normalized.key, series);
  }

  render(): string[] {
    const lines: string[] = [];
    for (const series of this.values.values()) {
      for (let index = 0; index < this.buckets.length; index += 1) {
        const boundary = this.buckets[index];
        if (boundary !== undefined) {
          lines.push(
            `${this.descriptor.name}_bucket${labelsText({
              ...series.labels,
              le: numberText(boundary),
            })} ${series.buckets[index] ?? 0}`,
          );
        }
      }
      lines.push(
        `${this.descriptor.name}_bucket${labelsText({ ...series.labels, le: '+Inf' })} ${series.count}`,
      );
      lines.push(
        `${this.descriptor.name}_sum${labelsText(series.labels)} ${numberText(series.sum)}`,
      );
      lines.push(`${this.descriptor.name}_count${labelsText(series.labels)} ${series.count}`);
    }
    return lines;
  }
}

const DEFAULT_BUCKETS = [64, 256, 1_024, 4_096, 16_384, 65_536, 262_144] as const;

export class PrometheusRegistry {
  readonly prefix: string;
  readonly maxSeriesPerMetric: number;
  private readonly metrics = new Map<string, MetricBase>();
  private readonly expositionNames = new Set<string>();
  private readonly droppedSeries = new Map<string, number>();

  constructor(options: PrometheusRegistryOptions = {}) {
    this.prefix = options.prefix ?? 'next_loggers';
    validateName(this.prefix, /^[a-zA-Z_:][a-zA-Z0-9_:]*$/, 'metric prefix');
    this.maxSeriesPerMetric = Math.max(1, Math.floor(options.maxSeriesPerMetric ?? 1_000));
  }

  private descriptor(options: CounterOptions): MetricDescriptor {
    const rawName = validateName(options.name, METRIC_NAME, 'metric name');
    const name = rawName.startsWith(`${this.prefix}_`) ? rawName : `${this.prefix}_${rawName}`;
    return {
      name,
      help: options.help,
      labelNames: normalizeLabelNames(options.labelNames),
      maximumSeries: this.maxSeriesPerMetric,
    };
  }

  private register<T extends MetricBase>(metric: T): T {
    if (this.metrics.has(metric.descriptor.name)) {
      throw new TypeError(`Prometheus metric already registered: ${metric.descriptor.name}`);
    }
    const collisions = metric.expositionNames().filter((name) => this.expositionNames.has(name));
    if (collisions.length > 0) {
      throw new TypeError(
        `Prometheus exposition name is already registered: ${collisions.join(', ')}`,
      );
    }
    this.metrics.set(metric.descriptor.name, metric);
    for (const name of metric.expositionNames()) {
      this.expositionNames.add(name);
    }
    return metric;
  }

  private noteDrop = (metricName: string): void => {
    this.droppedSeries.set(metricName, (this.droppedSeries.get(metricName) ?? 0) + 1);
  };

  counter(options: CounterOptions): PrometheusCounter;
  counter(name: string, options: MetricOptions): Counter;
  counter(optionsOrName: CounterOptions | string, options?: MetricOptions): PrometheusCounter | Counter {
    return typeof optionsOrName === 'string'
      ? this.register(new Counter(optionsOrName, options ?? { help: optionsOrName }))
      : this.register(new PrometheusCounter(this.descriptor(optionsOrName), this.noteDrop));
  }

  gauge(options: GaugeOptions): PrometheusGauge;
  gauge(name: string, options: MetricOptions): Gauge;
  gauge(optionsOrName: GaugeOptions | string, options?: MetricOptions): PrometheusGauge | Gauge {
    return typeof optionsOrName === 'string'
      ? this.register(new Gauge(optionsOrName, options ?? { help: optionsOrName }))
      : this.register(new PrometheusGauge(this.descriptor(optionsOrName), this.noteDrop));
  }

  histogram(options: HistogramOptions): PrometheusHistogram;
  histogram(name: string, options: BoundedHistogramOptions): Histogram;
  histogram(
    optionsOrName: HistogramOptions | string,
    boundedOptions?: BoundedHistogramOptions,
  ): PrometheusHistogram | Histogram {
    if (typeof optionsOrName === 'string') {
      return this.register(
        new Histogram(optionsOrName, boundedOptions ?? { help: optionsOrName }),
      );
    }
    const buckets = [...(optionsOrName.buckets ?? DEFAULT_BUCKETS)];
    if (
      buckets.length === 0 ||
      buckets.some((bucket) => !Number.isFinite(bucket)) ||
      buckets.some((bucket, index) => index > 0 && bucket <= (buckets[index - 1] ?? bucket))
    ) {
      throw new TypeError('Prometheus histogram buckets must be finite and strictly increasing');
    }
    return this.register(
      new PrometheusHistogram(this.descriptor(optionsOrName), buckets, this.noteDrop),
    );
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of Array.from(this.metrics.values()).sort((a, b) =>
      a.descriptor.name.localeCompare(b.descriptor.name),
    )) {
      lines.push(`# HELP ${metric.descriptor.name} ${escapeHelp(metric.descriptor.help)}`);
      lines.push(`# TYPE ${metric.descriptor.name} ${metric.kind}`);
      lines.push(...metric.render());
    }
    if (this.droppedSeries.size > 0) {
      const metricName = `${this.prefix}_prometheus_dropped_series_total`;
      lines.push(`# HELP ${metricName} Label sets dropped by the in-process cardinality guard.`);
      lines.push(`# TYPE ${metricName} counter`);
      for (const [name, value] of Array.from(this.droppedSeries).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`${metricName}{metric="${escapeLabel(name)}"} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  response(init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    }
    headers.set('cache-control', 'no-store');
    return new Response(this.render(), { ...init, headers });
  }
}

export interface LoggerPrometheusTransportOptions {
  registry?: PrometheusRegistry;
  /** Stable deployment/environment label. Avoid request IDs or user IDs. */
  environment?: string;
  recordSizeBuckets?: readonly number[];
}

export interface LoggerPrometheusMetrics {
  readonly registry: PrometheusRegistry;
  readonly transport: LogTransport;
}

function utf8Length(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

export function createLoggerPrometheusMetrics(
  options: LoggerPrometheusTransportOptions = {},
): LoggerPrometheusMetrics {
  const registry = options.registry ?? new PrometheusRegistry();
  const labels = ['app_name', 'runtime', 'level', ...(options.environment ? ['environment'] : [])];
  const records = registry.counter({
    name: 'records_total',
    help: 'Structured log records emitted by next-loggers.',
    labelNames: labels,
  });
  const errors = registry.counter({
    name: 'error_records_total',
    help: 'ERROR and FATAL records emitted by next-loggers.',
    labelNames: labels,
  });
  const correlated = registry.counter({
    name: 'trace_correlated_records_total',
    help: 'Records carrying a trace identifier.',
    labelNames: labels,
  });
  const bytes = registry.histogram({
    name: 'record_bytes',
    help: 'Serialized structured log record size in bytes.',
    labelNames: labels,
    ...(options.recordSizeBuckets ? { buckets: options.recordSizeBuckets } : {}),
  });
  const labelValues = (record: LogRecord): PrometheusLabels => ({
    app_name: record.appName,
    runtime: record.runtime,
    level: record.level,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  return {
    registry,
    transport: {
      name: 'prometheus-metrics',
      write(record) {
        const values = labelValues(record);
        records.inc(values);
        bytes.observe(utf8Length(JSON.stringify(record)), values);
        if (record.traceId) {
          correlated.inc(values);
        }
        if (record.level === 'ERROR' || record.level === 'FATAL') {
          errors.inc(values);
        }
      },
    },
  };
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
      transportDurationSeconds: registry.histogram(
        'next_loggers_transport_write_duration_seconds',
        {
          help: 'Duration of logger transport writes.',
          labelNames: ['transport'],
        },
      ),
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
  metrics.pendingLogs.set(undefined, Math.max(0, pending));
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
    // Diagnostics must never create a recursive logger failure.
  }
}

/** Explicit decorator; it never patches console, fetch, or runtime modules. */
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

  private metric(operation: string, callback: () => void): boolean {
    try {
      callback();
      return true;
    } catch (error) {
      reportMetricError(this.onMetricError, error, operation);
      return false;
    }
  }

  async write(record: LogRecord): Promise<void> {
    const transport = this.inner.name || 'anonymous';
    const labels = { transport };
    let started: number | undefined;
    try {
      started = this.now();
    } catch (error) {
      reportMetricError(this.onMetricError, error, 'clock-start');
    }
    const inFlightRecorded = this.metric(
      'in-flight-inc',
      () => this.metrics.transportInFlight.inc(labels),
    );
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
      if (inFlightRecorded) {
        this.metric('in-flight-dec', () => this.metrics.transportInFlight.dec(labels));
      }
      if (started !== undefined) {
        let finished: number | undefined;
        try {
          finished = this.now();
        } catch (error) {
          reportMetricError(this.onMetricError, error, 'clock-finish');
        }
        if (finished !== undefined) {
          const elapsed = Number.isFinite(finished - started) ? Math.max(0, finished - started) : 0;
          this.metric('write-duration', () =>
            this.metrics.transportDurationSeconds.observe(labels, elapsed / 1_000),
          );
        }
      }
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

export function isErrorLevel(level: LogLevel): boolean {
  return level === 'ERROR' || level === 'FATAL';
}
