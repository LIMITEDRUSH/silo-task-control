import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TARGET_STATUSES = Object.freeze([
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "skipped",
]);

const TARGET_STATUS_SET = new Set(TARGET_STATUSES);
const TERMINAL_TARGET_STATUSES = new Set(["completed", "failed", "skipped"]);
const STORE_VERSION = 1;
const DEFAULT_MAX_JOBS = 200;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_CLAIM_LEASE_MS = 2 * 60 * 1000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

export function defaultNativeJobsPath(env = process.env) {
  const localData = env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return join(localData, "SILO", "native-jobs.json");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeTargetSummary(target) {
  const error = typeof target.error === "string"
    ? target.error.replace(/\s+/g, " ").trim().slice(0, 300) || null
    : null;
  return {
    threadId: target.threadId,
    title: target.title || target.threadId,
    cwd: target.cwd || "",
    hostId: target.hostId || "local",
    status: target.status,
    phase: target.phase || "",
    error,
    updatedAt: Number.isFinite(target.updatedAt) ? target.updatedAt : null,
  };
}

function safeJobSummary(job) {
  return {
    id: job.id,
    planId: job.planId,
    status: job.status,
    total: job.total,
    pending: job.pending || 0,
    running: job.running || 0,
    completed: job.completed || 0,
    failed: job.failed || 0,
    skipped: job.skipped || 0,
    createdAt: job.createdAt,
    expiresAt: Number.isFinite(job.expiresAt) ? job.expiresAt : null,
    updatedAt: job.updatedAt,
    revision: job.revision,
    targets: job.targets.map((target) => safeTargetSummary(target)),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStoredEntry(entry) {
  if (!isRecord(entry) || !isRecord(entry.job) || !isRecord(entry.plan)) return false;
  const { job, plan } = entry;
  return (
    typeof job.id === "string" &&
    typeof job.planId === "string" &&
    job.planId === plan.id &&
    Array.isArray(job.targets) &&
    job.targets.every(
      (target) =>
        isRecord(target) &&
        typeof target.threadId === "string" &&
        TARGET_STATUS_SET.has(target.status),
    )
  );
}

function targetFromPlan(target, now) {
  return {
    threadId: target.threadId,
    title: target.title || target.threadId,
    cwd: target.cwd || "",
    hostId: target.hostId || "local",
    status: "pending",
    phase: "prepared",
    error: null,
    claimToken: null,
    claimedAt: null,
    claimExpiresAt: null,
    updatedAt: now,
  };
}

function normalizeStoredTarget(target, claimLeaseMs) {
  if (!("claimToken" in target)) target.claimToken = null;
  if (!("claimedAt" in target)) {
    target.claimedAt = target.status === "claimed" ? target.updatedAt || null : null;
  }
  if (!("claimExpiresAt" in target)) {
    target.claimExpiresAt = target.status === "claimed" && Number.isFinite(target.claimedAt)
      ? target.claimedAt + claimLeaseMs
      : null;
  }
  return target;
}

function refreshSummary(job) {
  job.total = job.targets.length;
  job.pending = job.targets.filter((target) => target.status === "pending").length;
  job.running = job.targets.filter((target) =>
    target.status === "claimed" || target.status === "running"
  ).length;
  job.completed = job.targets.filter((target) => target.status === "completed").length;
  job.failed = job.targets.filter((target) => target.status === "failed").length;
  job.skipped = job.targets.filter((target) => target.status === "skipped").length;

  const terminal = job.completed + job.failed + job.skipped;
  if (job.total === 0 || terminal === job.total) {
    if (job.failed === 0 && job.skipped === 0) job.status = "completed";
    else if (job.failed === job.total) job.status = "failed";
    else job.status = "completed_with_errors";
  } else if (job.running > 0 || terminal > 0) {
    job.status = "running";
  } else {
    job.status = "prepared";
  }
}

function assertText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  if (value.length > maxLength) throw new Error(`${label}最多 ${maxLength} 个字符`);
  return value.trim();
}

function assertTransition(current, next) {
  if (TERMINAL_TARGET_STATUSES.has(current) && next !== current) {
    throw new Error(`终态不可回退或改写：${current} -> ${next}`);
  }
  const allowed = {
    pending: new Set(["pending", "failed", "skipped"]),
    claimed: new Set(["claimed", "running", "completed", "failed", "skipped"]),
    running: new Set(["running", "completed", "failed", "skipped"]),
    completed: new Set(["completed"]),
    failed: new Set(["failed"]),
    skipped: new Set(["skipped"]),
  };
  if (!allowed[current]?.has(next)) {
    throw new Error(`非法任务状态转换：${current} -> ${next}`);
  }
}

export class NativeJobStore {
  constructor(options = {}) {
    this.filePath = options.persistence === false || options.filePath === false
      ? null
      : options.filePath || defaultNativeJobsPath(options.env);
    this.maxJobs = options.maxJobs || DEFAULT_MAX_JOBS;
    this.lockTimeoutMs = options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs || DEFAULT_STALE_LOCK_MS;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    if (!Number.isFinite(this.claimLeaseMs) || this.claimLeaseMs <= 0) {
      throw new Error("claimLeaseMs 必须是正数");
    }
    this.entries = new Map();
    this.#reload();
  }

  create(plan) {
    if (!isRecord(plan) || typeof plan.id !== "string" || !Array.isArray(plan.targets)) {
      throw new Error("无法为无效批次计划创建原生 job");
    }
    return this.#mutate(() => {
      for (const entry of this.entries.values()) {
        if (entry.job.planId === plan.id) return clone(entry.job);
      }
      const now = this.now();
      const job = {
        id: `native-${randomUUID()}`,
        planId: plan.id,
        status: "prepared",
        total: plan.targets.length,
        pending: plan.targets.length,
        running: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        targets: plan.targets.map((target) => targetFromPlan(target, now)),
        createdAt: now,
        expiresAt: Number.isFinite(plan.expiresAt) ? plan.expiresAt : null,
        updatedAt: now,
        revision: 1,
      };
      refreshSummary(job);
      this.entries.set(job.id, { job, plan: clone(plan) });
      return clone(job);
    });
  }

  read(jobId) {
    const id = assertText(jobId, "jobId", 128);
    this.#refreshForRead();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`找不到原生批次 job：${id}`);
    return clone(entry.job);
  }

  readByPlanId(planId) {
    const id = assertText(planId, "planId", 128);
    this.#refreshForRead();
    for (const entry of this.entries.values()) {
      if (entry.job.planId === id) return clone(entry.job);
    }
    throw new Error(`找不到批次计划对应的原生 job：${id}`);
  }

  list(limit = 20) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new Error("limit 必须是 1 到 50 的整数");
    }
    this.#refreshForRead();
    return [...this.entries.values()]
      .sort((left, right) => right.job.updatedAt - left.job.updatedAt)
      .slice(0, count)
      .map((entry) => safeJobSummary(entry.job));
  }

  getPlan(planId) {
    const id = assertText(planId, "planId", 128);
    this.#reload();
    for (const entry of this.entries.values()) {
      if (entry.job.planId === id) return clone(entry.plan);
    }
    return null;
  }

  claim(jobId, threadId) {
    const id = assertText(jobId, "jobId", 128);
    const targetId = assertText(threadId, "threadId", 128);
    return this.#mutate(() => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`找不到原生批次 job：${id}`);
      const target = entry.job.targets.find((item) => item.threadId === targetId);
      if (!target) throw new Error(`任务不属于该批次计划：${targetId}`);
      if (target.status !== "pending") {
        return {
          claimed: false,
          reason: TERMINAL_TARGET_STATUSES.has(target.status)
            ? "target-terminal"
            : "target-already-claimed",
          target: clone(target),
          job: clone(entry.job),
        };
      }
      const now = this.now();
      const conflict = [...this.entries.entries()].find(
        ([otherJobId, otherEntry]) =>
          otherJobId !== id &&
          otherEntry.job.targets.some(
            (otherTarget) =>
              otherTarget.threadId === targetId &&
              (otherTarget.status === "claimed" || otherTarget.status === "running"),
          ),
      );
      if (conflict) {
        const [conflictJobId] = conflict;
        target.status = "skipped";
        target.phase = "overlap";
        target.error = `任务已由原生 job ${conflictJobId} claim 或运行；当前批次已原子跳过，未发送。`;
        target.updatedAt = now;
        entry.job.updatedAt = now;
        entry.job.revision += 1;
        refreshSummary(entry.job);
        return {
          claimed: false,
          reason: "target-active-in-other-job",
          conflictJobId,
          target: clone(target),
          job: clone(entry.job),
        };
      }
      const claimToken = `claim-${randomUUID()}`;
      target.status = "claimed";
      target.phase = "claimed";
      target.error = null;
      target.claimToken = claimToken;
      target.claimedAt = now;
      target.claimExpiresAt = now + this.claimLeaseMs;
      target.updatedAt = now;
      entry.job.updatedAt = now;
      entry.job.revision += 1;
      refreshSummary(entry.job);
      return {
        claimed: true,
        claimToken,
        claimExpiresAt: target.claimExpiresAt,
        target: clone(target),
        job: clone(entry.job),
      };
    });
  }

  record(jobId, threadId, update = {}) {
    const id = assertText(jobId, "jobId", 128);
    const targetId = assertText(threadId, "threadId", 128);
    const status = assertText(update.status, "status", 32);
    if (!TARGET_STATUS_SET.has(status)) throw new Error(`无效任务状态：${status}`);
    const phase = update.phase === undefined
      ? undefined
      : assertText(update.phase, "phase", 128);
    const error = update.error === undefined || update.error === null
      ? update.error
      : String(update.error).slice(0, 4000);
    const claimToken = update.claimToken === undefined
      ? undefined
      : assertText(update.claimToken, "claimToken", 128);

    return this.#mutate(() => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`找不到原生批次 job：${id}`);
      const target = entry.job.targets.find((item) => item.threadId === targetId);
      if (!target) throw new Error(`任务不属于该批次计划：${targetId}`);
      if (
        target.claimToken &&
        (target.status === "claimed" || target.status === "running") &&
        claimToken === undefined
      ) {
        throw new Error(`目标持有发送权，必须提供 claimToken：${targetId}`);
      }
      if (claimToken !== undefined && target.claimToken !== claimToken) {
        throw new Error(`claimToken 与当前任务发送权不匹配：${targetId}`);
      }
      assertTransition(target.status, status);

      const nextPhase = phase ?? target.phase;
      const nextError = error === undefined ? target.error : error;
      if (target.status === status && target.phase === nextPhase && target.error === nextError) {
        return { target: clone(target), job: clone(entry.job) };
      }
      const now = this.now();
      target.status = status;
      target.phase = nextPhase;
      target.error = nextError;
      if (status !== "claimed") target.claimExpiresAt = null;
      target.updatedAt = now;
      entry.job.updatedAt = now;
      entry.job.revision += 1;
      refreshSummary(entry.job);
      return { target: clone(target), job: clone(entry.job) };
    });
  }

  update(jobId, threadId, update = {}) {
    return this.record(jobId, threadId, update);
  }

  #mutate(operation) {
    if (!this.filePath) {
      this.#expireClaims(this.now());
      this.#expirePendingDispatches(this.now());
      return operation();
    }
    const release = this.#acquireLock();
    try {
      this.#reload();
      const now = this.now();
      const expiredClaims = this.#expireClaims(now);
      const expiredDispatches = this.#expirePendingDispatches(now);
      const expired = expiredClaims || expiredDispatches;
      try {
        const result = operation();
        this.#persist();
        return result;
      } catch (error) {
        // Lease expiry is a durable state transition even when the caller's
        // requested operation is rejected by that new terminal state.
        if (expired) this.#persist();
        throw error;
      }
    } finally {
      release();
    }
  }

  #refreshForRead() {
    this.#reload();
    const now = this.now();
    if (!this.#hasExpiredClaims(now) && !this.#hasExpiredPendingDispatches(now)) return;
    if (!this.filePath) {
      this.#expireClaims(now);
      this.#expirePendingDispatches(now);
      return;
    }
    const release = this.#acquireLock();
    try {
      this.#reload();
      const lockedNow = this.now();
      const expiredClaims = this.#expireClaims(lockedNow);
      const expiredDispatches = this.#expirePendingDispatches(lockedNow);
      if (expiredClaims || expiredDispatches) this.#persist();
    } finally {
      release();
    }
  }

  #hasExpiredClaims(now) {
    for (const entry of this.entries.values()) {
      for (const target of entry.job.targets) {
        if (
          target.status === "claimed" &&
          Number.isFinite(target.claimExpiresAt) &&
          target.claimExpiresAt <= now
        ) return true;
      }
    }
    return false;
  }

  #hasExpiredPendingDispatches(now) {
    for (const entry of this.entries.values()) {
      if (!Number.isFinite(entry.job.expiresAt) || entry.job.expiresAt > now) continue;
      if (entry.job.targets.some((target) => target.status === "pending")) return true;
    }
    return false;
  }

  #expireClaims(now) {
    let changed = false;
    for (const entry of this.entries.values()) {
      let entryChanged = false;
      for (const target of entry.job.targets) {
        if (
          target.status !== "claimed" ||
          !Number.isFinite(target.claimExpiresAt) ||
          target.claimExpiresAt > now
        ) continue;
        target.status = "failed";
        target.phase = "claim-timeout";
        target.error = "发送权租约已超时；为避免重复发送，本目标不会自动重试。请创建新批次后重试。";
        target.claimExpiresAt = null;
        target.updatedAt = now;
        entryChanged = true;
        changed = true;
      }
      if (entryChanged) {
        entry.job.updatedAt = now;
        entry.job.revision += 1;
        refreshSummary(entry.job);
      }
    }
    return changed;
  }

  #expirePendingDispatches(now) {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (!Number.isFinite(entry.job.expiresAt) || entry.job.expiresAt > now) continue;
      let entryChanged = false;
      for (const target of entry.job.targets) {
        if (target.status !== "pending") continue;
        target.status = "failed";
        target.phase = "dispatch-timeout";
        target.error = "批次调度窗口已过期；该目标未发送。请创建新批次后重试。";
        target.updatedAt = now;
        entryChanged = true;
        changed = true;
      }
      if (entryChanged) {
        entry.job.updatedAt = now;
        entry.job.revision += 1;
        refreshSummary(entry.job);
      }
    }
    return changed;
  }

  #reload() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new Error(`无法读取 SILO 原生 job 文件：${error.message}`);
    }
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.jobs)) {
      throw new Error("SILO 原生 job 文件格式无效");
    }
    const entries = new Map();
    for (const entry of parsed.jobs) {
      if (!validateStoredEntry(entry)) throw new Error("SILO 原生 job 文件包含无效记录");
      entry.job.targets.forEach((target) => normalizeStoredTarget(target, this.claimLeaseMs));
      refreshSummary(entry.job);
      entries.set(entry.job.id, entry);
    }
    this.entries = entries;
  }

  #persist() {
    if (!this.filePath) return;
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const ordered = [...this.entries.values()].sort(
      (left, right) => right.job.updatedAt - left.job.updatedAt,
    );
    const active = ordered.filter((entry) =>
      entry.job.status === "prepared" || entry.job.status === "running"
    );
    const activeIds = new Set(active.map((entry) => entry.job.id));
    const retained = [
      ...active,
      ...ordered.filter((entry) => !activeIds.has(entry.job.id)).slice(0, this.maxJobs),
    ];
    const payload = `${JSON.stringify({ version: STORE_VERSION, jobs: retained }, null, 2)}\n`;
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, payload, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      try { unlinkSync(temporary); } catch {}
      throw new Error(`无法持久化 SILO 原生 job：${error.message}`);
    }
    this.entries = new Map(retained.map((entry) => [entry.job.id, entry]));
  }

  #acquireLock() {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const startedAt = Date.now();
    let descriptor;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        writeFileSync(descriptor, `${process.pid}\n`, "utf8");
        fsyncSync(descriptor);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > this.staleLockMs) unlinkSync(lockPath);
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error("SILO 原生 job 正被另一个进程更新，请重试");
        }
        Atomics.wait(sleepArray, 0, 0, 10);
      }
    }
    return () => {
      try { closeSync(descriptor); } catch {}
      try { unlinkSync(lockPath); } catch {}
    };
  }
}
