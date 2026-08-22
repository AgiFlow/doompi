import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
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
} from '../../tui/builtinToolRender.ts';

/**
 * Keep Pi's native schemas, prompt metadata, execution, and result formatting;
 * replace only the broad status-background shell and call heading.
 */
export function registerBuiltinToolUi(
  pi: ExtensionAPI,
  cwd: string,
  shouldRegister: (tool: string) => boolean = () => true,
): void {
  const read = createReadToolDefinition(cwd);
  if (shouldRegister(read.name))
    pi.registerTool({
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
    });

  const edit = createEditToolDefinition(cwd);
  if (shouldRegister(edit.name))
    pi.registerTool({
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
    });

  const write = createWriteToolDefinition(cwd);
  const writeResult = write.renderResult!;
  if (shouldRegister(write.name))
    pi.registerTool({
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
    });

  const grep = createGrepToolDefinition(cwd);
  const grepResult = grep.renderResult!;
  if (shouldRegister(grep.name))
    pi.registerTool({
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
    });

  const find = createFindToolDefinition(cwd);
  const findResult = find.renderResult!;
  if (shouldRegister(find.name))
    pi.registerTool({
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
    });

  const ls = createLsToolDefinition(cwd);
  const lsResult = ls.renderResult!;
  if (shouldRegister(ls.name))
    pi.registerTool({
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
    });
}
