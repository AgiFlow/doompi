import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { ExtensionAPI, ExtensionContext, Skill } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import { SKILL_COMMAND_PREFIX, SKILL_INVOCATION_PREFIX } from '../../types/skills.ts';
import type { DeferredSkillSnapshot } from '../deferredSkills.ts';
import type { createActiveHelpSkillView } from '../helpSkills.ts';

const WARNING = 'warning';

type HelpSkillView = ReturnType<typeof createActiveHelpSkillView>;

interface SkillReadinessGeneration {
  readonly id: number;
  readonly ready: Promise<DeferredSkillSnapshot>;
  diagnosticsShown: boolean;
}

export interface SkillReadiness {
  /** The snapshot for the live generation, or undefined once it is superseded. */
  current(): Promise<DeferredSkillSnapshot | undefined>;
}

function loadedSkillCommandNames(pi: ExtensionAPI): string[] {
  if (typeof pi.getCommands !== 'function') return [];
  return pi
    .getCommands()
    .filter((command) => command.source === 'skill' && command.name.startsWith(SKILL_COMMAND_PREFIX))
    .map((command) => command.name.slice(SKILL_COMMAND_PREFIX.length));
}

function failedSnapshot(cwd: string, error: unknown): DeferredSkillSnapshot {
  return {
    skills: [],
    diagnostics: [`${cwd}: ${error instanceof Error ? error.message : String(error)}`],
  };
}

/**
 * Discovery that starts with the session and is awaited only when something
 * needs it.
 *
 * Scanning every skill directory is the slowest thing this package does, so it
 * runs as a generation started on session_start. A reload starts a new one, and
 * a snapshot from a superseded generation is discarded rather than shown.
 */
export function registerSkillReadiness(
  pi: ExtensionAPI,
  helpSkillView: HelpSkillView,
  loadDeferredSkills: () => Promise<typeof import('../deferredSkills.ts')>,
  cordisContext: () => Context,
): SkillReadiness {
  let generationSequence = 0;
  let currentGeneration: SkillReadinessGeneration | undefined;
  let shownHelpDiagnosticKey = '';

  const currentSnapshot = async (generation: SkillReadinessGeneration): Promise<DeferredSkillSnapshot | undefined> => {
    const snapshot = await generation.ready;
    return currentGeneration === generation ? snapshot : undefined;
  };

  pi.on('session_start', (_event, ctx) => {
    const state = requireDoomConfigContext(cordisContext()).harness;
    const id = ++generationSequence;
    const ready = loadDeferredSkills()
      .then(({ DeferredSkillLoader }) =>
        new DeferredSkillLoader({ cwd: ctx.cwd, skillPaths: state.skillDirectories }).start(),
      )
      .catch((error: unknown) => failedSnapshot(ctx.cwd, error));
    currentGeneration = { id, ready, diagnosticsShown: false };
    shownHelpDiagnosticKey = '';
  });

  pi.on('input', async (event) => {
    if (!event.text.startsWith(SKILL_INVOCATION_PREFIX)) return { action: 'continue' };

    const generation = currentGeneration;
    if (!generation) return { action: 'continue' };
    const snapshot = await currentSnapshot(generation);
    if (!snapshot) return { action: 'continue' };

    const inventory = helpSkillView.merge({
      normalSkills: [],
      deferredSkills: snapshot.skills,
      normalSkillNames: loadedSkillCommandNames(pi),
    });
    const { expandDeferredSkillCommand } = await loadDeferredSkills();
    const text = expandDeferredSkillCommand(event.text, inventory.additionalSkills);
    return text === event.text ? { action: 'continue' } : { action: 'transform', text, images: event.images };
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const generation = currentGeneration;
    if (!generation) return undefined;
    const snapshot = await currentSnapshot(generation);
    if (!snapshot) return undefined;

    if (!generation.diagnosticsShown && snapshot.diagnostics.length > 0) {
      generation.diagnosticsShown = true;
      ctx.ui.notify(`Skill discovery:\n${snapshot.diagnostics.join('\n')}`, WARNING);
    }
    const inventory = helpSkillView.merge({
      normalSkills: event.systemPromptOptions.skills ?? [],
      deferredSkills: snapshot.skills,
    });
    if (inventory.diagnosticKey !== shownHelpDiagnosticKey) {
      shownHelpDiagnosticKey = inventory.diagnosticKey;
      if (inventory.diagnostics.length > 0) {
        ctx.ui.notify(`Package Help:\n${inventory.diagnostics.join('\n')}`, WARNING);
      }
    }
    if (inventory.additionalSkills.length === 0) return undefined;

    const { buildPromptWithDeferredSkills } = await loadDeferredSkills();
    return {
      systemPrompt: buildPromptWithDeferredSkills(event.systemPrompt, event.systemPromptOptions, [
        ...inventory.additionalSkills,
      ]),
    };
  });

  return {
    current: async () => (currentGeneration ? currentSnapshot(currentGeneration) : undefined),
  };
}

/** The merged skill inventory the /skills catalogue is built from. */
export function skillInventory(helpSkillView: HelpSkillView, readiness: SkillReadiness) {
  return async (ctx: ExtensionContext) => {
    const snapshot = await readiness.current();
    const inventory = helpSkillView.merge({
      // Present on the runtime context; absent from the published ExtensionContext type.
      normalSkills:
        (ctx as unknown as { getSystemPromptOptions(): { skills?: Skill[] } }).getSystemPromptOptions().skills ?? [],
      deferredSkills: snapshot?.skills ?? [],
    });
    return { helpSkills: inventory.helpSkills, diagnostics: inventory.diagnostics };
  };
}
