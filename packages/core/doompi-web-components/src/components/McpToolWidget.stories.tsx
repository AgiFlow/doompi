import { McpToolFields, McpToolFrame, McpToolOutput } from './McpToolWidget.tsx';

const meta = {
  title: 'Components/McpToolFrame',
  component: McpToolFrame,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-4 bg-doom-bg p-4">
      <McpToolFrame title="Read file" phase="running" result={null}>
        <McpToolFields
          fields={[
            ['Path', 'src/example.ts'],
            ['Offset', 1],
            ['Limit', 100],
          ]}
        />
      </McpToolFrame>
      <McpToolFrame title="Search file contents" phase="result" result={{ content: [] }}>
        <McpToolFields
          fields={[
            ['Pattern', 'resourceUri'],
            ['Path', 'packages/core'],
          ]}
        />
        <McpToolOutput
          result={{ content: [{ type: 'text', text: 'src/server/sessionMcpHandler.ts: UI resource found' }] }}
        />
      </McpToolFrame>
      <McpToolFrame title="Write file" phase="result" result={{ content: [], isError: true }}>
        <McpToolOutput
          result={{ content: [{ type: 'text', text: 'Permission denied: src/example.ts' }], isError: true }}
        />
      </McpToolFrame>
      <McpToolFrame title="Run command" phase="cancelled" result={null} />
    </div>
  ),
};
