import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function FindMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Find files">
      <McpToolFields
        fields={[
          ['Pattern', props.args.pattern],
          ['Path', props.args.path],
          ['Limit', props.args.limit],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(FindMcpWidget);
