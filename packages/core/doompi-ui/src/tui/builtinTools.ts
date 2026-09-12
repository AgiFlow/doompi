import { definePiTool, type PiToolDeclaration } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  frameBuiltinResult,
  previousBuiltinResult,
  renderEditCall,
  renderEditResult,
  renderFindCall,
  renderGrepCall,
  renderLsCall,
  renderReadCall,
  renderReadResult,
  renderWriteCall,
} from './builtinToolRender';

/**
 * Keep Pi's native schemas, prompt metadata, execution, and result formatting;
 * replace only the broad status-background shell and call heading.
 */
export function createBuiltinTools(cwd: string): PiToolDeclaration[] {
  const tools: PiToolDeclaration[] = [];
  const read = createReadToolDefinition(cwd);
  tools.push(
    definePiTool({
      ...read,
      renderShell: 'self',
      renderCall: (args, theme) => renderReadCall(args, theme),
      renderResult: (result, options, theme, context) => {
        const content = renderReadResult(
          context.args,
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
        );
        return frameBuiltinResult(content, theme, context.lastComponent);
      },
    }),
  );

  const edit = createEditToolDefinition(cwd);
  tools.push(
    definePiTool({
      ...edit,
      renderShell: 'self',
      renderCall: (args, theme) => renderEditCall(args, theme),
      // Doom bands the diff on the background and keeps syntax highlighting on
      // the foreground, which Pi's foreground-only diff renderer cannot express.
      renderResult: (result, options, theme, context) => {
        const content = renderEditResult(
          context.args,
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
        );
        return frameBuiltinResult(content, theme, context.lastComponent);
      },
    }),
  );

  const write = createWriteToolDefinition(cwd);
  const writeResult = write.renderResult!;
  tools.push(
    definePiTool({
      ...write,
      renderShell: 'self',
      renderCall: (args, theme, context) =>
        renderWriteCall(args, theme, {
          expanded: context.expanded,
          // Restored completed rows may not mark args complete, but their result is no longer partial.
          argsStreaming: context.argsComplete === false && context.isPartial,
        }),
      renderResult: (result, options, theme, context) => {
        const content = writeResult(result, options, theme, {
          ...context,
          lastComponent: previousBuiltinResult(context.lastComponent),
        });
        return frameBuiltinResult(content, theme, context.lastComponent);
      },
    }),
  );

  const grep = createGrepToolDefinition(cwd);
  const grepResult = grep.renderResult!;
  tools.push(
    definePiTool({
      ...grep,
      renderShell: 'self',
      renderCall: (args, theme) => renderGrepCall(args, theme),
      renderResult: (result, options, theme, context) => {
        const content = grepResult(result, options, theme, {
          ...context,
          lastComponent: previousBuiltinResult(context.lastComponent),
        });
        return frameBuiltinResult(content, theme, context.lastComponent);
      },
    }),
  );

  const find = createFindToolDefinition(cwd);
  const findResult = find.renderResult!;
  tools.push(
    definePiTool({
      ...find,
      renderShell: 'self',
      renderCall: (args, theme) => renderFindCall(args, theme),
      renderResult: (result, options, theme, context) => {
        const content = findResult(result, options, theme, {
          ...context,
          lastComponent: previousBuiltinResult(context.lastComponent),
        });
        return frameBuiltinResult(content, theme, context.lastComponent);
      },
    }),
  );

  const ls = createLsToolDefinition(cwd);
  const lsResult = ls.renderResult!;
  tools.push(
    definePiTool({
      ...ls,
      renderShell: 'self',
      renderCall: (args, theme) => renderLsCall(args, theme),
      renderResult: (result, options, theme, context) => {
        const content = lsResult(result, options, theme, {
          ...context,
          lastComponent: previousBuiltinResult(context.lastComponent),
        });
        return frameBuiltinResult(content, theme, context.lastComponent);
      },
    }),
  );
  return tools;
}
