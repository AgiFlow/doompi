import { describe, expect, it, vi } from 'vitest';

import { createLogViewRuntime } from '../src/tui/logRuntime';

describe('log view runtime diagnostics', () => {
  it('routes stderr diagnostics only when requested, and ignores callbacks after disposal', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const onSinkStatus = vi.fn();
      const runtime = createLogViewRuntime(async () => {}, {
        env: { AGENT_OTEL_DIAGNOSTICS: 'stderr' },
        onSinkStatus,
      });
      const status = {
        service: 'pi',
        backend: 'logsink',
        endpoint: 'local',
        endpointSource: 'env',
        traces: false,
        redaction: true,
        fileFallback: false,
      };

      runtime.telemetryOptions.onDiagnostic?.('before disposal');
      runtime.telemetryOptions.onSinkStatus?.(status);
      expect(warning).toHaveBeenCalledWith('before disposal');
      expect(onSinkStatus).toHaveBeenCalledWith(status);

      await runtime.onDispose();
      runtime.telemetryOptions.onDiagnostic?.('after disposal');
      runtime.telemetryOptions.onSinkStatus?.(status);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(onSinkStatus).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
