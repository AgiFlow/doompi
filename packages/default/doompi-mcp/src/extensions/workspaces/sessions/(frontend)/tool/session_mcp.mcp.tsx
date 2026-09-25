import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolOutput } from '@agimon-ai/doompi-web-components';

function SessionMcpMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title={props.toolName}>
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(SessionMcpMcpWidget);
