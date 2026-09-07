import { getHarnessState } from '@agimon-ai/doompi-config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { applyModelGuidance, guidanceForModel } from '../../services/modelGuidance.ts';
import { loadModelGuidance } from '../modelGuidanceStore.ts';

/**
 * Appends per-model guidance to the system prompt.
 *
 * The guidance map is read straight from the layered `.doom` documents rather
 * than through the session config service: the reader is synchronous and the
 * repository root comes from the harness environment, so there is nothing to
 * wait on and no readiness barrier to deadlock against.
 *
 * The file is read per turn on purpose. Two existence checks and two small
 * reads are nothing beside the model call that follows, and editing guidance
 * takes effect on the next turn, which is what tuning a prompt for a freshly
 * released model actually needs.
 */
const PACKAGE_SOURCE = '@agimon-ai/doompi-model-guidance';

interface ModelGuidancePluginConfig {
  readonly pi: ExtensionAPI;
}

function modelGuidancePlugin(_cordis: Context, { pi }: ModelGuidancePluginConfig): void {
  registerModelGuidanceHandlers(pi);
}

export function registerModelGuidanceHandlers(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event, ctx) => {
    const modelId = ctx.model?.id;
    if (!modelId) return undefined;

    const guidance = guidanceForModel(loadModelGuidance(getHarnessState().root), modelId);
    const systemPrompt = applyModelGuidance(event.systemPrompt, guidance);
    return systemPrompt ? { systemPrompt } : undefined;
  });
}

export async function activateModelGuidanceExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(modelGuidancePlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
    throw error;
  }

  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default activateModelGuidanceExtension;
