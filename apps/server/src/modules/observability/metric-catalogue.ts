// Metric definitions of ARCHITECTURE 12 (build plan WP-34) and the helpers that create them on a registry.
//
// Three kinds of metrics live on the registry of a process (`MetricsService.registry`):
//   - instrumented metrics, created here or by the module that updates them, always through `ensure*` so the
//     first one to ask creates the metric and every later caller gets the same instance;
//   - collected metrics (`registerCollected`), whose samples are read when Prometheus scrapes (queue depth, link
//     status counts, licence days left, MFA locks, stuck outbox rows; filled by the ops module from the database);
//   - derived metrics (`registerDerived`), which publish a slice of another module's metric under the
//     ARCHITECTURE 12 name (job failures from `mscd_job_runs_total`, freshness recompute time from
//     `mscd_job_duration_seconds`, gateway latency and throttling from the gateway's call metrics), so the measured
//     value exists once and the published name stays stable when the owner instruments the name directly.
import { Counter, Gauge, Histogram, type Metric, type Registry } from 'prom-client';

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricDef {
  readonly name: string;
  readonly help: string;
  readonly type: MetricKind;
  readonly labelNames: readonly string[];
  readonly buckets?: readonly number[];
}

/** Latency buckets (seconds) of request and call histograms. */
export const LATENCY_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Every metric of ARCHITECTURE 12 plus the outbox health gauge. */
export const METRICS = {
  httpRequestDuration: {
    name: 'mscd_http_request_duration_seconds',
    help: 'HTTP request latency by route pattern, method and status code',
    type: 'histogram',
    labelNames: ['route', 'method', 'status'],
    buckets: LATENCY_BUCKETS,
  },
  queueWaiting: {
    name: 'mscd_queue_waiting',
    help: 'Jobs waiting (including delayed and retrying) per queue',
    type: 'gauge',
    labelNames: ['queue'],
  },
  queueOldestAge: {
    name: 'mscd_queue_oldest_age_seconds',
    help: 'Age of the oldest waiting job per queue',
    type: 'gauge',
    labelNames: ['queue'],
  },
  jobFailures: {
    name: 'mscd_job_failures_total',
    help: 'Failed job handler runs by job name (from mscd_job_runs_total{outcome="failed"})',
    type: 'counter',
    labelNames: ['job'],
  },
  linkStatusObjects: {
    name: 'mscd_link_status_objects',
    help: 'Storage objects by link status, summed over the active organisations',
    type: 'gauge',
    labelNames: ['status'],
  },
  freshnessRecompute: {
    name: 'mscd_freshness_recompute_seconds',
    help: 'Run time of the freshness.recompute and freshness.sweep jobs (from mscd_job_duration_seconds)',
    type: 'histogram',
    labelNames: ['job'],
  },
  gatewayRequestDuration: {
    name: 'mscd_gateway_request_duration_seconds',
    help: 'Storage gateway call latency by adapter and operation (from mscd_gateway_call_duration_seconds)',
    type: 'histogram',
    labelNames: ['adapter', 'operation'],
  },
  adapterThrottled: {
    name: 'mscd_adapter_throttled_total',
    help: 'Storage gateway calls answered rate-limited by the provider, by adapter and operation',
    type: 'counter',
    labelNames: ['adapter', 'operation'],
  },
  licenceDaysLeft: {
    name: 'mscd_licence_days_left',
    help: 'Days until valid_until of the current licence per organisation (negative once expired)',
    type: 'gauge',
    labelNames: ['org'],
  },
  auditChainBroken: {
    name: 'mscd_audit_chain_broken',
    help: '1 when the last audit.verify-chain run found the chain broken or not matching its newest signed anchor, else 0',
    type: 'gauge',
    labelNames: ['chain'],
  },
  authzDenied: {
    name: 'mscd_authz_denied_total',
    help: 'Requests denied by the authorisation guard (F.7)',
    type: 'counter',
    labelNames: ['route'],
  },
  mfaLocks: {
    name: 'mscd_mfa_locks_total',
    help: 'Second-factor lockouts of the installation (auth.mfa_locked entries of the platform audit log)',
    type: 'counter',
    labelNames: [],
  },
  outboxStuckRows: {
    name: 'mscd_job_outbox_stuck_rows',
    help: 'Outbox rows (BullMQ driver) that are parked after a permanent relay failure or still failing after the stuck threshold',
    type: 'gauge',
    labelNames: [],
  },
} as const satisfies Record<string, MetricDef>;

/** The twelve metric names ARCHITECTURE 12 and the WP-34 brief require on `/metrics`. */
export const ARCHITECTURE_METRIC_NAMES: readonly string[] = [
  METRICS.httpRequestDuration.name,
  METRICS.queueWaiting.name,
  METRICS.queueOldestAge.name,
  METRICS.jobFailures.name,
  METRICS.linkStatusObjects.name,
  METRICS.freshnessRecompute.name,
  METRICS.gatewayRequestDuration.name,
  METRICS.adapterThrottled.name,
  METRICS.licenceDaysLeft.name,
  METRICS.auditChainBroken.name,
  METRICS.authzDenied.name,
  METRICS.mfaLocks.name,
];

/** Metrics owned by other modules that derived metrics read. */
export const SOURCE_METRICS = {
  jobRuns: 'mscd_job_runs_total',
  jobDuration: 'mscd_job_duration_seconds',
  gatewayCalls: 'mscd_gateway_calls_total',
  gatewayCallDuration: 'mscd_gateway_call_duration_seconds',
} as const;

