import * as baseContext from './context.js';
import {
  createExecutionContextApi,
  type ExecutionLogContext,
} from './execution-context-shared.js';

export type {
  ExecutionLogContext,
  RequestIdentityContext,
} from './execution-context-shared.js';
export {
  REQUEST_CONTEXT_SCHEMA,
  loggedInUserIdFromContext,
  mergeExecutionLogContexts,
  snapshotExecutionLogContext,
  toLoggerLogContext,
} from './execution-context-shared.js';

const api = createExecutionContextApi(baseContext);

export const runWithExecutionLogContext = api.runWithExecutionLogContext;
export const getExecutionLogContext = api.getExecutionLogContext;
export const captureExecutionLogContext = api.captureExecutionLogContext;
export const runWithCapturedExecutionLogContext =
  api.runWithCapturedExecutionLogContext;
export const updateExecutionLogContext = api.updateExecutionLogContext;
export const setExecutionLoggedInUser = api.setExecutionLoggedInUser;
export const getRequestId = api.getRequestId;
export const getLoggedInUserId = api.getLoggedInUserId;
export const getTenantId = api.getTenantId;
export const getSessionId = api.getSessionId;
export const getCorrelationId = api.getCorrelationId;
export const executionLogContextProvider = api.executionLogContextProvider;
export const installExecutionLogContextProvider = api.installExecutionLogContextProvider;
export const enrichEventFromExecutionContext = api.enrichEvent;

// Keep the imported type visible to declaration emit on older TS versions.
export type ActiveExecutionLogContext = ExecutionLogContext;
