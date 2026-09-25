import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function RunFablePlanMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Prepare plan">
      <McpToolFields
        fields={[
          ['Goals', props.args.goal],
          ['Constraints', props.args.constraints],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(RunFablePlanMcpWidget);
