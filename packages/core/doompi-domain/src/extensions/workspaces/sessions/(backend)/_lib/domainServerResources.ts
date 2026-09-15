import { readFile } from 'node:fs/promises';
import os from 'node:os';

import { listDomainNames, resolvePluginEntries } from '@agimon-ai/doompi-config/domains';
import type { DoomHeadlessExecutionContext, DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';

import { materializePluginEntries } from '../../../../../services/pluginMaterializer';
import { collectResources } from '../../../../../services/resourceCollector';

/** Register configured skills with domain conditions so selection changes reconcile them. */
export async function domainServerResources(context: DoomHeadlessExecutionContext): Promise<DoomHeadlessResource[]> {
  const resources: DoomHeadlessResource[] = [];
  const home = context.environment.HOME ?? os.homedir();
  for (const domain of listDomainNames(context.repoRoot, home)) {
    const plugins = await materializePluginEntries(resolvePluginEntries(context.repoRoot, [domain], [], home));
    const collected = await collectResources(context.repoRoot, plugins, {
      agents: false,
      mcp: false,
      sharedSkills: false,
    });
    try {
      for (const file of collected.skillDirectories) {
        const text = await readFile(file, 'utf8');
        const name = /^name:\s*["']?([^\n"']+)/m.exec(text)?.[1]?.trim();
        if (!name) throw new Error(`Domain skill has no name: ${file}`);
        resources.push({
          name,
          kind: 'skill',
          when: { domain, attribution: { kind: 'domain', mode: domain } },
          read: () => text,
        });
      }
    } finally {
      await collected.cleanup();
    }
  }
  return resources;
}
