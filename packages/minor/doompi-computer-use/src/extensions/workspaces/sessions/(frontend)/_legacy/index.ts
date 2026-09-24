import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import {
  COMPUTER_USE_MODE_ID,
  COMPUTER_USE_MODE_STATUS_KEY,
  COMPUTER_USE_STATUS_KEY,
} from '../../../../../types/computerUseApi';
import { computerUseChannel } from '../_lib/computerUseStore';
import { ComputerUsePanel } from '../fill/_components/ComputerUsePanel';
import { ComputerActionToolCard } from '../tool/_components/ComputerActionToolCard';
import { ComputerExecToolCard } from '../tool/_components/ComputerExecToolCard';
import { ComputerStateToolCard } from '../tool/_components/ComputerStateToolCard';
import { computerActionToolName } from '../tool/_lib/computerActionToolRender';
import { computerExecToolName } from '../tool/_lib/computerExecToolRender';
import { computerStateToolName } from '../tool/_lib/computerStateToolRender';

export default {
  minorModes: [
    {
      name: 'computer use',
      modeId: COMPUTER_USE_MODE_ID,
      keys: 'c e',
      statusKey: COMPUTER_USE_MODE_STATUS_KEY,
      hideWhenMissing: true,
      desktopOnly: true,
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
      desktopOnly: true,
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
} satisfies NonNullable<WebPluginDefinition['session']>;
