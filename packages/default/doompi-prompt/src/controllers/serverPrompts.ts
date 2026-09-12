import { COMMAND_NAME, SERVER_COMMAND_DESCRIPTION } from '../constants/prompts';
import type { DoomHeadlessCommand } from '@agimon-ai/doompi-extension-contracts/headless';
import { savedPrompts } from '../services/savedPrompts';
export const serverPromptCommand: DoomHeadlessCommand = {
  name: COMMAND_NAME,
  description: SERVER_COMMAND_DESCRIPTION,
  async execute(args, execution) {
    const prompts = await savedPrompts();
    const requested = args.trim();
    if (!requested) {
      await execution.client.notify({
        title: 'DoomPi prompts',
        body: prompts.map((prompt) => `/${prompt.name}: ${prompt.description}`).join('\n') || '(no saved prompts)',
        level: 'info',
      });
      return;
    }
    const prompt = prompts.find((candidate) => candidate.name === requested);
    if (!prompt) {
      await execution.client.notify({ body: `Saved prompt not found: ${requested}`, level: 'warning' });
      return;
    }
    await execution.session.prompt(prompt.text);
  },
};
