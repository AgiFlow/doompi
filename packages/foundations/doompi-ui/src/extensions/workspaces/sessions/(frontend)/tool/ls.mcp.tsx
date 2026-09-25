import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function LsMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="List directory">
      <McpToolFields
        fields={[
          ['Path', props.args.path],
          ['Limit', props.args.limit],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(LsMcpWidget);
