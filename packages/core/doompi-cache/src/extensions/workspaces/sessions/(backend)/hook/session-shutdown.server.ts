import { cacheHooks } from '../_lib/cacheHooks';
export default cacheHooks.find((hook) => hook.event === 'session_shutdown')!;
