import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { COMPUTER_USE_MODE_ID, COMPUTER_USE_MODE_STATUS_KEY, COMPUTER_USE_STATUS_KEY } from '../types/computerUseApi';
import { ComputerActionToolCard } from '../web/components/ComputerActionToolCard';
import { ComputerExecToolCard } from '../web/components/ComputerExecToolCard';
import { ComputerStateToolCard } from '../web/components/ComputerStateToolCard';
import { ComputerUsePanel } from '../web/components/ComputerUsePanel';
import { computerActionToolName } from '../web/lib/computerActionToolRender';
import { computerExecToolName } from '../web/lib/computerExecToolRender';
import { computerStateToolName } from '../web/lib/computerStateToolRender';
import { computerUseSettingsSection } from '../web/lib/computerUseSettings';
import { computerUseChannel } from '../web/stores/computerUseStore';

export const webPlugin = defineWebPlugin({
  id: 'computer-use',
  global: {
    settingsSections: [computerUseSettingsSection],
  },
  workspace: {
    settingsSections: [computerUseSettingsSection],
  },
  session: {
    minorModes: [
      {
        name: 'computer use',
        modeId: COMPUTER_USE_MODE_ID,
        keys: 'c e',
        statusKey: COMPUTER_USE_MODE_STATUS_KEY,
        hideWhenMissing: true,
        order: 70,
      },
    ],
    activityGroups: [
      {
        name: 'computer-use',
        keys: 'c e',
        order: 70,
        statusKey: COMPUTER_USE_STATUS_KEY,
        hideWhenEmpty: true,
        marksBackgroundWork: false,
      },
    ],
    activitySections: [{ id: 'computer-use', component: ComputerUsePanel }],
    channels: [computerUseChannel],
    toolRenderers: [
      { tools: [computerStateToolName], message: ComputerStateToolCard },
      { tools: [computerActionToolName], message: ComputerActionToolCard },
      { tools: [computerExecToolName], message: ComputerExecToolCard },
    ],
  },
});
