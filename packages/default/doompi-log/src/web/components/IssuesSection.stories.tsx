/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The section is collapsed until a reader clicks, and the click reads from the
 * hub. What renders without a hub is exactly the state this story shows: the
 * opener and the line explaining why the detail costs something.
 */
import type { MetricsTool } from '../../types/webMetrics.ts';
import { IssuesSection } from './IssuesSection.tsx';

const tools: readonly MetricsTool[] = [
  { name: 'bash', calls: 742, p90TotalTokens: 411_200 },
  { name: 'read', calls: 1006, p90TotalTokens: 325_900 },
];

const meta = {
  title: 'Log/IssuesSection',
  component: IssuesSection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">collapsed, the whole-window view</span>
        <IssuesSection tools={tools} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">collapsed, narrowed to one session</span>
        <IssuesSection tools={tools} focus="9f2c41ae" />
      </div>
    </div>
  ),
};