function existing<T>(registry: Registry, def: MetricDef, kind: abstract new (...args: never[]) => T): T | undefined {
  const found = registry.getSingleMetric(def.name);
  if (found === undefined) return undefined;
  if (!(found instanceof kind)) throw new Error(`Metric ${def.name} is already registered with another type`);
  return found;
}

/** The counter of `def` on `registry`, created on first use. */
export function ensureCounter<L extends string = string>(registry: Registry, def: MetricDef): Counter<L> {
  return (
    (existing(registry, def, Counter) as Counter<L> | undefined) ??
    new Counter<L>({ name: def.name, help: def.help, labelNames: [...def.labelNames] as L[], registers: [registry] })
  );
}

/** The gauge of `def` on `registry`, created on first use. */
export function ensureGauge<L extends string = string>(registry: Registry, def: MetricDef): Gauge<L> {
  return (
    (existing(registry, def, Gauge) as Gauge<L> | undefined) ??
    new Gauge<L>({ name: def.name, help: def.help, labelNames: [...def.labelNames] as L[], registers: [registry] })
  );
}

/** The histogram of `def` on `registry`, created on first use. */
export function ensureHistogram<L extends string = string>(registry: Registry, def: MetricDef): Histogram<L> {
  return (
    (existing(registry, def, Histogram) as Histogram<L> | undefined) ??
    new Histogram<L>({
      name: def.name,
      help: def.help,
      labelNames: [...def.labelNames] as L[],
      buckets: [...(def.buckets ?? LATENCY_BUCKETS)],
      registers: [registry],
    })
  );
}

/** One sample of a collected or derived metric. */
export interface MetricSample {
  labels: Record<string, string | number>;
  value: number;
  /** Full sample name for histogram series (`<name>_bucket`, `_sum`, `_count`); default the metric name. */
  metricName?: string;
}

/**
 * A metric object whose samples are produced when the registry is read (Prometheus text or JSON). It implements
 * the part of the prom-client metric interface the registry uses (`name`, `help`, `type`, `aggregator`, `get`,
 * `reset`), so it renders like any other metric.
 */
export class CollectedMetric {
  readonly aggregator = 'sum';

  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: MetricKind,
    private readonly read: () => Promise<MetricSample[]> | MetricSample[],
  ) {}

  async get(): Promise<{ name: string; help: string; type: MetricKind; aggregator: string; values: MetricSample[] }> {
    let values: MetricSample[] = [];
    try {
      values = await this.read();
    } catch {
      // A failing source never breaks the scrape; the metric is rendered without samples.
      values = [];
    }
    return { name: this.name, help: this.help, type: this.type, aggregator: this.aggregator, values };
  }

  reset(): void {
    // Values come from the source on every read.
  }
}

/**
 * Registers a collected metric. A collected metric registered earlier under the same name is replaced (a module
 * initialised twice on one registry); a regular metric of that name is an error.
 */
export function registerCollected(registry: Registry, def: MetricDef, read: () => Promise<MetricSample[]> | MetricSample[]): CollectedMetric {
  const current = registry.getSingleMetric(def.name) as unknown;
  if (current !== undefined) {
    if (!(current instanceof CollectedMetric)) throw new Error(`Metric ${def.name} is already registered and is not a collected metric`);
    registry.removeSingleMetric(def.name);
  }
  const metric = new CollectedMetric(def.name, def.help, def.type, read);
  registry.registerMetric(metric as unknown as Metric);
  return metric;
}

export interface DerivedMetricSource {
  /** Name of the source metric on the same registry. */
  readonly name: string;
  /** Keeps the samples whose labels match every entry (a list means any of its values). */
  readonly where?: Readonly<Record<string, string | readonly string[]>>;
  /** Labels removed from the samples (typically the ones fixed by `where`). */
  readonly dropLabels?: readonly string[];
}

/** Publishes a slice of another metric under `def.name` (see the file comment). An absent source has no samples. */
export function registerDerived(registry: Registry, def: MetricDef, source: DerivedMetricSource): CollectedMetric {
  return registerCollected(registry, def, async () => {
    const metric = registry.getSingleMetric(source.name);
    if (!metric) return [];
    const data = (await metric.get()) as { values?: { labels?: Record<string, string | number>; value: number; metricName?: string }[] };
    const out: MetricSample[] = [];
    for (const sample of data.values ?? []) {
      const labels = { ...(sample.labels ?? {}) };
      if (!matches(labels, source.where)) continue;
      for (const label of source.dropLabels ?? []) delete labels[label];
      const metricName = sample.metricName && sample.metricName.startsWith(source.name) ? def.name + sample.metricName.slice(source.name.length) : undefined;
      out.push({ labels, value: sample.value, ...(metricName ? { metricName } : {}) });
    }
    return mergeSamples(out);
  });
}

function matches(labels: Record<string, string | number>, where: DerivedMetricSource['where']): boolean {
  if (!where) return true;
  for (const [key, wanted] of Object.entries(where)) {
    const value = labels[key];
    if (value === undefined) return false;
    const accepted: readonly string[] = typeof wanted === 'string' ? [wanted] : wanted;
    if (!accepted.includes(String(value))) return false;
  }
  return true;
}

/** Sums samples that became identical after labels were dropped. */
function mergeSamples(samples: MetricSample[]): MetricSample[] {
  const byKey = new Map<string, MetricSample>();
  for (const sample of samples) {
    const key = `${sample.metricName ?? ''}|${JSON.stringify(Object.entries(sample.labels).sort(([a], [b]) => a.localeCompare(b)))}`;
    const found = byKey.get(key);
    if (found) found.value += sample.value;
    else byKey.set(key, { ...sample, labels: { ...sample.labels } });
  }
  return [...byKey.values()];
}
