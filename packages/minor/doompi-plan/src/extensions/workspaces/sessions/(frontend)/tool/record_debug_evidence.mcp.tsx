import { defineMcpWidget, type DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import { McpToolFrame, McpToolFields, McpToolOutput } from '@agimon-ai/doompi-web-components';

function RecordDebugEvidenceMcpWidget(props: DoomMcpWidgetProps) {
  return (
    <McpToolFrame {...props} title="Record debug evidence">
      <McpToolFields
        fields={[
          ['Issue', props.args.issue],
          ['Expected behavior', props.args.expectedBehavior],
          ['Observed behavior', props.args.actualBehavior],
        ]}
      />
      <McpToolOutput result={props.result} />
    </McpToolFrame>
  );
}

export default defineMcpWidget(RecordDebugEvidenceMcpWidget);
