import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolOutput } from '@agimon-ai/doompi-web-components';

function LoadContextMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Load repository context">
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(LoadContextMcpWidget);
