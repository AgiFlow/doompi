import { type ExtensionAPI, SettingsManager } from '@earendil-works/pi-coding-agent';

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function parseEffortLevel(args: string): ThinkingLevel | undefined {
  const [level] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return THINKING_LEVELS.find((candidate) => candidate === level);
}

export function effortUsage(): string {
  return `Usage: /effort <${THINKING_LEVELS.join('|')}>`;
}

export default function effortExtension(pi: ExtensionAPI): void {
  pi.registerCommand('effort', {
    description: 'Set thinking effort and persist it as the default for future sessions',
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      return THINKING_LEVELS.filter((level) => level.startsWith(query)).map((level) => ({
        value: level,
        label: level,
      }));
    },
    handler: async (args, ctx) => {
      const requestedLevel = parseEffortLevel(args);
      if (!requestedLevel) {
        ctx.ui.notify(`${effortUsage()}\nCurrent effort: ${pi.getThinkingLevel()}`, 'warning');
        return;
      }

      pi.setThinkingLevel(requestedLevel);
      const effectiveLevel = pi.getThinkingLevel();

      const settings = SettingsManager.create(ctx.cwd);
      settings.setDefaultThinkingLevel(requestedLevel);
      await settings.flush();

      const suffix = effectiveLevel === requestedLevel ? '' : ` Current model clamps it to ${effectiveLevel}.`;
      ctx.ui.notify(`Effort set to ${requestedLevel} and saved for future sessions.${suffix}`, 'info');
    },
  });
}
