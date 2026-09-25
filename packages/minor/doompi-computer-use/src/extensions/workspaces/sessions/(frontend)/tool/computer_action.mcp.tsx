import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function ComputerActionMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Interact with application">
      <McpToolFields
        fields={[
          ['Action', props.args.kind],
          ['Element', props.args.elementRef],
          ['Direction', props.args.direction],
          ['Amount', props.args.amount],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(ComputerActionMcpWidget);
