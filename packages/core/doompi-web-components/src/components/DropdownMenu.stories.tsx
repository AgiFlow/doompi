/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. The menu is held `open` because the renderer screenshots without
 * interacting, and the content portals to document.body, so the wrapper
 * reserves the height the portal draws into.
 */
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './DropdownMenu.tsx';

const meta = {
  title: 'Components/DropdownMenu',
  component: DropdownMenu,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">open menu · every item variant</span>
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger className="w-fit rounded-sm border border-doom-border bg-doom-panel px-2.5 py-1 text-sm text-doom-hi">
            session
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>session</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem>
                open
                <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem indented>indented row</DropdownMenuItem>
              <DropdownMenuItem disabled>disabled row</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked>wrap lines</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={false}>show timestamps</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value="sonnet">
              <DropdownMenuRadioItem value="sonnet">sonnet</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="opus">opus</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>export</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>markdown</DropdownMenuItem>
                <DropdownMenuItem>json</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">delete session</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  ),
};
