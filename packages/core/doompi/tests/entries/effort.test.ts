import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import effortExtension, { effortUsage, parseEffortLevel } from '../../src/exports/entries/effort';

const setDefaultThinkingLevel = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  SettingsManager: { create: () => ({ setDefaultThinkingLevel, flush }) },
}));

interface RegisteredCommand {
  description: string;
  getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }>;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

/** Registers the extension and returns the command plus its collaborators. */
function registerEffort(effectiveLevel?: string) {
  let registered: RegisteredCommand | undefined;
  const setThinkingLevel = vi.fn();
  const pi = {
    registerCommand: (_name: string, command: RegisteredCommand) => {
      registered = command;
    },
    setThinkingLevel,
    getThinkingLevel: () => effectiveLevel ?? 'medium',
  } as unknown as ExtensionAPI;
  effortExtension(pi);
  const notify = vi.fn();
  const ctx = { cwd: '/repo', ui: { notify } } as unknown as ExtensionContext;
  return { command: registered as RegisteredCommand, ctx, notify, setThinkingLevel };
}

describe('effort entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses supported thinking effort levels', () => {
    expect(parseEffortLevel('high')).toBe('high');
    expect(parseEffortLevel('  XHIGH  ')).toBe('xhigh');
    expect(parseEffortLevel('medium extra words')).toBe('medium');
  });

  it('rejects unsupported effort levels', () => {
    expect(parseEffortLevel('')).toBeUndefined();
    expect(parseEffortLevel('extreme')).toBeUndefined();
  });

  it('documents the available levels', () => {
    expect(effortUsage()).toBe('Usage: /effort <off|minimal|low|medium|high|xhigh|max>');
  });

  it('registers a command that completes level names by prefix', () => {
    const { command } = registerEffort();

    expect(command.description).toContain('thinking effort');
    expect(command.getArgumentCompletions('m').map((item) => item.value)).toEqual(['minimal', 'medium', 'max']);
    expect(command.getArgumentCompletions('')).toHaveLength(7);
    expect(command.getArgumentCompletions('zzz')).toEqual([]);
  });

  it('applies and persists a requested level', async () => {
    const { command, ctx, notify, setThinkingLevel } = registerEffort('high');

    await command.handler('high', ctx);

    expect(setThinkingLevel).toHaveBeenCalledWith('high');
    expect(setDefaultThinkingLevel).toHaveBeenCalledWith('high');
    expect(flush).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Effort set to high and saved for future sessions.', 'info');
  });

  it('reports when the model clamps the requested level', async () => {
    const { command, ctx, notify } = registerEffort('medium');

    await command.handler('max', ctx);

    expect(notify).toHaveBeenCalledWith(
      'Effort set to max and saved for future sessions. Current model clamps it to medium.',
      'info',
    );
  });

  it('warns with the usage and current level for an unusable argument', async () => {
    const { command, ctx, notify, setThinkingLevel } = registerEffort('low');

    await command.handler('extreme', ctx);

    expect(setThinkingLevel).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(`${effortUsage()}\nCurrent effort: low`, 'warning');
  });
});
