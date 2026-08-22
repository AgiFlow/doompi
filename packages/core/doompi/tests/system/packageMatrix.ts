import path from 'node:path';

export const REPOSITORY_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../');

export type PackageLayer = 'core' | 'default' | 'minor' | 'team' | 'task' | 'ask-user';
export type PiManifestEntry = './dist/extensions/pi.mjs';

export interface PackageMatrixEntry {
  readonly name: string;
  readonly relativeDirectory: string;
  readonly layer: PackageLayer;
  readonly piExport?: './extensions/pi';
  readonly piManifestEntry?: PiManifestEntry;
  readonly resources: readonly string[];
}

export interface RunnerNativeTarget {
  readonly platform: string;
  readonly architecture: string;
  readonly packageName: string;
}

const PI_EXPORT = './extensions/pi' as const;
const PI_MANIFEST_ENTRY = './dist/extensions/pi.mjs' as const;

const OWNED_PACKAGE_DIRECTORIES: Readonly<Record<string, string>> = {
  '@agimon-ai/doompi': 'packages/core/doompi',
  '@agimon-ai/doompi-autocompact': 'packages/default/doompi-autocompact',
  '@agimon-ai/doompi-autostop': 'packages/core/doompi-autostop',
  '@agimon-ai/doompi-cache': 'packages/core/doompi-cache',
  '@agimon-ai/doompi-config': 'packages/core/doompi-config',
  '@agimon-ai/doompi-domain': 'packages/core/doompi-domain',
  '@agimon-ai/doompi-edit': 'packages/default/doompi-edit',
  '@agimon-ai/doompi-extension-contracts': 'packages/core/doompi-extension-contracts',
  '@agimon-ai/doompi-file-edit': 'packages/default/doompi-file-edit',
  '@agimon-ai/doompi-goal': 'packages/minor/doompi-goal',
  '@agimon-ai/doompi-grep': 'packages/default/doompi-grep',
  '@agimon-ai/doompi-hashline': 'packages/core/doompi-hashline',
  '@agimon-ai/doompi-help': 'packages/minor/doompi-help',
  '@agimon-ai/doompi-hook': 'packages/default/doompi-hook',
  '@agimon-ai/doompi-log': 'packages/default/doompi-log',
  '@agimon-ai/doompi-loop': 'packages/minor/doompi-loop',
  '@agimon-ai/doompi-major-mode': 'packages/core/doompi-major-mode',
  '@agimon-ai/doompi-mcp': 'packages/default/doompi-mcp',
  '@agimon-ai/doompi-notification': 'packages/core/doompi-notification',
  '@agimon-ai/doompi-plan': 'packages/minor/doompi-plan',
  '@agimon-ai/doompi-profile': 'packages/core/doompi-profile',
  '@agimon-ai/doompi-read': 'packages/default/doompi-read',
  '@agimon-ai/doompi-runner': 'packages/default/doompi-runner',
  '@agimon-ai/doompi-runner-rmux-darwin-arm64': 'packages/default/doompi-runner-rmux-darwin-arm64',
  '@agimon-ai/doompi-runner-rmux-darwin-x64': 'packages/default/doompi-runner-rmux-darwin-x64',
  '@agimon-ai/doompi-runner-rmux-linux-arm64': 'packages/default/doompi-runner-rmux-linux-arm64',
  '@agimon-ai/doompi-runner-rmux-linux-x64': 'packages/default/doompi-runner-rmux-linux-x64',
  '@agimon-ai/doompi-runner-rtk-darwin-arm64': 'packages/default/doompi-runner-rtk-darwin-arm64',
  '@agimon-ai/doompi-runner-rtk-darwin-x64': 'packages/default/doompi-runner-rtk-darwin-x64',
  '@agimon-ai/doompi-runner-rtk-linux-arm64': 'packages/default/doompi-runner-rtk-linux-arm64',
  '@agimon-ai/doompi-runner-rtk-linux-x64': 'packages/default/doompi-runner-rtk-linux-x64',
  '@agimon-ai/doompi-skill': 'packages/core/doompi-skill',
  '@agimon-ai/doompi-task': 'layers/task/doompi-task',
  '@agimon-ai/doompi-team': 'layers/team/doompi-team',
  '@agimon-ai/doompi-telemetry': 'packages/core/doompi-telemetry',
  '@agimon-ai/doompi-ui': 'packages/core/doompi-ui',
  '@agimon-ai/doompi-user-feedback': 'layers/ask-user/doompi-user-feedback',
  '@agimon-ai/doompi-voice': 'packages/minor/doompi-voice',
  '@agimon-ai/doompi-workflow': 'packages/minor/doompi-workflow',
};

