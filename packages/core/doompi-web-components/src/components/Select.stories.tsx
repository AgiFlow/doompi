/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. One Select is held `open` so the popover paints without a click;
 * the rest stay closed to show what the trigger alone looks like.
 */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './Select.tsx';

const meta = {
  title: 'Components/Select',
  component: Select,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex min-h-96 flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">closed · placeholder and disabled</span>
        <div className="flex flex-wrap items-center gap-3">
          <Select>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="choose a model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sonnet">claude sonnet</SelectItem>
            </SelectContent>
          </Select>
          <Select disabled defaultValue="sonnet">
            <SelectTrigger className="w-48">
              <SelectValue placeholder="choose a model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sonnet">claude sonnet</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Last, because the open popover paints over whatever follows it. */}
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">open · value selected</span>
        <Select open defaultValue="sonnet">
          <SelectTrigger className="w-48">
            <SelectValue placeholder="model" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>anthropic</SelectLabel>
              <SelectItem value="sonnet">claude sonnet</SelectItem>
              <SelectItem value="opus">claude opus</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>local</SelectLabel>
              <SelectItem value="qwen">qwen3 coder</SelectItem>
              <SelectItem value="offline" disabled>
                offline model
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  ),
};
