import { MermaidDiagram } from './MermaidDiagram.tsx';

const GRAPH = 'graph TD; A-->B;';

const LABELLED = 'graph LR; A[prompt]-->B[reply];';

const meta = {
  title: 'Components/MermaidDiagram',
  component: MermaidDiagram,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">two nodes</span>
        <MermaidDiagram code={GRAPH} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">labelled, left to right</span>
        <MermaidDiagram code={LABELLED} />
      </div>
    </div>
  ),
};
