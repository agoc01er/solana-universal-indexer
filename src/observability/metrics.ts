/**
 * Exposes Prometheus-compatible /metrics endpoint for operational monitoring.
 */

interface Counter {
  name: string;
  help: string;
  labels: Record<string, string>;
  value: number;
}

interface Gauge {
  name: string;
  help: string;
  value: number;
}

interface Histogram {
  name: string;
  help: string;
  buckets: number[];
  counts: number[];
  sum: number;
  total: number;
}

class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  // ── Counters ────────────────────────────────────────────────────────────────

  incrementCounter(name: string, help: string, labels: Record<string, string> = {}, by = 1) {
    const key = `${name}:${JSON.stringify(labels)}`;
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.counters.set(key, { name, help, labels, value: by });
    }
  }

  // ── Gauges ──────────────────────────────────────────────────────────────────

  setGauge(name: string, help: string, value: number) {
    this.gauges.set(name, { name, help, value });
  }

  // ── Histograms ───────────────────────────────────────────────────────────────

  observeHistogram(name: string, help: string, value: number, buckets = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]) {
    const existing = this.histograms.get(name);
    if (existing) {
      existing.sum += value;
      existing.total++;
      for (let i = 0; i < existing.buckets.length; i++) {
        if (value <= existing.buckets[i]) existing.counts[i]++;
      }
    } else {
      const counts = new Array(buckets.length).fill(0);
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]) counts[i]++;
      }
      this.histograms.set(name, { name, help, buckets, counts, sum: value, total: 1 });
    }
  }

  // ── Prometheus text format ───────────────────────────────────────────────────

  render(): string {
    const lines: string[] = [];

    // Counters
    for (const [, counter] of this.counters) {
      lines.push(`# HELP ${counter.name} ${counter.help}`);
      lines.push(`# TYPE ${counter.name} counter`);
      const labelStr = Object.entries(counter.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      lines.push(`${counter.name}${labelStr ? `{${labelStr}}` : ''} ${counter.value}`);
    }

    // Gauges
    for (const [, gauge] of this.gauges) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      lines.push(`${gauge.name} ${gauge.value}`);
    }

    // Histograms
    for (const [, hist] of this.histograms) {
      lines.push(`# HELP ${hist.name} ${hist.help}`);
      lines.push(`# TYPE ${hist.name} histogram`);
      let cumulativeCount = 0;
      for (let i = 0; i < hist.buckets.length; i++) {
        cumulativeCount += hist.counts[i];
        lines.push(`${hist.name}_bucket{le="${hist.buckets[i]}"} ${cumulativeCount}`);
      }
      lines.push(`${hist.name}_bucket{le="+Inf"} ${hist.total}`);
      lines.push(`${hist.name}_sum ${hist.sum}`);
      lines.push(`${hist.name}_count ${hist.total}`);
    }

    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();

// ── Convenience helpers ────────────────────────────────────────────────────────

export function recordTxProcessed(program: string, status: 'ok' | 'skipped' | 'error') {
  metrics.incrementCounter(
    'indexer_transactions_total',
    'Total transactions processed',
    { program, status }
  );
}

export function recordTxLatency(ms: number) {
  metrics.observeHistogram(
    'indexer_tx_processing_ms',
    'Transaction processing latency in milliseconds',
    ms,
    [1, 5, 10, 25, 50, 100, 250, 500, 1000]
  );
}

export function recordRpcError(method: string) {
  metrics.incrementCounter(
    'indexer_rpc_errors_total',
    'RPC call errors',
    { method }
  );
}

export function recordRpcCall(method: string, latencyMs: number) {
  metrics.observeHistogram(
    'indexer_rpc_latency_ms',
    'RPC call latency in milliseconds',
    latencyMs,
    [10, 50, 100, 250, 500, 1000, 2000, 5000]
  );
}

export function setSlotLag(lag: number) {
  metrics.setGauge('indexer_slot_lag', 'Slots behind chain tip', lag);
}

export function setLastProcessedSlot(slot: number) {
  metrics.setGauge('indexer_last_processed_slot', 'Last successfully processed slot', slot);
}

export function recordEventDecoded(eventName: string) {
  metrics.incrementCounter(
    'indexer_events_decoded_total',
    'Anchor events decoded',
    { event: eventName }
  );
}

export function recordInstructionIndexed(ixName: string) {
  metrics.incrementCounter(
    'indexer_instructions_indexed_total',
    'Instructions indexed',
    { instruction: ixName }
  );
}
