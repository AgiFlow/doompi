import { createFileEditRuntime } from '../../../../controllers/fileEditRuntime';
import { createFileEditDependencies } from '../../../../tui/fileEditDependencies';

export default () => createFileEditRuntime(createFileEditDependencies());
