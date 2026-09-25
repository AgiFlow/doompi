import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function EditMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Edit file">
      <McpToolFields
        fields={[
          ['Path', props.args.path],
          ['File revision', props.args.hash],
          ['Changes', Array.isArray(props.args.edits) ? props.args.edits.length : undefined],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(EditMcpWidget);
