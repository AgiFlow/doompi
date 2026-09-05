import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import {
  COMPUTER_USE_MODE_ID,
  COMPUTER_USE_MODE_STATUS_KEY,
  COMPUTER_USE_STATUS_KEY,
} from '../types/computerUseApi.ts';
import { ComputerActionToolCard } from './ComputerActionToolCard.tsx';
import { computerActionToolName } from './computerActionToolRender.ts';
import { ComputerStateToolCard } from './ComputerStateToolCard.tsx';
import { computerStateToolName } from './computerStateToolRender.ts';
import { ComputerUsePanel } from './ComputerUsePanel.tsx';
import { computerUseChannel } from './computerUseStore.ts';

export const webPlugin = defineWebPlugin({
  id: 'computer-use',
  minorModes: [
    {
      name: 'computer use',
      modeId: COMPUTER_USE_MODE_ID,
      keys: 'c e',
      statusKey: COMPUTER_USE_MODE_STATUS_KEY,
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
  ],
});
