import { createPiTestHost, standardExtensionScenarios } from '@agimon-ai/doompi-extension-contracts/testing';
import { describe, expect, it, vi } from 'vitest';
import { activateComputerUseExtension, COMPUTER_USE_TOOL_NAMES } from '../../../src/adapters/pi/extension.ts';
import { COMMAND_NAME } from '../../../src/commands/computerUseCommand.ts';
import type { ComputerUseSessionClient } from '../../../src/adapters/pi/sessionApiClient.ts';
import type { ComputerUseSessionView } from '../../../src/types/computerUseApi.ts';
import type { ComputerUseExtensionDependencies, ComputerUseExtensionService } from '../../../src/types/extension.ts';

describe('the standard Pi entry contract', () => {
  for (const scenario of standardExtensionScenarios({
    factory: activateComputerUseExtension,
    commands: [COMMAND_NAME],
    tools: COMPUTER_USE_TOOL_NAMES,
  }))
    it(scenario.name, () => scenario.run());
});

describe('doompi-computer-use Pi extension', () => {
  it('registers static tools but removes only its names while dormant', async () => {
    const host = createPiTestHost();
    await activateComputerUseExtension(host.pi);
    expect(host.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...COMPUTER_USE_TOOL_NAMES]));
    expect(host.activeTools()).not.toEqual(expect.arrayContaining([...COMPUTER_USE_TOOL_NAMES]));
    await host.dispose();
  });

  it('injects its service into the standalone command', async () => {
    const host = createPiTestHost();
    const service: ComputerUseExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };
    await activateComputerUseExtension(host.pi, { service });
    await host.runCommand(COMMAND_NAME);
    expect(service.execute).toHaveBeenCalledOnce();
    expect(host.notifications).toEqual([{ sessionId: 'test-session', message: 'ready', level: 'info' }]);
    await host.dispose();
  });

  it('exposes tools and guidance only while the session grant is active', async () => {
    const host = createPiTestHost();
    host.pi.setActiveTools(['read']);
    let phase: 'active' | 'inactive' = 'active';
    const client: ComputerUseSessionClient = {
      state: vi.fn(async (): Promise<ComputerUseSessionView> => ({
        sessionId: 'test-session',
        revision: 1,
        wake: 1,
        phase,
      })),
      observe: vi.fn(async () => ({ snapshotId: 'snapshot-1', elements: [] }) as never),
      act: vi.fn(async () => ({ applied: true })),
      stop: vi.fn(async (): Promise<ComputerUseSessionView> => ({
        sessionId: 'test-session',
        revision: 2,
        wake: 2,
        phase: 'stopping',
      })),
    };
    const dependencies: ComputerUseExtensionDependencies = {
      client,
      service: { execute: vi.fn(async () => ({ message: 'active', level: 'info' as const })) },
    };
    await activateComputerUseExtension(host.pi, dependencies);
    await host.emit('session_start', {});
    await vi.waitFor(() => expect(host.activeTools()).toEqual(['read', ...COMPUTER_USE_TOOL_NAMES]));

    await expect(host.callTool('computer_state')).resolves.toMatchObject({ details: { snapshotId: 'snapshot-1' } });
    await expect(
      host.callTool('computer_action', { kind: 'press', snapshotId: 'snapshot-1', elementRef: 'button-1' }),
    ).resolves.toMatchObject({ details: { applied: true } });
    const prompts = await host.emit('before_agent_start', { systemPrompt: 'base' });
    expect(prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemPrompt: expect.stringContaining('COMPUTER USE ACTIVE') }),
      ]),
    );

    phase = 'inactive';
    await host.emit('session_start', {});
    await vi.waitFor(() => expect(host.activeTools()).toEqual(['read']));
    await expect(host.callTool('computer_state')).rejects.toThrow(/not active/u);
    await host.dispose();
  });
});
