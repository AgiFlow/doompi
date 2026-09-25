import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function WriteMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Write file">
      <McpToolFields
        fields={[
          ['Path', props.args.path],
          ['Characters', typeof props.args.content === 'string' ? props.args.content.length : undefined],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(WriteMcpWidget);
