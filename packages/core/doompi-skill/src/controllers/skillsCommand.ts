import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import { skillInvocation } from '../services/skillText';
import type { SkillCatalog, SkillCatalogOptions } from '../services/skillCatalog';
import type { SkillsOverlayResult } from '../tui/skillsOverlay';
import { SKILLS_COMMAND } from '../types/skills';

const INFO = 'info';
const ERROR = 'error';

export interface SkillsCommandDependencies {
  readonly cordisContext: () => Context;
  /** Skill directories every loaded extension has contributed this session. */
  readonly extensionSources: () => readonly { source: string; directories: readonly string[] }[];
  /** Merged view of normal, deferred and package Help skills. */
  readonly inventory: (ctx: ExtensionContext) => Promise<{
    readonly helpSkills: SkillCatalogOptions['helpSkills'];
    readonly diagnostics: readonly string[];
  }>;
  readonly repositoryRoot: (ctx: ExtensionContext) => Promise<string>;
  readonly buildCatalog: (request: SkillCatalogOptions) => Promise<SkillCatalog>;
  readonly openOverlay: (
    ctx: ExtensionContext,
    options: { catalog: SkillCatalog; repoRoot: string },
  ) => Promise<SkillsOverlayResult | undefined>;
}

export function createSkillsCommand(
  dependencies: SkillsCommandDependencies,
): Parameters<ExtensionAPI['registerCommand']> {
  return [
    SKILLS_COMMAND,
    {
      description: 'Browse the skills this session loaded, and what other domains would add',
      handler: async (_args, ctx) => {
        if (!ctx.hasUI || ctx.mode !== 'tui') {
          ctx.ui.notify('/skills requires interactive mode', ERROR);
          return;
        }

        const state = requireDoomConfigContext(dependencies.cordisContext()).harness;
        const [repoRoot, inventory] = await Promise.all([
          dependencies.repositoryRoot(ctx),
          dependencies.inventory(ctx),
        ]);
        const catalog = await dependencies.buildCatalog({
          repoRoot,
          activeSkillDirectories: state.skillDirectories,
          extensionSources: dependencies.extensionSources(),
          helpSkills: inventory.helpSkills,
          helpDiagnostics: [...inventory.diagnostics],
        });

        const result = await dependencies.openOverlay(ctx, { catalog, repoRoot });
        if (!result) return;
        ctx.ui.setEditorText(skillInvocation(result.skill.name));
        ctx.ui.notify(`Loaded ${result.skill.name} into the prompt. Press enter to run it.`, INFO);
      },
    },
  ];
}
