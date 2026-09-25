import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function WritePlanMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Save plan">
      <McpToolFields
        fields={[['Characters', typeof props.args.markdown === 'string' ? props.args.markdown.length : undefined]]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(WritePlanMcpWidget);
