import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const SCOPES = new Set(["active", "archived", "all"]);

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function safeText(value, fallback, maxLength) {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeTitle(thread) {
  return safeText(
    thread.name || thread.title || thread.preview || thread.first_user_message,
    "未命名任务",
    180,
  );
}

function cleanConversationPreview(value) {
  let text = String(value || "");
  const requestMarker = text.lastIndexOf("## My request:");
  if (requestMarker >= 0) text = text.slice(requestMarker + "## My request:".length);
  if (/Referenced ChatGPT conversation|untrusted ChatGPT conversation reference/i.test(text)) return "";
  return safeText(text, "", 260);
}

function projectNameFromPath(cwd) {
  if (!cwd) return "未关联项目";
  return basename(cwd.replace(/[\\/]+$/, "")) || cwd;
}

function folderIdentity(cwd) {
  const path = String(cwd || "").replace(/[\\/]+$/, "");
  return {
    folderPath: path,
    folderName: path ? projectNameFromPath(path) : "无工作目录",
    folderKey: path ? path.toLowerCase() : "unassigned",
  };
}

function normalizeProcessStatus(status) {
  const type = status?.type || "notLoaded";
  if (type === "active" && status.activeFlags?.includes("waitingOnApproval")) {
    return "waiting_approval";
  }
  if (type === "active" && status.activeFlags?.includes("waitingOnUserInput")) {
    return "waiting_input";
  }
  if (type === "active") return "active";
  if (type === "idle") return "idle";
  if (type === "systemError") return "failed";
  return "not_loaded";
}

function normalizeLiveStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "active") return "active";
  if (value === "idle") return "idle";
  if (["waiting_approval", "waitingapproval", "waitingonapproval"].includes(value)) {
    return "waiting_approval";
  }
  if (["waiting_input", "waitinginput", "waitingonuserinput"].includes(value)) {
    return "waiting_input";
  }
  if (value === "notloaded" || value === "not_loaded") return "not_loaded";
  return null;
}

function workflowState(status, archived, lastTurnStatus) {
  if (archived) return "completed";
  if (["active", "waiting_approval", "waiting_input"].includes(status)) return "running";
  const turn = String(lastTurnStatus || "").toLowerCase();
  if (["interrupted", "failed", "cancelled", "canceled", "inprogress", "in_progress"].includes(turn)) {
    return "unfinished";
  }
  if (["failed", "interrupted", "possibly_external"].includes(status)) return "unfinished";
  if (turn === "completed") return "completed";
  // Codex reports a loaded conversation with no active turn as idle.  In the
  // absence of failure/interruption evidence it belongs in the completed view,
  // not an invisible fourth bucket.
  if (status === "idle") return "completed";
  return "unknown";
}

function recentConversation(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns.slice(-2) : [];
  const user = [];
  const agent = [];
  for (const turn of turns) {
    for (const item of turn?.items || []) {
      if (item?.type === "userMessage") {
        for (const content of item.content || []) {
          if (content?.type === "text" && content.text) user.push(content.text);
        }
      }
      if (item?.type === "agentMessage" && item.text) agent.push(item.text);
    }
  }
  return {
    user: safeText(user.at(-1), "", 1200),
    agent: safeText(agent.at(-1), "", 1200),
  };
}

function recommendationFor(task, context) {
  const combined = `${task.title} ${context.user}`.toLowerCase();
  const answer = context.agent.toLowerCase();
  const remaining = /(还剩|仍需|下一步|未完成|待处理|待继续|需要继续|todo|remaining|next step|not finished)/i;
  const qualityWork = /(优化|完善|改进|审计|检查|复核|重构|修复|设计|体验|性能|polish|optimi[sz]e|refactor|audit|review|fix)/i;
  const projectWork = /(项目|产品|网站|软件|插件|面板|实验|研究|申请|系统|应用|代码|project|product|website|software|plugin|experiment|research|app\b|code)/i;
  const trivial = /^(hi|hello|你好|1|a|s|解释|为什么|怎么|如何)\b/i;
  if (task.workflowState === "unfinished") {
    return { mode: "continue", reason: "最近一轮尚未完成或被中断", confidence: "high" };
  }
  if (
    task.workflowState === "completed" &&
    !task.archived &&
    remaining.test(answer)
  ) {
    return { mode: "continue", reason: "最近回复仍列出了后续工作", confidence: "medium" };
  }
  if (
    task.workflowState === "completed" &&
    !task.archived &&
    !trivial.test(combined.trim()) &&
    projectWork.test(combined) &&
    qualityWork.test(combined)
  ) {
    return { mode: "optimize", reason: "主体工作已结束，适合做一次质量复核", confidence: "medium" };
  }
  return null;
}

