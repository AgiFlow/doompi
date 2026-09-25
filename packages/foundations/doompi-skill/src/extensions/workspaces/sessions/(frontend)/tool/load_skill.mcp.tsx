import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function LoadSkillMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Load skill">
      <McpToolFields fields={[['Skill', props.args.name]]} />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(LoadSkillMcpWidget);
