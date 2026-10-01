/**
 * check-deferred-tool.js — 查询当前 session 的异步任务状态
 *
 * 通用工具，覆盖所有通过 DeferredResultStore 注册的后台任务：
 * 图片/视频生成、subagent、后台终端等。
 * 按当前 sessionPath 隔离，不跨 session。
 */

import { Type } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { t } from "../i18n.ts";
import { isUiOnlyDeferredResultTask, shouldNotifyAgentOnFailure } from "../deferred-result-notification.ts";

import { MAX_OBSERVABLE_RESULT_BYTES } from '../deferred-result-observation.ts';

/**
 * @param {{
 *   getDeferredStore: () => import("../deferred-result-store.ts").DeferredResultStore | null,
 *   getSessionPath: () => string | null,
 * }} opts
 */
export function createCheckDeferredTool({ getDeferredStore, getSessionPath }) {
  return {
    name: "check_pending_tasks",
    label: "Check Pending Tasks",
    description: "Check background tasks in the current conversation. Full results returned within 32KB are marked observed, avoiding a duplicate automatic wake. Use taskId to narrow a large response; oversized responses are not acknowledged automatically.",
    parameters: Type.Object({
      acknowledgeTaskIds: Type.Optional(Type.Array(Type.String(), { description: "Acknowledge completed task results you have already processed (including results read via another status tool). Only this conversation's terminal agent results are affected; pending tasks and media delivery are untouched." })),
      taskId: Type.Optional(Type.String({ description: "Read one task from this conversation; useful when the full list is too large." })),
      status: Type.Optional(
        Type.String({ description: "Filter by status: pending / resolved / failed. Omit to return all." }),
      ),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "read",
        kind: "read",
        capability: "check_pending_tasks.read",
      }),
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const store = getDeferredStore();
      if (!store) {
        return { content: [{ type: "text", text: t("tool.checkDeferred.storeNotInitialized") }] };
      }

      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return { content: [{ type: "text", text: t("tool.checkDeferred.noActiveSession") }] };
      }

      const all = store.listBySession(sessionPath);
      const canAcknowledge = (task) => task.meta?.deliveryTarget?.kind !== 'bridge'
        && (!isUiOnlyDeferredResultTask(task) || shouldNotifyAgentOnFailure(task));
      if (!_signal?.aborted && Array.isArray(params.acknowledgeTaskIds)) {
        const acknowledgedIds = new Set(params.acknowledgeTaskIds);
        for (const task of all) {
          if (acknowledgedIds.has(task.taskId) && canAcknowledge(task)) {
            store.markObserved?.(task.taskId, sessionPath, Number(task.generation || 0));
          }
        }
      }
      const filtered = all.filter((task) => (!params.status || task.status === params.status)
        && (!params.taskId || task.taskId === params.taskId));

      if (!filtered.length) {
        const qualifier = params.status ? t("tool.checkDeferred.noTasksQualifier", { status: params.status }) : "";
        return { content: [{ type: "text", text: t("tool.checkDeferred.noTasks", { qualifier }) }] };
      }

      const summary = filtered.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        type: t.meta?.type || "unknown",
        deferredAt: new Date(t.deferredAt).toISOString(),
        ...(t.result != null && { result: t.result }),
        ...(t.reason != null && { reason: t.reason }),
        ...(t.meta && Object.keys(t.meta).length > 1 && { meta: t.meta }),
      }));

      const text = JSON.stringify(summary, null, 2);
      const canObserve = Buffer.byteLength(text, 'utf8') <= MAX_OBSERVABLE_RESULT_BYTES && !_signal?.aborted;
      if (canObserve) {
        for (const task of filtered) {
          // Reading a media status must not swallow delivery of generated files to UI/Bridge.
          if (!canAcknowledge(task)) continue;
          store.markObserved?.(task.taskId, sessionPath, Number(task.generation || 0));
        }
      }
      return {
        content: [{ type: "text", text }, ...(!canObserve && !_signal?.aborted ? [{
          type: 'text' as const,
          text: 'This response may be truncated. Results have NOT been marked observed; query an individual taskId to read its full result and avoid a duplicate wake.',
        }] : [])],
      };
    },
  };
}