function isRunnable(status, cwd, archived) {
  return Boolean(
    !archived &&
      cwd &&
      existsSync(cwd) &&
      ["idle", "not_loaded", "interrupted", "failed"].includes(status),
  );
}

function serializeError(error) {
  return { message: error?.message || String(error), code: error?.code ?? null };
}

function blockedReason(status, cwd, archived) {
  if (archived) return "任务已归档";
  if (!cwd) return "缺少工作目录";
  if (!existsSync(cwd)) return "工作目录不存在";
  if (status === "active") return "任务正在工作";
  if (status === "waiting_approval") return "任务正在等待权限批准";
  if (status === "waiting_input") return "任务正在等待用户回复";
  if (status === "possibly_external") return "最近一轮仍在进行，可能正在其他 Codex 窗口运行";
  return null;
}

export class InventoryService {
  constructor(appServer, options = {}) {
    this.appServer = appServer;
    this.codexHome = options.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
    this.tasks = new Map();
    this.lastScan = null;
    this.scanGeneration = 0;
    this.serverError = null;
    this.source = "offline";
    this.snapshotPath =
      options.snapshotPath === false
        ? null
        : options.snapshotPath ||
          join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "SILO", "native-snapshot.json");
    this.nativeSnapshot = new Map();
    this.nativeSnapshotAt = 0;
    this.#loadNativeSnapshot();
    appServer.on("offline", (error) => {
      this.serverError = serializeError(error);
    });
  }

  async scan({ scope = "active", liveThreads = [] } = {}) {
    if (!SCOPES.has(scope)) throw new Error(`无效扫描范围：${scope}`);
    const generation = ++this.scanGeneration;
    const startedAt = Date.now();
    if (liveThreads.length) {
      this.nativeSnapshot = new Map(
        liveThreads
          .filter((item) => item?.id)
          .map((item) => [
            item.id,
            { status: normalizeLiveStatus(item.status), hostId: item.hostId || null },
          ]),
      );
      this.nativeSnapshotAt = Date.now();
      this.#saveNativeSnapshot();
    }
    const retainedSnapshot = Date.now() - this.nativeSnapshotAt < 10 * 60 * 1000
      ? this.nativeSnapshot
      : new Map();
    const liveMap = new Map(
      [...retainedSnapshot.values()].length
        ? retainedSnapshot
        : liveThreads
        .filter((item) => item?.id)
        .map((item) => [
          item.id,
          { status: normalizeLiveStatus(item.status), hostId: item.hostId || null },
        ]),
    );

    let tasks;
    let rateLimits = null;
    let warning = null;
    let inventoryTruncated = false;
    try {
      const queries = [];
      if (scope !== "archived") {
        queries.push(this.appServer.listThreads({ archived: false }).then((group) => ({ ...group, archived: false })));
      }
      if (scope !== "active") {
        queries.push(this.appServer.listThreads({ archived: true }).then((group) => ({ ...group, archived: true })));
      }
      const [threadGroups, projects, usage] = await Promise.all([
        Promise.all(queries),
        this.appServer.listProjects().catch(() => []),
        this.appServer.readRateLimits().catch(() => null),
      ]);
      const threads = threadGroups.flatMap((group) =>
        group.items.map((thread) => ({ ...thread, archived: group.archived })),
      );
      inventoryTruncated = threadGroups.some((group) => group.truncated);
      const projectMap = new Map(projects.map((project) => [project.id, project]));
      const roots = threads.filter(
        (thread) => !thread.parentThreadId && !thread.agentRole && !thread.agentNickname,
      );
      // Bound this enrichment so a large history cannot make opening the panel slow.
      const latestTurns = await mapConcurrent(roots.slice(0, 160), 12, async (thread) => {
        const status = normalizeProcessStatus(thread.status);
        if (!["active", "idle", "not_loaded"].includes(status)) return null;
        try {
          return await this.appServer.readLatestTurn(thread.id);
        } catch {
          return null;
        }
      });
      tasks = roots.map((thread, index) =>
        this.#normalizeAppThread(thread, projectMap, latestTurns[index], liveMap.get(thread.id)),
      );
      rateLimits = usage;
      this.source = "app-server";
      this.serverError = null;
      if (inventoryTruncated) {
        warning = "任务数量超过本地扫描上限，仅显示最近 2000 个根任务。";
      }
    } catch (error) {
      warning = `app-server 不可用，已回退到 Codex 本地索引：${error.message}`;
      const fallback = await this.#scanSqlite(scope, liveMap);
      tasks = fallback.items;
      inventoryTruncated = fallback.truncated;
      if (inventoryTruncated) warning += "；任务数量超过回退扫描上限，仅显示最近 2000 个根任务。";
      this.source = "sqlite";
      this.serverError = serializeError(error);
    }

    tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    const projectCount = new Set(tasks.map((task) => task.projectKey)).size;
    const runnableCount = tasks.filter((task) => task.runnable).length;
    const collisionRiskCount = tasks.filter((task) => task.collisionRisk && task.runnable).length;
    const scanResult = {
      scanId: `scan-${Date.now().toString(36)}`,
      scannedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      source: this.source,
      scope,
      count: tasks.length,
      projectCount,
      runnableCount,
      collisionRiskCount,
      inventoryTruncated,
      warning,
      superseded: generation !== this.scanGeneration,
      nativeStatusAt: this.nativeSnapshotAt || null,
      nativeStatusCount: liveMap.size,
    };

    if (!scanResult.superseded) {
      this.tasks = new Map(tasks.map((task) => [task.id, task]));
      this.lastScan = scanResult;
    }

    return {
      ...scanResult,
      tasks,
      rateLimits: this.#normalizeRateLimits(rateLimits),
      capabilities: {
        canPrepareBatch: true,
        dispatchBackend: "codex-app-native-tools",
        maxSelection: 50,
        maxConcurrency: 8,
        embeddedUi: "progressive-enhancement",
      },
    };
  }

  async scanRunning() {
    const startedAt = Date.now();
    const listed = await this.appServer.listThreads({ archived: false });
    const appTasks = listed.items
      .filter(
        (thread) =>
          !thread.parentThreadId &&
          !thread.agentRole &&
          !thread.agentNickname &&
          ["active", "waiting_approval", "waiting_input"].includes(
            normalizeProcessStatus(thread.status),
          ),
      )
      .map((thread) => this.#normalizeAppThread(thread, new Map(), null, null))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const byId = new Map(appTasks.map((task) => [task.id, task]));
    if (Date.now() - this.nativeSnapshotAt < 10 * 60 * 1000) {
      for (const [id, live] of this.nativeSnapshot) {
        if (!["active", "waiting_approval", "waiting_input"].includes(live.status)) continue;
        const known = this.tasks.get(id);
        if (known) {
          byId.set(id, {
            ...known,
            status: live.status,
            statusEvidence: "codex_app_live",
            workflowState: "running",
            runnable: false,
            blockedReason: blockedReason(live.status, known.cwd, false),
          });
        }
      }
    }
    const tasks = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      scannedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      count: tasks.length,
      tasks,
      inventoryTruncated: listed.truncated,
      source: this.nativeSnapshotAt ? "native-snapshot+app-server" : "app-server-live",
      nativeStatusAt: this.nativeSnapshotAt || null,
    };
  }

  #normalizeAppThread(thread, projectMap, latestTurn, live) {
    const project = thread.projectId ? projectMap.get(thread.projectId) : null;
    const cwd = String(thread.cwd || "");
    const processStatus = normalizeProcessStatus(thread.status);
    let status = processStatus;
    let statusEvidence = "inventory_process";
    if (processStatus === "not_loaded" && latestTurn?.status === "inProgress") {
      status = "possibly_external";
      statusEvidence = "history_inference";
    }
    if (live?.status === "active") {
      status = "active";
      statusEvidence = "codex_app_live";
    } else if (
      live?.status === "idle" &&
      ["idle", "not_loaded"].includes(status) &&
      !["active", "waiting_approval", "waiting_input"].includes(processStatus)
    ) {
      status = "idle";
      statusEvidence = "codex_app_live";
    } else if (live?.status === "not_loaded" && status === "not_loaded") {
      statusEvidence = "codex_app_live";
    }

    const archived = Boolean(thread.archived);
    const projectName = safeText(project?.name, projectNameFromPath(cwd), 120);
    const runnable = isRunnable(status, cwd, archived);
    const folder = folderIdentity(cwd);
    const lastTurnStatus = latestTurn?.status || null;
    return {
      id: thread.id,
      hostId: live?.hostId || "local",
      title: safeTitle(thread),
      preview: cleanConversationPreview(thread.preview),
      cwd,
      projectId: thread.projectId || null,
      projectName,
      projectKey: thread.projectId || cwd.toLowerCase() || "unassigned",
      ...folder,
      status,
      statusEvidence,
      collisionRisk:
        statusEvidence !== "codex_app_live" && ["not_loaded", "interrupted"].includes(status),
      runnable,
      blockedReason: runnable ? null : blockedReason(status, cwd, archived),
      archived,
      workflowState: workflowState(status, archived, lastTurnStatus),
      updatedAt: Number(thread.recencyAt || thread.updatedAt || 0) * 1000,
      createdAt: Number(thread.createdAt || 0) * 1000,
      branch: thread.gitInfo?.branch || null,
      lastTurnStatus,
    };
  }

  async #scanSqlite(scope, liveMap) {
    const dbPath = join(this.codexHome, "state_5.sqlite");
    if (!existsSync(dbPath)) throw new Error(`找不到 Codex 状态数据库：${dbPath}`);
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      throw new Error("SQLite 回退需要 Node.js 22.5 或更高版本");
    }
    const archivedClause = scope === "all" ? "IN (0, 1)" : `= ${scope === "archived" ? 1 : 0}`;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT t.*, p.name AS project_name
           FROM threads t
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.archived ${archivedClause}
             AND t.has_user_event = 1
             AND t.source NOT LIKE '{"subagent"%'
           ORDER BY t.recency_at DESC, t.updated_at DESC
           LIMIT 2001`,
        )
        .all();
      const truncated = rows.length > 2000;
      const items = rows.slice(0, 2000).map((row) => {
        const cwd = String(row.cwd || "");
        const archived = Boolean(row.archived);
        const live = liveMap.get(row.id);
        const status = live?.status || "not_loaded";
        const runnable = isRunnable(status, cwd, archived);
        return {
          id: row.id,
          hostId: live?.hostId || "local",
          title: safeTitle(row),
          preview: safeText(row.preview || row.first_user_message, "", 220),
          cwd,
          projectId: row.project_id || null,
          projectName: safeText(row.project_name, projectNameFromPath(cwd), 120),
          projectKey: row.project_id || cwd.toLowerCase() || "unassigned",
          ...folderIdentity(cwd),
          status,
          statusEvidence: live?.status ? "codex_app_live" : "sqlite_inference",
          collisionRisk: !live?.status && !archived,
          runnable,
          blockedReason: runnable ? null : blockedReason(status, cwd, archived),
          archived,
          workflowState: workflowState(status, archived, null),
          updatedAt: Number(row.recency_at_ms || row.updated_at_ms || row.updated_at * 1000 || 0),
          createdAt: Number(row.created_at_ms || row.created_at * 1000 || 0),
          branch: row.git_branch || null,
          lastTurnStatus: null,
        };
      });
      return { items, truncated };
    } finally {
      db.close();
    }
  }

  #normalizeRateLimits(result) {
    if (!result?.rateLimits) return null;
    const snapshot = result.rateLimits;
    const mapWindow = (window) =>
      window
        ? {
            usedPercent: Math.round(window.usedPercent),
            remainingPercent: Math.max(0, Math.round(100 - window.usedPercent)),
            resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
            windowDurationMins: window.windowDurationMins,
          }
        : null;
    return {
      primary: mapWindow(snapshot.primary),
      secondary: mapWindow(snapshot.secondary),
      planType: snapshot.planType || null,
      limitName: snapshot.limitName || "Codex",
      resetCredits: result.rateLimitResetCredits?.availableCount ?? null,
    };
  }

  async readQuota() {
    const result = await this.appServer.readRateLimits();
    return {
      checkedAt: Date.now(),
      rateLimits: this.#normalizeRateLimits(result),
    };
  }

  async readTaskContext(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`任务不在最近扫描结果中：${id || "unknown"}`);
    try {
      return recentConversation(await this.appServer.readRecentTurns(id, 8));
    } catch {
      return { user: task.preview || task.title, agent: "" };
    }
  }

  #loadNativeSnapshot() {
    if (!this.snapshotPath || !existsSync(this.snapshotPath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.snapshotPath, "utf8"));
      if (!stored?.capturedAt || Date.now() - stored.capturedAt >= 10 * 60 * 1000) return;
      this.nativeSnapshot = new Map(
        (stored.threads || [])
          .filter((item) => item?.id && normalizeLiveStatus(item.status))
          .map((item) => [
            item.id,
            { status: normalizeLiveStatus(item.status), hostId: item.hostId || null },
          ]),
      );
      this.nativeSnapshotAt = stored.capturedAt;
    } catch {
      this.nativeSnapshot = new Map();
      this.nativeSnapshotAt = 0;
    }
  }

  #saveNativeSnapshot() {
    if (!this.snapshotPath) return;
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      writeFileSync(
        this.snapshotPath,
        JSON.stringify({
          capturedAt: this.nativeSnapshotAt,
          threads: [...this.nativeSnapshot].map(([id, value]) => ({ id, ...value })),
        }),
        "utf8",
      );
    } catch {
      // Snapshot persistence is an optimization; the current in-memory view remains valid.
    }
  }

  async recommendTasks({ limit = 8 } = {}) {
    if (!this.tasks.size) await this.scan({ scope: "all", liveThreads: [] });
    const candidates = [...this.tasks.values()]
      .filter(
        (task) =>
          !task.archived &&
          task.runnable &&
          !["running", "unknown"].includes(task.workflowState),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 16);
    const contexts = await mapConcurrent(candidates, 8, async (task) => {
      try {
        return recentConversation(await this.appServer.readRecentTurns(task.id, 8));
      } catch {
        return { user: task.preview || task.title, agent: "" };
      }
    });
    const recommendations = [];
    candidates.forEach((task, index) => {
      if (recommendations.length >= limit) return;
      const recommendation = recommendationFor(task, contexts[index]);
      if (recommendation) recommendations.push({ id: task.id, ...recommendation });
    });
    return {
      analyzedAt: Date.now(),
      reviewedCount: candidates.length,
      selectedCount: recommendations.length,
      recommendations,
      basis: "近期对话上下文与任务状态",
    };
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  diagnostics() {
    const dbPath = join(this.codexHome, "state_5.sqlite");
    const sessionsPath = join(this.codexHome, "sessions");
    return {
      source: this.source,
      appServerReady: this.appServer.ready,
      codexHome: this.codexHome,
      stateDb: existsSync(dbPath) ? dbPath : null,
      sessionsDirectory: existsSync(sessionsPath) ? sessionsPath : null,
      sessionYearFolders: existsSync(sessionsPath) ? readdirSync(sessionsPath).length : 0,
      lastScan: this.lastScan,
      error: this.serverError,
      stderrTail: this.appServer.stderrTail.slice(-12),
    };
  }
}
