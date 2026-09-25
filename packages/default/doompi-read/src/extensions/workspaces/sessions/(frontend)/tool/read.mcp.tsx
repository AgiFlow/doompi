import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function ReadMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Read file">
      <McpToolFields
        fields={[
          ['Path', props.args.path],
          ['Offset', props.args.offset],
          ['Limit', props.args.limit],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(ReadMcpWidget);
