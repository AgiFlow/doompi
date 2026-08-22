import fs from 'node:fs';
import path from 'node:path';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { DoomHarnessContext } from '@agimon-ai/doompi-config/types';
import type { Context } from '@deepseek-ai/cordis';

/** The harness slice every surface of this package reads off the session. */
export function harnessContext(root: string, overrides: Partial<DoomHarnessContext> = {}): DoomHarnessContext {
  return {
    root,
    majorMode: 'copilot',
    domains: ['default'],
    layers: [],
    skillDirectories: [],
    agentDirectories: [],
    additionalDirectories: [],
    childExtensions: [],
    pluginDirectories: [],
    pluginHooks: [],
    profileEnvironment: {},
    hooks: true,
    agents: true,
    mcp: true,
    allowProtectedWrites: false,
    ...overrides,
  };
}

export function bindConfig(ctx: Context, root: string, overrides: Partial<DoomHarnessContext> = {}): void {
  provideDoomConfigContext(ctx, {
    settings: { projectTrust: 'ask' },
    harness: harnessContext(root, overrides),
    requiresRelaunch: false,
  });
}

/** A `.doom/domains.yaml` with one described, plugin-free domain per name. */
export function writeDomains(root: string, names: string[]): void {
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.doom', 'domains.yaml'),
    `domains:\n${names.map((name) => `  ${name}:\n    description: ${name} tools\n    plugins: []`).join('\n')}\n`,
  );
}
