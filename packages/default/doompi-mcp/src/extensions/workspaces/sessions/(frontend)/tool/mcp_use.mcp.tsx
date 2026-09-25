import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function McpUseMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Call MCP tool">
      <McpToolFields
        fields={[
          ['Server', props.args.server],
          ['Tool', props.args.tool],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(McpUseMcpWidget);
