import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function defaultJournalPath() {
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(base, "SILO", "jobs.json");
}

function tailPush(lines, chunk) {
  for (const line of String(chunk || "").split(/\r?\n/)) {
    if (line) lines.push(line.slice(0, 1200));
  }
  if (lines.length > 40) lines.splice(0, lines.length - 40);
}

function failureMessage(lines, fallback = "Codex 任务启动失败") {
  const value = lines.slice(-8).join("\n");
  if (/already loaded|already running|owned by another|active turn|currently active|active writer|thread-store conflict/i.test(value)) {
    return "任务正在其他 Codex 窗口运行，已安全跳过";
  }
  if (/rate.?limit|quota|usage limit|insufficient credits/i.test(value)) {
    return "Codex 额度暂时不足，任务未能继续";
  }
  if (/unauthorized|authentication|not logged in|login required/i.test(value)) {
    return "Codex 登录状态无效，请重新登录后再试";
  }
  return fallback;
}

function snapshotJob(job) {
  return {
    ...job,
    targets: job.targets.map(({ output: _output, ...target }) => ({ ...target })),
  };
}

export class DesktopDispatcher {
  constructor(options = {}) {
    this.codexBin = options.codexBin || process.env.CODEX_CLI_PATH || process.env.CODEX_BIN || "codex";
    this.spawnFn = options.spawnFn || spawn;
    this.journalPath = options.journalPath === false ? null : options.journalPath || defaultJournalPath();
    this.jobs = new Map();
    this.children = new Map();
    this.#loadJournal();
  }

  launch(plan) {
    const existing = Array.from(this.jobs.values()).find((job) => job.planId === plan.id);
    if (existing) return this.get(existing.id);
    const job = {
      id: `desktop-${randomUUID()}`,
      planId: plan.id,
      createdAt: Date.now(),
      status: "running",
      concurrency: plan.concurrency,
      total: plan.targets.length,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      targets: plan.targets.map((target) => ({
        threadId: target.threadId,
        title: target.title || target.threadId,
        cwd: target.cwd || "",
        status: "queued",
        phase: "等待发送",
        exitCode: null,
        error: null,
        output: [],
      })),
    };
    this.jobs.set(job.id, job);
    this.#persist();
    void this.#run(job, plan).catch((error) => this.#failJob(job, error));
    return this.get(job.id);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("找不到桌面调度任务");
    return snapshotJob(job);
  }

  getByPlanId(planId) {
    const job = Array.from(this.jobs.values()).find((item) => item.planId === planId);
    return job ? snapshotJob(job) : null;
  }

