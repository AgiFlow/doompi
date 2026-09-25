import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function BashMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Run command">
      <McpToolFields
        fields={[
          ['Name', props.args.name],
          ['Command', props.args.command],
          ['Background', props.args.background],
          ['Timeout', props.args.timeout],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(BashMcpWidget);
