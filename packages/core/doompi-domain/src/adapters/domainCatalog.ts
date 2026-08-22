import { requireHarnessRoot } from '@agimon-ai/doompi-config/harnessStore';
import { readDoomConfigSelection, requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { normalizeDomainNames } from '../services/domainText.ts';
import type { DomainCompletion, DomainListing } from '../types/domains.ts';

/**
 * The manifest reader every surface of this package shares.
 *
 * Every session registers `/domains`, but most never run it, so the plugin
 * catalogue and the domain manifest stay behind a dynamic import: only a session
 * that actually lists or switches domains pays to read them.
 */
export function createDomainCatalog(cordisContext: () => Context) {
  let config: Promise<typeof import('@agimon-ai/doompi-config/domains')> | undefined;
  const load = () => (config ??= import('@agimon-ai/doompi-config/domains'));

  const list = async (ctx: ExtensionContext): Promise<DomainListing> => {
    const configContext = requireDoomConfigContext(cordisContext());
    const state = configContext.harness;
    const repoRoot = requireHarnessRoot(state);
    const { defaultDomainsForMajorMode, listDomainNames, loadDomains } = await load();
    const available = [...new Set(listDomainNames(repoRoot))].sort();
    const manifest = loadDomains(repoRoot);
    // A journalled selection outranks the environment, but only once the switch
    // that produced it has settled: a pending one has not been applied yet.
    const selection = configContext.pendingSelection ? undefined : readDoomConfigSelection(ctx);
    const active = selection ? [...selection.domains] : [...state.domains];
    const fallback = defaultDomainsForMajorMode(state.majorMode, process.env, manifest.defaultDomains);
    const effective = selection
      ? [...selection.domains]
      : state.domains.length > 0
        ? [...state.domains]
        : [...fallback];
    return { active, effective, available };
  };

  const validate = async (_ctx: ExtensionContext, values: readonly string[]): Promise<string[]> => {
    const selected = normalizeDomainNames(values);
    const state = requireDoomConfigContext(cordisContext()).harness;
    const repoRoot = requireHarnessRoot(state);
    const { listDomainNames, resolvePluginEntries } = await load();
    const available = new Set(listDomainNames(repoRoot));
    const unknown = selected.filter((name) => !available.has(name));
    if (unknown.length > 0) throw new Error(`Unknown domain: ${unknown.join(', ')}`);
    resolvePluginEntries(repoRoot, selected, [...state.pluginDirectories]);
    return selected;
  };

  const describe = async (_ctx: ExtensionContext): Promise<Record<string, string | undefined>> => {
    const root = requireDoomConfigContext(cordisContext()).harness.root;
    if (!root) return {};
    const { loadDomains } = await load();
    return Object.fromEntries(
      Object.entries(loadDomains(root).domains).map(([name, domain]) => [name, domain.description]),
    );
  };

  const completions = async (root: string, textBeforeCursor: string): Promise<DomainCompletion | undefined> => {
    const { domainCompletionItems, domainCompletionPrefix, listDomainNames } = await load();
    const prefix = domainCompletionPrefix(textBeforeCursor);
    if (prefix === undefined) return undefined;
    // Re-read on every keystroke: a domain added while the session is running
    // has to be completable without a reload.
    const items = domainCompletionItems(listDomainNames(root), prefix);
    return items.length === 0 ? undefined : { prefix, items };
  };

  return { list, validate, describe, completions };
}

export type DomainCatalog = ReturnType<typeof createDomainCatalog>;
