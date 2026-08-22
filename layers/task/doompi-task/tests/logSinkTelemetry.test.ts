import type { DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createTaskErrorReporter, TASK_EVENT } from '../src/exports/logSinkTelemetry';

type TelemetryHandle = Awaited<ReturnType<NonNullable<DoomTelemetryOptions['telemetryFactory']>>>;

function createTelemetryDouble() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    getTraceContext: vi.fn(() => ({})),
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  const telemetry = {
    backend: 'logsink',
    enabled: true,
    logger,
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } as unknown as TelemetryHandle;
  const telemetryFactory = vi.fn(async () => telemetry);
  return { logger, telemetry, telemetryFactory };
}

describe('task telemetry', () => {
  it('records notification failures with safe task metadata', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({
      cwd: '/workspace',
      env: { AGENT_SESSION_ID: 'agent-session', AGENT_PARENT_SESSION_ID: 'parent-session' },
      telemetryFactory,
    });

    await reporter.recordNotificationError(new Error('private task text'), 42);

    expect(logger.error).toHaveBeenCalledWith(TASK_EVENT.notificationFailed, {
      attributes: {
        'telemetry.package': '@agimon-ai/doompi-task',
        'task.id': 42,
        'task.operation': 'completion_notification',
        'error.type': 'Error',
        outcome: 'error',
      },
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private task text');
  });

  it('deduplicates repeated store failures', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({ telemetryFactory });
    const error = new Error('unreadable');

    await reporter.recordError(TASK_EVENT.storeReadFailed, error, { 'store.path': '/private/tasks.json' });
    await reporter.recordError(TASK_EVENT.storeReadFailed, error, { 'store.path': '/private/tasks.json' });

    expect(logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('/private/tasks.json');
  });

  it('reports warnings without throwing when the sink is unavailable', async () => {
    const warn = vi.fn();
    const reporter = createTaskErrorReporter({
      telemetryFactory: vi.fn(async () => {
        throw new Error('sink unavailable');
      }),
      warn,
    });

    await expect(reporter.recordWarning(TASK_EVENT.storeLockTimeout, new Error('lock busy'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('supports fire-and-forget failure reporters', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({ telemetryFactory });

    await reporter.recordError(TASK_EVENT.toolFailed, new Error('failed'));

    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('records info events without the error framing', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({ telemetryFactory });

    await reporter.recordEvent(TASK_EVENT.delegationAssigned, { 'task.id': 7 });

    expect(logger.info).toHaveBeenCalledWith(TASK_EVENT.delegationAssigned, {
      attributes: { 'telemetry.package': '@agimon-ai/doompi-task', 'task.id': 7 },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not deduplicate repeated events, so the measurement stays countable', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({ telemetryFactory });

    await reporter.recordEvent(TASK_EVENT.delegationCompleted, { 'delegation.outcome': 'completed' });
    await reporter.recordEvent(TASK_EVENT.delegationCompleted, { 'delegation.outcome': 'completed' });

    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('keeps the delegation measurement attributes and drops path-bearing ones', async () => {
    const { logger, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({ telemetryFactory });

    await reporter.recordEvent(TASK_EVENT.delegationAssigned, {
      'task.id': 3,
      'delegation.request_id': 'req-abc',
      'delegation.agent_name': 'worker',
      'delegation.context_present': true,
      'delegation.context_file_count': 2,
      'delegation.context_notes_length': 40,
      'delegation.brief_length': 512,
      // Control: a path-bearing key must never reach the sink.
      'delegation.context_paths': '/Users/someone/secret/a.ts',
    });

    const attributes = logger.info.mock.calls[0]![1].attributes as Record<string, unknown>;
    expect(attributes['delegation.agent_name']).toBe('worker');
    expect(attributes['delegation.context_present']).toBe(true);
    expect(attributes['delegation.context_file_count']).toBe(2);
    expect(attributes['delegation.context_notes_length']).toBe(40);
    expect(attributes['delegation.brief_length']).toBe(512);
    // Hashed rather than passed through, but still stable enough to join on.
    expect(attributes['delegation.request_id']).toBeTypeOf('string');
    expect(attributes['delegation.request_id']).not.toBe('req-abc');
    expect(attributes).not.toHaveProperty('delegation.context_paths');
  });

  it('flushes and shuts down the initialized handle', async () => {
    const { telemetry, telemetryFactory } = createTelemetryDouble();
    const reporter = createTaskErrorReporter({ telemetryFactory });

    await reporter.recordNotificationError(new Error('failed'), 1);
    await reporter.flush();
    await reporter.shutdown();

    expect(telemetry.flush).toHaveBeenCalled();
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
  });
});
