import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function GrepMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Search file contents">
      <McpToolFields
        fields={[
          ['Pattern', props.args.pattern],
          ['Path', props.args.path],
          ['Glob', props.args.glob],
          ['Ignore case', props.args.ignoreCase],
          ['Limit', props.args.limit],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(GrepMcpWidget);
