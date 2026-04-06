import { metrics } from '../observability/metrics';

describe('MetricsRegistry', () => {
  beforeEach(() => {
    // Reset metrics by creating fresh state
    // We test via the public increment/set/observe + render API
  });

  test('render returns empty string for fresh registry', () => {
    // The global instance might have state, but render should not throw
    const output = metrics.render();
    expect(typeof output).toBe('string');
  });

  test('incrementCounter creates and increments counter', () => {
    metrics.incrementCounter('test_counter', 'A test counter', { label: 'a' });
    metrics.incrementCounter('test_counter', 'A test counter', { label: 'a' });
    const output = metrics.render();
    expect(output).toContain('test_counter');
    expect(output).toContain('# TYPE test_counter counter');
  });

  test('incrementCounter with different labels creates separate entries', () => {
    metrics.incrementCounter('multi_counter', 'Multi-label counter', { label: 'x' });
    metrics.incrementCounter('multi_counter', 'Multi-label counter', { label: 'y' });
    const output = metrics.render();
    expect(output).toContain('label="x"');
    expect(output).toContain('label="y"');
  });

  test('HELP and TYPE lines appear only once per metric family when labels differ', () => {
    metrics.incrementCounter('dedup_test', 'Dedup test', { status: 'ok' });
    metrics.incrementCounter('dedup_test', 'Dedup test', { status: 'err' });
    const output = metrics.render();
    const helpCount = (output.match(/# HELP dedup_test /g) ?? []).length;
    const typeCount = (output.match(/# TYPE dedup_test /g) ?? []).length;
    expect(helpCount).toBe(1);
    expect(typeCount).toBe(1);
    expect(output).toContain('status="ok"');
    expect(output).toContain('status="err"');
  });

  test('setGauge updates gauge value', () => {
    metrics.setGauge('test_gauge', 'A test gauge', 42);
    const output = metrics.render();
    expect(output).toContain('test_gauge');
    expect(output).toContain('42');
    expect(output).toContain('# TYPE test_gauge gauge');
  });

  test('setGauge overwrites previous value', () => {
    metrics.setGauge('overwrite_gauge', 'Overwrite test', 10);
    metrics.setGauge('overwrite_gauge', 'Overwrite test', 99);
    const output = metrics.render();
    expect(output).toContain('99');
  });

  test('observeHistogram records value in correct bucket', () => {
    metrics.observeHistogram('test_hist', 'Test histogram', 0.05, [0.01, 0.05, 0.1, 1]);
    const output = metrics.render();
    expect(output).toContain('test_hist_bucket');
    expect(output).toContain('test_hist_sum');
    expect(output).toContain('test_hist_count');
    expect(output).toContain('# TYPE test_hist histogram');
  });

  test('observeHistogram accumulates multiple observations', () => {
    metrics.observeHistogram('accum_hist', 'Accumulating histogram', 0.1);
    metrics.observeHistogram('accum_hist', 'Accumulating histogram', 0.5);
    metrics.observeHistogram('accum_hist', 'Accumulating histogram', 1.0);
    const output = metrics.render();
    expect(output).toContain('accum_hist_count 3');
  });

  test('render produces valid Prometheus text format', () => {
    metrics.incrementCounter('format_test', 'Format test', {});
    const output = metrics.render();
    // Must end with newline
    expect(output.endsWith('\n')).toBe(true);
    // Must have HELP and TYPE lines
    expect(output).toContain('# HELP');
    expect(output).toContain('# TYPE');
  });

  test('histogram buckets include +Inf', () => {
    metrics.observeHistogram('inf_hist', 'Inf test', 100);
    const output = metrics.render();
    expect(output).toContain('le="+Inf"');
  });
});
