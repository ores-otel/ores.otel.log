import * as baseContext from './context-workerd.js';
import { createExecutionContextApi } from './execution-context-shared.js';

export type { ExecutionLogContext } from './execution-context-shared.js';
export {
  mergeExecutionLogContexts,
  snapshotExecutionLogContext,
  toLoggerLogContext,
} from './execution-context-shared.js';

const api = createExecutionContextApi(baseContext);
export const runWithExecutionLogContext = api.runWithExecutionLogContext;
export const getExecutionLogContext = api.getExecutionLogContext;
export const updateExecutionLogContext = api.updateExecutionLogContext;
export const setExecutionLoggedInUser = api.setExecutionLoggedInUser;
export const executionLogContextProvider = api.executionLogContextProvider;
export const installExecutionLogContextProvider = api.installExecutionLogContextProvider;
export const enrichEventFromExecutionContext = api.enrichEvent;
