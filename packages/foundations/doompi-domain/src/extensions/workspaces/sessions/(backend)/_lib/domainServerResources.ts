import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listDomainNames, resolvePluginEntries } from '@agimon-ai/doompi-config/domains';
import type { DoomHeadlessExecutionContext, DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';

import { materializePluginEntries } from '../../../../../services/pluginMaterializer';
import { collectResources } from '../../../../../services/resourceCollector';

/** Retain valid domains behind selection conditions; a broken neighbor must not prevent startup. */
export async function domainServerResources(context: DoomHeadlessExecutionContext): Promise<DoomHeadlessResource[]> {
  const resources: DoomHeadlessResource[] = [];
  const home = context.environment.HOME ?? os.homedir();
  for (const domain of listDomainNames(context.repoRoot, home)) {
    // Own staging here so collection failures also release their temporary files.
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'doom-domain-'));
    try {
      const plugins = await materializePluginEntries(resolvePluginEntries(context.repoRoot, [domain], [], home));
      const collected = await collectResources(context.repoRoot, plugins, {
        agents: false,
        mcp: false,
        sharedSkills: false,
        temporaryDirectory,
      });
      for (const skill of collected.skillSources) {
        resources.push({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          kind: 'skill',
          when: { domain, attribution: { kind: 'domain', mode: domain } },
          read: () => readFile(skill.path, 'utf8'),
        });
      }
    } catch (error) {
      await context.client.notify({
        title: `DoomPi domain ${domain} unavailable`,
        body: error instanceof Error ? error.message : String(error),
        level: 'warning',
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return resources;
}