const STANDARD_PI_NAMES = [
  '@agimon-ai/doompi-autocompact',
  '@agimon-ai/doompi-autostop',
  '@agimon-ai/doompi-cache',
  '@agimon-ai/doompi-config',
  '@agimon-ai/doompi-domain',
  '@agimon-ai/doompi-edit',
  '@agimon-ai/doompi-file-edit',
  '@agimon-ai/doompi-goal',
  '@agimon-ai/doompi-grep',
  '@agimon-ai/doompi-help',
  '@agimon-ai/doompi-hook',
  '@agimon-ai/doompi-log',
  '@agimon-ai/doompi-loop',
  '@agimon-ai/doompi-major-mode',
  '@agimon-ai/doompi-mcp',
  '@agimon-ai/doompi-notification',
  '@agimon-ai/doompi-ui',
  '@agimon-ai/doompi-plan',
  '@agimon-ai/doompi-profile',
  '@agimon-ai/doompi-read',
  '@agimon-ai/doompi-runner',
  '@agimon-ai/doompi-skill',
  '@agimon-ai/doompi-task',
  '@agimon-ai/doompi-team',
  '@agimon-ai/doompi-user-feedback',
  '@agimon-ai/doompi-voice',
  '@agimon-ai/doompi-workflow',
] as const;

const PACKAGE_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  '@agimon-ai/doompi': [
    './llms.txt',
    './README.md',
    './src/prompts/doompi-author-extension/SKILL.md',
    './src/prompts/doompi-author-extension/references/extension-contract.md',
  ],
  '@agimon-ai/doompi-cache': ['./llms.txt', './README.md', './src/prompts/doompi-use-cache/SKILL.md'],
  '@agimon-ai/doompi-config': [
    './llms.txt',
    './README.md',
    './src/prompts/doompi-author-config/SKILL.md',
    './src/prompts/doompi-author-config/agents/openai.yaml',
    './src/prompts/doompi-author-config/references/config-contract.md',
  ],
  '@agimon-ai/doompi-domain': [
    './llms.txt',
    './README.md',
    './src/prompts/doompi-author-domain/SKILL.md',
    './src/prompts/doompi-author-domain/references/domains-contract.md',
  ],
  '@agimon-ai/doompi-goal': ['./llms.txt', './README.md', './src/prompts/doompi-use-goal/SKILL.md'],
  '@agimon-ai/doompi-help': ['./llms.txt', './README.md', './src/prompts/doompi-use-help/SKILL.md'],
  '@agimon-ai/doompi-hook': ['./llms.txt', './README.md', './src/prompts/doompi-author-hook/SKILL.md'],
  '@agimon-ai/doompi-loop': ['./llms.txt', './README.md', './src/prompts/doompi-use-loop/SKILL.md'],
  '@agimon-ai/doompi-major-mode': [
    './llms.txt',
    './README.md',
    './src/prompts/doompi-author-major-mode/SKILL.md',
    './src/prompts/doompi-author-major-mode/references/modes-contract.md',
  ],
  '@agimon-ai/doompi-mcp': ['./llms.txt', './README.md', './src/prompts/doompi-use-mcp/SKILL.md'],
  '@agimon-ai/doompi-plan': ['./llms.txt', './README.md', './src/prompts/doompi-use-plan/SKILL.md'],
  '@agimon-ai/doompi-profile': [
    './llms.txt',
    './README.md',
    './src/prompts/doompi-author-profile/SKILL.md',
    './src/prompts/doompi-author-profile/references/profiles-contract.md',
  ],
  '@agimon-ai/doompi-runner': [
    './llms.txt',
    './README.md',
    './skills/doom-runner/SKILL.md',
    './src/prompts/doompi-use-runner/SKILL.md',
  ],
  '@agimon-ai/doompi-skill': [
    './llms.txt',
    './README.md',
    './src/prompts/doompi-author-skill/SKILL.md',
    './src/prompts/doompi-use-skill/SKILL.md',
  ],
  '@agimon-ai/doompi-ui': ['./themes/doom-pi-dark.json'],
  '@agimon-ai/doompi-voice': ['./llms.txt', './README.md', './src/prompts/doompi-use-voice/SKILL.md'],
  '@agimon-ai/doompi-workflow': [
    './llms.txt',
    './README.md',
    './skills/workflow-recovery/SKILL.md',
    './src/prompts/doompi-author-workflow/SKILL.md',
    './src/prompts/doompi-use-workflow/SKILL.md',
  ],
};

