/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. Each group carries a `defaultValue` so the checked state paints
 * without a click.
 */
import { RadioGroup, RadioGroupCard, RadioGroupItem } from './RadioGroup';

const meta = {
  title: 'Components/RadioGroup',
  component: RadioGroup,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">items · checked, unchecked, disabled</span>
        <RadioGroup defaultValue="auto">
          <div className="flex items-center gap-2">
            <RadioGroupItem id="approval-auto" value="auto" />
            <label htmlFor="approval-auto" className="text-sm text-doom-hi">
              auto approve
            </label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="approval-ask" value="ask" />
            <label htmlFor="approval-ask" className="text-sm text-doom-hi">
              ask every time
            </label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="approval-never" value="never" disabled />
            <label htmlFor="approval-never" className="text-sm text-doom-hi">
              never (disabled)
            </label>
          </div>
        </RadioGroup>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">cards · checked and unchecked</span>
        <RadioGroup defaultValue="doom" className="flex-row flex-wrap">
          <RadioGroupCard value="doom" className="flex w-40 flex-col gap-1">
            <span className="text-sm text-doom-hi">doom</span>
            <span className="text-2xs text-doom-dim">the default theme</span>
          </RadioGroupCard>
          <RadioGroupCard value="mono" className="flex w-40 flex-col gap-1">
            <span className="text-sm text-doom-hi">mono</span>
            <span className="text-2xs text-doom-dim">no accents</span>
          </RadioGroupCard>
        </RadioGroup>
      </div>
    </div>
  ),
};
