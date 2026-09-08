/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. `Playground` is the story the DoomPi style-system extension renders
 * by default.
 *
 * TooltipProvider wraps the grid and every root is `open`, so all four sides
 * paint without a hover. The wrapper keeps padding on every edge so a tooltip
 * is not pushed back onto its trigger by collision avoidance.
 */
import { Button } from './Button.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './Tooltip.tsx';

const meta = {
  title: 'Components/Tooltip',
  component: Tooltip,
  tags: ['style-system'],
};

export default meta;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <TooltipProvider>
        <div className="grid grid-cols-4 items-center justify-items-center gap-6 py-24">
          {SIDES.map((side) => (
            <div key={side} className="flex flex-col items-center gap-2">
              <Tooltip open>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm">
                    {side}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={side}>copies the run id</TooltipContent>
              </Tooltip>
              <span className="text-2xs text-doom-dim uppercase tracking-widest">side {side}</span>
            </div>
          ))}
        </div>
      </TooltipProvider>
    </div>
  ),
};
