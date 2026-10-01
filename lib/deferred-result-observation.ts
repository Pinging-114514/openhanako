/** Observation receipts are scoped to a completed run, never to an entire continuable thread. */
export const MAX_OBSERVABLE_RESULT_BYTES = 32 * 1024;

type TaskSnapshot = {
  taskId: string;
  status: string;
  generation?: number;
  result?: unknown;
  reason?: unknown;
  meta?: { type?: string; threadId?: string; deliveryIntent?: string; deliveryTarget?: { kind?: string } };
};

export type SubagentResultReceipt = {
  taskId: string;
  threadId: string;
  generation: number;
  status: string;
  text: string;
};

function isEligibleTask(task: TaskSnapshot, threadId: string): boolean {
  return task.meta?.type === 'subagent'
    && (task.meta.threadId || task.taskId) === threadId
    && task.meta.deliveryTarget?.kind !== 'bridge'
    && task.meta.deliveryIntent !== 'ui_only'
    && task.meta.deliveryIntent !== 'notify_ui_only';
}

function resultText(task: TaskSnapshot): unknown {
  return task.status === 'resolved' ? task.result : task.reason;
}

export function captureSubagentResultReceipt(
  thread: { threadId?: string | null; lastRunTaskId?: string | null; lastRunStatus?: string | null; summary?: string | null },
  sessionTasks: readonly TaskSnapshot[],
): SubagentResultReceipt | null {
  const { threadId, lastRunStatus, summary } = thread;
  if (!threadId || !['resolved', 'failed', 'aborted'].includes(lastRunStatus || '')) return null;
  if (typeof summary !== 'string' || !summary.trim()) return null;
  const candidates = sessionTasks.filter(task => (
    isEligibleTask(task, threadId)
    && (!thread.lastRunTaskId || task.taskId === thread.lastRunTaskId)
    && task.status === lastRunStatus
    && resultText(task) === summary
  ));
  // Old thread records have no run id. Exact, unique same-session text may recover it;
  // never guess the newest task, acknowledge a prefix, or consume all runs of a thread.
  if (candidates.length !== 1) return null;
  const task = candidates[0];
  return { taskId: task.taskId, threadId, generation: Number(task.generation || 0), status: task.status, text: summary };
}

export function stillMatchesSubagentReceipt(task: TaskSnapshot | null | undefined, receipt: SubagentResultReceipt): boolean {
  return !!task && isEligibleTask(task, receipt.threadId)
    && Number(task.generation || 0) === receipt.generation
    && task.status === receipt.status && resultText(task) === receipt.text;
}
