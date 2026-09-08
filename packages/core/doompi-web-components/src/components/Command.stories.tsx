/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. The palette parts are rendered inline rather than through
 * CommandDialog, so the surface paints without opening a dialog.
 */
import {
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandItemLabel,
  CommandList,
} from './Command.tsx';

const meta = {
  title: 'Components/Command',
  component: CommandList,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">palette · grouped rows</span>
        <div className="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-doom-border bg-doom-panel">
          <CommandHeader>
            <CommandInput defaultValue="rev" placeholder="type a command" />
          </CommandHeader>
          <CommandList className="max-h-64">
            <CommandGroup>
              <CommandGroupLabel>session</CommandGroupLabel>
              <CommandItem active marker="1">
                <CommandItemLabel>review the working diff</CommandItemLabel>
              </CommandItem>
              <CommandItem marker="2">
                <CommandItemLabel>revert the last edit</CommandItemLabel>
              </CommandItem>
            </CommandGroup>
            <CommandGroup>
              <CommandGroupLabel>tools</CommandGroupLabel>
              <CommandItem marker="3">
                <CommandItemLabel>run the affected tests</CommandItemLabel>
              </CommandItem>
              <CommandItem marker="·" disabled>
                <CommandItemLabel>restart the runtime (disabled)</CommandItemLabel>
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <CommandFooter>
            <span>enter run</span>
            <span>esc close</span>
          </CommandFooter>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">palette · nothing matched</span>
        <div className="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-doom-border bg-doom-panel">
          <CommandHeader>
            <CommandInput defaultValue="zzz" placeholder="type a command" />
          </CommandHeader>
          <CommandList>
            <CommandEmpty>no command matches “zzz”</CommandEmpty>
          </CommandList>
          <CommandFooter>
            <span>enter run</span>
            <span>esc close</span>
          </CommandFooter>
        </div>
      </div>
    </div>
  ),
};
