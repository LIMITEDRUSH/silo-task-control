import { existsSync } from "node:fs";

const RESUMABLE_TYPES = new Set(["idle", "notLoaded", "systemError"]);

function skip(target, thread, reason) {
  return {
    threadId: target.threadId,
    title: target.title || thread?.name || thread?.title || target.threadId,
    status: thread?.status?.type || "missing",
    reason,
  };
}

export async function preflightDesktopPlan(plan, listedThreads) {
  const roots = new Map(
    (listedThreads || [])
      .filter(
        (thread) =>
          thread?.id && !thread.parentThreadId && !thread.agentRole && !thread.agentNickname,
      )
      .map((thread) => [thread.id, thread]),
  );

  const checks = await Promise.all(
    plan.targets.map(async (target) => {
      const thread = roots.get(target.threadId);
      if (!thread) return { target, skipped: skip(target, null, "任务已消失或不再可访问") };
      if (thread.archived) return { target, skipped: skip(target, thread, "任务已归档") };

      const status = thread.status?.type || "notLoaded";
      if (status === "active") {
        return { target, skipped: skip(target, thread, "任务已在运行或等待交互") };
      }
      if (!RESUMABLE_TYPES.has(status)) {
        return { target, skipped: skip(target, thread, `不支持的实时状态：${status}`) };
      }
      const cwd = String(thread.cwd || "");
      if (!cwd || !existsSync(cwd)) {
        return { target, skipped: skip(target, thread, "工作目录已不存在") };
      }

      return { target: { ...target, cwd }, skipped: null };
    }),
  );

  const targets = checks.filter((item) => !item.skipped).map((item) => item.target);
  const skipped = checks.filter((item) => item.skipped).map((item) => item.skipped);
  return {
    plan: { ...plan, targets },
    skipped,
    requestedCount: plan.targets.length,
    eligibleCount: targets.length,
  };
}
