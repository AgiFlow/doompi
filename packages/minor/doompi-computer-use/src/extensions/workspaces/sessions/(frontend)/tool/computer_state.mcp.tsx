import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolOutput } from '@agimon-ai/doompi-web-components';

function ComputerStateMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Observe application">
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(ComputerStateMcpWidget);
