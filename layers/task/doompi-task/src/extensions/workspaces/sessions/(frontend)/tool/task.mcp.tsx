import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function TaskMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Manage tasks">
      <McpToolFields
        fields={[
          ['Action', props.args.action],
          ['Task', props.args.id],
          ['Status', props.args.status],
          ['Tasks', Array.isArray(props.args.tasks) ? props.args.tasks.length : undefined],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(TaskMcpWidget);
