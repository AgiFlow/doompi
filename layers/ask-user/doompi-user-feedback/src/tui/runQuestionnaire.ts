import { getMarkdownTheme, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { editQuestionnaireText } from './externalEditor.js';
import type { QuestionParams } from '../schemas/questionnaire.js';
import type { QuestionnaireResult } from '../types/questionnaire.js';
import { QuestionnaireComponent } from './questionnaireComponent.js';

export async function runTuiQuestionnaire(
  context: ExtensionContext,
  params: QuestionParams,
  collapseKey: string,
  signal?: AbortSignal,
  reportProgress?: (result: QuestionnaireResult) => void,
): Promise<QuestionnaireResult | undefined> {
  let component: QuestionnaireComponent | undefined;
  const cancel = (): void => component?.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await context.ui.custom<QuestionnaireResult>((tui, theme, keybindings, done) => {
      component = new QuestionnaireComponent({
        tui,
        theme,
        markdownTheme: getMarkdownTheme(),
        keybindings,
        params,
        collapseKey,
        done,
        editExternally: editQuestionnaireText,
        ...(reportProgress ? { reportProgress } : {}),
      });
      if (signal?.aborted) component.cancel();
      return component;
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
