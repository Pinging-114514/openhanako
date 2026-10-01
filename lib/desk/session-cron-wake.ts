export const SESSION_CRON_WAKE_TYPE = "session-cron-wake";

export function buildSessionCronWakeMessage(job, promptBody, isZh, options: any = {}) {
  const jobId = typeof job?.id === "string" ? job.id : "";
  const label = typeof job?.label === "string" && job.label.trim() ? job.label.trim() : jobId;
  const task = typeof promptBody === "string" ? promptBody.trim() : "";
  const previousConclusion = typeof options?.previousConclusion === "string"
    ? options.previousConclusion.trim()
    : "";
  const anchorEntryId = typeof options?.anchorEntryId === "string" && options.anchorEntryId.trim()
    ? options.anchorEntryId.trim()
    : "";
  const content = isZh
    ? [
        `<hana-session-cron job-id="${jobId}">`,
        "这是本会话定时任务的一次唤醒，不是用户新发的消息。",
        `任务 id：${jobId}`,
        `名称：${label}`,
        "",
        "把这次的结论直接写在本会话里。界面只会保留这一次的结论，挂在设下定时的那一轮上。",
        "如果目标已经达到，或继续跑没有意义，调用 automation，action 用 update，id 用上面的任务 id，enabled 设为 false，关掉这一条。",
        "可以改这一条的 scheduleType 和 schedule。不要创建别的定时任务，也不要改其他会话的任务。",
        ...(previousConclusion ? ["", `上次结论：${previousConclusion}`] : []),
        "",
        "任务内容：",
        task,
        "</hana-session-cron>",
      ].join("\n")
    : [
        `<hana-session-cron job-id="${jobId}">`,
        "This is a scheduled wake for this session, not a new user message.",
        `Job id: ${jobId}`,
        `Label: ${label}`,
        "",
        "Write the conclusion in this session. Only this conclusion stays visible, on the turn that created the timer.",
        "If the goal is met or further runs are pointless, call automation with action update, this job id, and enabled false to turn this job off.",
        "You may change this job's scheduleType and schedule. Do not create a different scheduled task or edit another session's job.",
        ...(previousConclusion ? ["", `Previous conclusion: ${previousConclusion}`] : []),
        "",
        "Task:",
        task,
        "</hana-session-cron>",
      ].join("\n");
  return {
    customType: SESSION_CRON_WAKE_TYPE,
    content,
    display: false,
    details: {
      schemaVersion: 1,
      kind: "cron",
      jobId,
      displayText: isZh ? `定时 · ${label}` : `Scheduled · ${label}`,
      ...(anchorEntryId ? { anchorEntryId } : {}),
    },
  };
}
