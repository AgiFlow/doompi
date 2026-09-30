import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface RuntimeResourceSample {
  monotonicMs: number;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
}

/** Process CPU percent uses one logical core as 100%, not the whole host. */
export function resourceAttributes(
  previous: RuntimeResourceSample,
  current: RuntimeResourceSample,
): Record<string, number> {
  const elapsed = Math.max(1, current.monotonicMs - previous.monotonicMs);
  const user = Math.max(0, current.cpu.user - previous.cpu.user);
  const system = Math.max(0, current.cpu.system - previous.cpu.system);
  return {
    host_pid: process.pid,
    interval_ms: elapsed,
    cpu_percent: ((user + system) / (elapsed * 1_000)) * 100,
    cpu_user_ms: user / 1_000,
    cpu_system_ms: system / 1_000,
    rss_bytes: current.memory.rss,
    heap_used_bytes: current.memory.heapUsed,
    heap_total_bytes: current.memory.heapTotal,
    external_bytes: current.memory.external,
    array_buffers_bytes: current.memory.arrayBuffers,
  };
}

/** One bounded exporter per server, never one stream or unbounded queue per session. */
export function monitorRuntimeResources(options: {
  record(attributes: Record<string, number>): Promise<unknown>;
  counts(): Record<string, number>;
  warn(message: string): void;
  intervalMs?: number;
}): () => void {
  const interval = options.intervalMs ?? 10_000;
  if (!Number.isFinite(interval) || interval < 1) throw new RangeError('Resource interval must be positive');
  const snapshot = (): RuntimeResourceSample => ({
    monotonicMs: performance.now(),
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
  });
  let previous = snapshot();
  let utilization = performance.eventLoopUtilization();
  let pending = false;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    try {
      const current = snapshot();
      const currentUtilization = performance.eventLoopUtilization();
      const deltaUtilization = performance.eventLoopUtilization(currentUtilization, utilization);
      const attributes = {
        ...resourceAttributes(previous, current),
        ...options.counts(),
        event_loop_utilization: deltaUtilization.utilization,
        event_loop_p99_ms: histogram.count ? histogram.percentile(99) / 1e6 : 0,
        event_loop_max_ms: histogram.count ? histogram.max / 1e6 : 0,
      };
      previous = current;
      utilization = currentUtilization;
      histogram.reset();
      void Promise.resolve(options.record(attributes))
        .catch((error: unknown) => {
          options.warn(`Resource telemetry failed: ${String(error)}`);
        })
        .finally(() => {
          pending = false;
        });
    } catch (error) {
      pending = false;
      options.warn(`Resource sampling failed: ${String(error)}`);
    }
  }, interval);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
