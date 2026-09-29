import { ToolMetrics } from './ToolMetrics';

const meta = { title: 'Log/ToolMetrics', component: ToolMetrics, tags: ['style-system'] };
export default meta;

export const Playground = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <ToolMetrics
        tools={[
          { name: 'bash', calls: 42, p90TotalTokens: 146000 },
          { name: 'read', calls: 91, p90TotalTokens: 83000 },
          { name: 'mcp_workspace_repository_search_with_a_long_name', calls: 7, p90TotalTokens: 24000 },
        ]}
      />
    </div>
  ),
};
// This is the real shape in the observed global sink: no attributed tool rows.
export const NotRecorded = {
  render: () => (
    <div className="w-screen max-w-5xl bg-doom-bg p-6">
      <ToolMetrics tools={[]} />
    </div>
  ),
};