export const OWNED_PACKAGE_NAMES = Object.keys(OWNED_PACKAGE_DIRECTORIES) as readonly string[];
export const STANDARD_PI_PACKAGE_NAMES = STANDARD_PI_NAMES;

function packageDirectoryFor(name: string): string {
  const ownedDirectory = OWNED_PACKAGE_DIRECTORIES[name];
  if (!ownedDirectory) throw new Error(`No package directory is registered for ${name}`);
  return ownedDirectory;
}

function packageLayerFor(relativeDirectory: string): PackageLayer {
  if (relativeDirectory.startsWith('packages/core/')) return 'core';
  if (relativeDirectory.startsWith('packages/default/')) return 'default';
  if (relativeDirectory.startsWith('packages/minor/')) return 'minor';
  if (relativeDirectory.startsWith('layers/team/')) return 'team';
  if (relativeDirectory.startsWith('layers/task/')) return 'task';
  return 'ask-user';
}

export function packageRootFor(name: string): string {
  return path.resolve(REPOSITORY_ROOT, packageDirectoryFor(name));
}

function createEntry(name: string): PackageMatrixEntry {
  const relativeDirectory = packageDirectoryFor(name);
  return {
    name,
    relativeDirectory,
    layer: packageLayerFor(relativeDirectory),
    resources: [],
  };
}

const packageEntries = OWNED_PACKAGE_NAMES.map(createEntry);

export const PACKAGE_MATRIX: readonly PackageMatrixEntry[] = packageEntries.map((entry) => {
  const piName = STANDARD_PI_NAMES.find((name) => name === entry.name);
  const resources = PACKAGE_RESOURCES[entry.name] ?? [];
  return {
    ...entry,
    ...(piName ? { piExport: PI_EXPORT, piManifestEntry: PI_MANIFEST_ENTRY } : {}),
    resources,
  };
});

export const STANDARD_PI_ENTRIES = PACKAGE_MATRIX.filter(
  (entry): entry is PackageMatrixEntry & { piExport: './extensions/pi'; piManifestEntry: PiManifestEntry } =>
    entry.piExport !== undefined && entry.piManifestEntry !== undefined,
);

export const RESOURCES_BY_PACKAGE: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  PACKAGE_MATRIX.filter((entry) => entry.resources.length > 0).map((entry) => [entry.name, entry.resources]),
);

export const RMUX_TARGETS: readonly RunnerNativeTarget[] = [
  { platform: 'darwin', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rmux-darwin-arm64' },
  { platform: 'darwin', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rmux-darwin-x64' },
  { platform: 'linux', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rmux-linux-arm64' },
  { platform: 'linux', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rmux-linux-x64' },
];

export const RTK_TARGETS: readonly RunnerNativeTarget[] = [
  { platform: 'darwin', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rtk-darwin-arm64' },
  { platform: 'darwin', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rtk-darwin-x64' },
  { platform: 'linux', architecture: 'arm64', packageName: '@agimon-ai/doompi-runner-rtk-linux-arm64' },
  { platform: 'linux', architecture: 'x64', packageName: '@agimon-ai/doompi-runner-rtk-linux-x64' },
];

export const FORBIDDEN_PACK_CONTENT = [
  '"workspace:',
  "'workspace:",
  '"link:',
  "'link:",
  'packages/rigs/',
  '/.git/',
  '\\ .git\\',
  '@agimonai/rig-',
  '@agimonai/',
  '@agiflowai/',
  'doompi-capabilities',
  'extensions/doom',
] as const;

export function packageEntryFor(name: string): PackageMatrixEntry {
  const entry = PACKAGE_MATRIX.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`No package matrix entry is registered for ${name}`);
  return entry;
}
