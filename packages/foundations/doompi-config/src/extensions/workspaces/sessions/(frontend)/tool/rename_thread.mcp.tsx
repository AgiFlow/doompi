import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFields, McpToolFrame, McpToolOutput } from '@agimon-ai/doompi-web-components';

function RenameThreadMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Rename thread">
      <McpToolFields fields={[['Title', props.args.title]]} />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(RenameThreadMcpWidget);
