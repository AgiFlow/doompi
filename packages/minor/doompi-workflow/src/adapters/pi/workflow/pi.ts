import { createWorkflowPiExtension } from './piExtension';

export default createWorkflowPiExtension({ environment: Object.freeze({ ...process.env }) });