  list(limit = 10) {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(Number(limit) || 10, 25)))
      .map((job) => snapshotJob(job));
  }

  hasRunningJobs() {
    return Array.from(this.jobs.values()).some((job) => job.status === "running");
  }

  #loadJournal() {
    if (!this.journalPath || !existsSync(this.journalPath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.journalPath, "utf8"));
      for (const job of Array.isArray(saved) ? saved.slice(0, 10) : []) {
        if (!job?.id || !Array.isArray(job.targets)) continue;
        for (const target of job.targets) {
          if (target.status === "failed" && Array.isArray(target.output)) {
            target.error = failureMessage(target.output, target.error);
          }
        }
        if (job.status === "running") {
          for (const target of job.targets) {
            if (["queued", "starting", "running", "waiting_approval", "waiting_input"].includes(target.status)) {
              target.status = "interrupted";
              target.phase = "桌面服务已重启，无法继续跟踪";
              target.error = target.error || "上次 SILO 桌面服务退出时任务仍在运行";
              target.completedAt = Date.now();
            }
          }
          job.running = 0;
          job.completed = job.targets.filter((target) =>
            ["completed", "failed", "interrupted", "skipped"].includes(target.status),
          ).length;
          job.failed = job.targets.filter((target) =>
            ["failed", "interrupted"].includes(target.status),
          ).length;
          job.skipped = job.targets.filter((target) => target.status === "skipped").length;
          job.status = "completed_with_errors";
          job.completedAt = Date.now();
        }
        this.jobs.set(job.id, job);
      }
      this.#persist();
    } catch {
      // A corrupt journal must not prevent SILO from starting.
    }
  }

  #persist() {
    if (!this.journalPath) return;
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      const jobs = Array.from(this.jobs.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map((job) => snapshotJob(job));
      const temporaryPath = `${this.journalPath}.tmp-${process.pid}`;
      writeFileSync(temporaryPath, JSON.stringify(jobs), "utf8");
      renameSync(temporaryPath, this.journalPath);
    } catch {
      try {
        rmSync(`${this.journalPath}.tmp-${process.pid}`, { force: true });
      } catch {}
      // Progress remains available in memory if persistence is unavailable.
    }
  }

  #pruneJobs() {
    const terminal = Array.from(this.jobs.values())
      .filter((job) => job.status !== "running")
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const job of terminal.slice(25)) this.jobs.delete(job.id);
  }

  #failJob(job, error) {
    const message = error?.message || String(error);
    for (const target of job.targets) {
      if (["completed", "failed", "interrupted", "skipped"].includes(target.status)) continue;
      target.status = "failed";
      target.phase = "调度器异常终止";
      target.error = message;
      target.completedAt = Date.now();
      target.output = [];
    }
    job.running = 0;
    job.completed = job.targets.filter((target) =>
      ["completed", "failed", "interrupted"].includes(target.status),
    ).length;
    job.failed = job.targets.filter((target) =>
      ["failed", "interrupted"].includes(target.status),
    ).length;
    job.status = "completed_with_errors";
    job.completedAt = Date.now();
    this.#pruneJobs();
    this.#persist();
  }

  stopAll(reason = "manual") {
    let stoppedCount = 0;
    let cancelledQueuedCount = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.cancelRequested = true;
      job.cancelReason = reason;
      for (const target of job.targets) {
        if (target.status !== "queued") continue;
        target.status = "interrupted";
        target.phase = reason === "quota_full" ? "额度满额，未启动" : "已取消，未启动";
        target.completedAt = Date.now();
        job.completed += 1;
        job.failed += 1;
        cancelledQueuedCount += 1;
      }
    }
    const activeCount = this.children.size;
    for (const [key, child] of this.children) {
      const [jobId, indexText] = key.split(":");
      const job = this.jobs.get(jobId);
      const target = job?.targets?.[Number(indexText)];
      if (!child?.killed && child?.kill()) {
        stoppedCount += 1;
        if (target) {
          target.phase = reason === "quota_full" ? "额度满额，正在停止" : "正在停止";
          target.stopRequested = true;
        }
      }
    }
    this.#persist();
    return {
      activeCount,
      stoppedCount,
      failedCount: activeCount - stoppedCount,
      cancelledQueuedCount,
    };
  }

  async #run(job, plan) {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(plan.concurrency, plan.targets.length) },
      async () => {
        while (cursor < plan.targets.length) {
          if (job.cancelRequested) break;
          const index = cursor++;
          if (job.targets[index].status !== "queued") continue;
          await this.#runTarget(job, plan, index);
        }
      },
    );
    await Promise.all(workers);
    job.status = job.failed || job.skipped ? "completed_with_errors" : "completed";
    job.completedAt = Date.now();
    this.#pruneJobs();
    this.#persist();
  }

  #runTarget(job, plan, index) {
    const target = plan.targets[index];
    const status = job.targets[index];
    const conflictingJob = Array.from(this.jobs.values()).find((candidate) =>
      candidate.id !== job.id &&
      candidate.status === "running" &&
      candidate.targets.some((candidateTarget) =>
        candidateTarget.threadId === target.threadId &&
        ["starting", "running", "waiting_approval", "waiting_input"].includes(
          candidateTarget.status,
        )
      )
    );
    if (conflictingJob) {
      status.status = "skipped";
      status.phase = "已由另一个 SILO 批次启动";
      status.error = `为避免重复发送，已跳过；冲突批次：${conflictingJob.id}`;
      status.completedAt = Date.now();
      job.completed += 1;
      job.skipped += 1;
      this.#persist();
      return Promise.resolve();
    }
    status.status = "running";
    status.phase = "Codex 正在工作";
    status.startedAt = Date.now();
    job.running += 1;
    this.#persist();

    const args = ["exec", "resume", "--all", "--json", "--skip-git-repo-check"];
    const modelOverride = target.modelOverride || plan.modelOverride;
    if (modelOverride?.model) args.push("-m", modelOverride.model);
    if (modelOverride?.thinking) {
      args.push("-c", `model_reasoning_effort="${modelOverride.thinking}"`);
    }
    if (modelOverride?.serviceTier) {
      args.push("-c", `service_tier="${modelOverride.serviceTier}"`);
    }
    args.push(target.threadId, "-");

    return new Promise((resolve) => {
      let closed = false;
      const key = `${job.id}:${index}`;
      let child = null;
      const finish = (code, signal, error = null) => {
        if (closed) return;
        closed = true;
        this.children.delete(key);
        if (error) {
          tailPush(status.output, error.message);
          status.error = error.message;
        }
        status.exitCode = code;
        status.signal = signal || null;
        status.completedAt = Date.now();
        if (status.stopRequested) {
          status.status = "interrupted";
          status.phase = "已停止";
        } else if (code === 0) {
          status.status = "completed";
          status.phase = "已完成";
        } else {
          status.status = "failed";
          status.phase = "未启动或执行失败";
          status.error = status.error || failureMessage(status.output);
        }
        job.running -= 1;
        job.completed += 1;
        if (["failed", "interrupted"].includes(status.status)) job.failed += 1;
        status.output = [];
        this.#persist();
        resolve();
      };
      try {
        child = this.spawnFn(this.codexBin, args, {
          cwd: target.cwd || process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env },
        });
        this.children.set(key, child);
        status.pid = child.pid || null;
        child.stdout?.on("data", (chunk) => tailPush(status.output, chunk));
        child.stderr?.on("data", (chunk) => tailPush(status.output, chunk));
        child.on("error", (error) => finish(null, null, error));
        child.on("close", (code, signal) => finish(code, signal));
        if (!child.stdin || typeof child.stdin.end !== "function") {
          throw new Error("Codex 子进程没有可写入的标准输入");
        }
        child.stdin.on?.("error", (error) => finish(null, null, error));
        this.#persist();
        child.stdin.end(target.prompt);
      } catch (error) {
        try {
          if (child && !child.killed) child.kill();
        } catch {}
        finish(null, null, error);
      }
    });
  }
}
