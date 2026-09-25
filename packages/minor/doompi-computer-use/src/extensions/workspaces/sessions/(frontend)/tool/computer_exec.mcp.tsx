import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function ComputerExecMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Run application script">
      <McpToolFields fields={[['Script', props.args.scriptPath]]} />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(ComputerExecMcpWidget);
