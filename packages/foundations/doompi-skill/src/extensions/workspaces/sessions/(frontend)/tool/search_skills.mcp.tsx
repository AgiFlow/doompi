import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function SearchSkillsMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Search skills">
      <McpToolFields fields={[['Query', props.args.query]]} />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(SearchSkillsMcpWidget);
