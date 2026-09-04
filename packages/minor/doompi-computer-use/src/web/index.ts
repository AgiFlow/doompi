import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { ComputerActionToolCard } from './ComputerActionToolCard.tsx';
import { computerActionToolName } from './computerActionToolRender.ts';
import { ComputerStateToolCard } from './ComputerStateToolCard.tsx';
import { computerStateToolName } from './computerStateToolRender.ts';
import { ComputerUsePanel } from './ComputerUsePanel.tsx';
import { computerUse, computerUseChannel } from './computerUseStore.ts';

export function useComputerUseBadge(sessionId: string | null): number {
  return useStore(computerUse.store, (state) =>
    computerUse.select(state, sessionId).state.phase === 'active' ? 1 : 0,
  );
}

export const webPlugin = defineWebPlugin({
  id: 'computer-use',
  tabs: [{ id: 'computer-use', label: 'Computer Use', panel: ComputerUsePanel, useBadge: useComputerUseBadge }],
  channels: [computerUseChannel],
  toolRenderers: [
    { tools: [computerStateToolName], message: ComputerStateToolCard },
    { tools: [computerActionToolName], message: ComputerActionToolCard },
  ],
});
