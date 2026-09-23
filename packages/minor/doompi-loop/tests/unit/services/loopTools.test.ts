import type { DoomPluginToolExecution } from '@agimon-ai/doompi-core/piExtension';
import { describe, expect, it, vi } from 'vitest';

import { createDoomLoopLaunchersService } from '../../../src/services/loopLaunchers';
import { createLoopTools } from '../../../src/services/loopTools';

function fixture() {
  let enabled = false;
  const service = createDoomLoopLaunchersService({
    generation: 'test',
    createInstanceId: () => 'instance',
    timestamp: () => '2026-01-01T00:00:00Z',
  });
  const stop = vi.fn();
  const launch = vi.fn(async ({ instanceId }: { instanceId: string }) => ({ instanceId, stop }));
  service.register({
    id: 'contributed',
    source: 'test-extension',
    label: 'Contributed loop',
    inputSchema: { type: 'object' },
    launch,
  });
  const tools = createLoopTools(
    () => service,
    () => {
      if (!enabled) throw new Error('Loop mode is inactive.');
    },
  );
  const execution: DoomPluginToolExecution = {
    cwd: '/test',
    toolCallId: 'test',
    notify: vi.fn(),
    update: vi.fn(),
    signal: new AbortController().signal,
  };
  return {
    service,
    launch,
    stop,
    execution,
    enable(value = true) {
      enabled = value;
    },
    tool(name: string) {
      return tools.find((tool) => tool.name === name)!;
    },
  };
}

describe('agent loop tools', () => {
  it('lists provider schemas and starts a contributed loop without interactive setup', async () => {
    const test = fixture();
    test.enable();
    const catalog = await test.tool('loop_list').execute({}, test.execution);
    expect(catalog.details).toMatchObject({
      launchers: [{ id: 'contributed', inputSchema: { type: 'object' } }],
      instances: [],
    });
    await test
      .tool('loop_start')
      .execute({ launcherId: 'contributed', input: { projectId: 'project' } }, test.execution);
    expect(test.launch).toHaveBeenCalledWith(
      expect.objectContaining({ input: { projectId: 'project' }, interactive: false }),
    );
    expect(test.service.listInstances()).toHaveLength(1);
    await test.tool('loop_stop').execute({ instanceId: 'instance' }, test.execution);
    expect(test.stop).toHaveBeenCalledOnce();
    expect(test.service.listInstances()).toEqual([]);
    await test.service.dispose();
  });

  it('rejects cached tools when mode is off without stopping manually owned loops', async () => {
    const test = fixture();
    await test.service.launch('contributed');
    await expect(test.tool('loop_list').execute({}, test.execution)).rejects.toThrow('inactive');
    test.enable();
    await expect(test.tool('loop_list').execute({}, test.execution)).resolves.toBeDefined();
    test.enable(false);
    await expect(test.tool('loop_stop').execute({ instanceId: 'instance' }, test.execution)).rejects.toThrow(
      'inactive',
    );
    expect(test.service.listInstances()).toHaveLength(1);
    await test.service.stop('instance');
    await test.service.dispose();
  });

  it('validates tool arguments before invoking a launcher', async () => {
    const test = fixture();
    test.enable();
    await expect(test.tool('loop_start').execute({ launcherId: 'contributed' }, test.execution)).rejects.toThrow(
      'input',
    );
    expect(test.launch).not.toHaveBeenCalled();
    await test.service.dispose();
  });

  it('refuses interactive-only providers for agent calls but permits manual launches', async () => {
    const test = fixture();
    test.enable();
    test.service.register({ id: 'manual', source: 'test', label: 'Manual', launch: test.launch });
    await expect(test.tool('loop_start').execute({ launcherId: 'manual', input: {} }, test.execution)).rejects.toThrow(
      'manual setup',
    );
    expect(test.launch).not.toHaveBeenCalled();
    await test.service.launch('manual');
    expect(test.launch).toHaveBeenCalledOnce();
    await test.service.dispose();
  });

  it('rejects an aborted request before creating an instance', async () => {
    const test = fixture();
    test.enable();
    await expect(
      test
        .tool('loop_start')
        .execute({ launcherId: 'contributed', input: {} }, { ...test.execution, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(test.launch).not.toHaveBeenCalled();
    expect(test.service.listInstances()).toEqual([]);
    await test.service.dispose();
  });
});
