/**
 * SessionManager options factory
 */

import {
  createSessionStartHandler,
  createSessionEndHandler,
  createSessionUpdateHandler,
  createSessionStatusHandler,
  createTitleChangeHandler,
} from './session.js';
import { createMessageHandler, createTodosHandler } from './message.js';
import { createToolCallHandler, createToolResultHandler, createPlanModeChangeHandler } from './tool.js';
import { createPermissionRequestHandler } from './permission.js';
import type { HandlerContext } from './types.js';
import type { SessionManager, SessionEvents } from '../../slack/session-manager.js';

/**
 * Lazy reference to SessionManager (set after construction)
 */
export interface SessionManagerRef {
  current: SessionManager | null;
}

/**
 * Create SessionManager events with all handlers
 * Uses a ref object for sessionManager to support lazy initialization
 */
export function createSessionManagerEvents(
  context: HandlerContext,
  sessionManagerRef: SessionManagerRef
): SessionEvents {
  return {
    onSessionStart: createSessionStartHandler(context),
    onSessionEnd: createSessionEndHandler(context),
    onSessionUpdate: createSessionUpdateHandler(context),
    onSessionStatus: createSessionStatusHandler(context),
    onTitleChange: createTitleChangeHandler(context),
    onMessage: createMessageHandler(context, sessionManagerRef),
    onTodos: createTodosHandler(context),
    onToolCall: createToolCallHandler(context),
    onToolResult: createToolResultHandler(context),
    onPlanModeChange: createPlanModeChangeHandler(context),
    onPermissionRequest: createPermissionRequestHandler(context),
  };
}

export type { HandlerContext } from './types.js';
