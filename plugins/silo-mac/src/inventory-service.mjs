import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { siloDataPath } from "./platform-runtime.mjs";

const SCOPES = new Set(["active", "archived", "all"]);
const DESKTOP_ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

function rolloutHasRecentOpenTurn(path) {
  if (!path || !existsSync(path)) return false;
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (Date.now() - stat.mtimeMs > DESKTOP_ACTIVITY_WINDOW_MS) return false;
    const length = Math.min(stat.size, 256 * 1024);
    if (!length) return false;
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString("utf8").trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]);
        if (record?.type === "event_msg" && record?.payload?.type === "task_complete") return false;
        // Any durable item written after the previous task_complete means the
        // desktop writer still has an open turn. The recency bound prevents an
        // abandoned rollout from being reported forever.
        if (["event_msg", "response_item", "token_usage_record", "turn_context"].includes(record?.type)) {
          return true;
        }
      } catch {
        // The first line can be a partial record because this is a tail read.
      }
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return false;
}

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

function epochMs(value) {
  const number = Number(value || 0);
  return number && number < 10_000_000_000 ? number * 1000 : number;
}

function userMessageText(content) {
  if (!Array.isArray(content)) return safeText(content, "", 12_000);
  return content
    .filter((item) => item?.type === "text" && item.text)
    .map((item) => String(item.text))
    .join("\n\n")
    .trim()
    .slice(0, 12_000);
}

function collectConversationFiles(thread) {
  const files = new Map();
  const root = String(thread?.cwd || "");
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      if (item?.type !== "fileChange") continue;
      for (const change of item.changes || []) {
        const changedPath = String(change?.path || "");
        const path = changedPath && root ? resolve(root, changedPath) : changedPath;
        if (path) files.set(path.toLowerCase(), { path, source: "conversation" });
      }
    }
  }
  return files;
}

function recentWorkspaceFiles(root, existing, limit = 80) {
  if (!root || !existsSync(root)) return [...existing.values()];
  const skip = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "venv", "__pycache__"]);
  const candidates = [];
  const stack = [{ path: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 900) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited++ >= 900) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3 && !skip.has(entry.name)) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(path);
        candidates.push({ path, name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs, source: "workspace" });
      } catch {
        // A file can disappear during a read-only workspace scan.
      }
    }
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  for (const file of candidates) {
    const key = file.path.toLowerCase();
    if (!existing.has(key)) existing.set(key, file);
    if (existing.size >= limit) break;
  }
  return [...existing.values()].slice(0, limit).map((file) => {
    if (file.modifiedAt !== undefined) return file;
    try {
      const stat = statSync(file.path);
      return { ...file, name: basename(file.path), size: stat.size, modifiedAt: stat.mtimeMs };
    } catch {
      return { ...file, name: basename(file.path), size: null, modifiedAt: null, missing: true };
    }
  });
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
        : options.snapshotPath || siloDataPath("native-snapshot.json", options);
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
      const desktopActivity = await this.#readDesktopActivity(roots.slice(0, 200).map((thread) => thread.id));
      tasks = roots.map((thread, index) =>
        this.#normalizeAppThread(
          thread,
          projectMap,
          latestTurns[index],
          liveMap.get(thread.id) || desktopActivity.get(thread.id),
        ),
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
    const roots = listed.items.filter(
      (thread) => !thread.parentThreadId && !thread.agentRole && !thread.agentNickname,
    );
    // A plugin-owned app-server process cannot see the process registry of every
    // Codex window. The newest persisted turn is shared, however. Enrich the
    // lightweight scan so a task running in the desktop process is not dropped
    // merely because this app-server reports it as not loaded.
    const latestTurns = await mapConcurrent(roots.slice(0, 200), 12, async (thread) => {
      try {
        return await this.appServer.readLatestTurn(thread.id);
      } catch {
        return null;
      }
    });
    const desktopActivity = await this.#readDesktopActivity(roots.slice(0, 200).map((thread) => thread.id));
    const appTasks = roots
      .slice(0, 200)
      .map((thread, index) =>
        this.#normalizeAppThread(
          thread,
          new Map(),
          latestTurns[index],
          desktopActivity.get(thread.id) || null,
        ),
      )
      .filter((task) => ["active", "waiting_approval", "waiting_input"].includes(task.status))
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
      source: this.nativeSnapshotAt
        ? "native-snapshot+app-server"
        : "app-server+latest-turn-observation",
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
      status = "active";
      statusEvidence = "latest_turn_in_progress";
    }
    if (live?.status === "active") {
      status = "active";
      statusEvidence = live.statusEvidence || "codex_app_live";
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
      model: safeText(thread.model || live?.model, "", 64) || null,
      effort: safeText(
        thread.reasoningEffort || thread.reasoning_effort || live?.effort,
        "",
        32,
      ) || null,
      lastTurnStatus,
    };
  }

  async #readDesktopActivity(threadIds) {
    if (!threadIds.length) return new Map();
    const dbPath = join(this.codexHome, "state_5.sqlite");
    if (!existsSync(dbPath)) return new Map();
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return new Map();
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const placeholders = threadIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, rollout_path, model, reasoning_effort
           FROM threads
           WHERE id IN (${placeholders})`,
        )
        .all(...threadIds);
      return new Map(
        rows.map((row) => {
          const active = rolloutHasRecentOpenTurn(row.rollout_path);
          return [
            row.id,
            {
              ...(active
                ? { status: "active", statusEvidence: "desktop_rollout_active" }
                : {}),
              hostId: "local",
              model: safeText(row.model, "", 64) || null,
              effort: safeText(row.reasoning_effort, "", 32) || null,
            },
          ];
        }),
      );
    } finally {
      db.close();
    }
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
          model: safeText(row.model, "", 64) || null,
          effort: safeText(row.reasoning_effort, "", 32) || null,
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

  async readTaskDetails(id, options = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`任务不在最近扫描结果中：${id || "unknown"}`);
    const thread = this.appServer.readThreadWithAllTurns
      ? await this.appServer.readThreadWithAllTurns(id)
      : await this.appServer.readThread(id);
    if (!thread) throw new Error(`无法读取任务：${id}`);
    const messages = [];
    for (const turn of thread.turns || []) {
      let offset = 0;
      for (const item of turn.items || []) {
        let role = null;
        let text = "";
        if (item.type === "userMessage") {
          role = "user";
          text = userMessageText(item.content);
        } else if (item.type === "agentMessage" && item.text) {
          role = "assistant";
          text = String(item.text).trim().slice(0, 12_000);
        }
        if (!role || !text) continue;
        messages.push({
          id: item.id || `${turn.id || "turn"}-${offset}`,
          turnId: turn.id || null,
          role,
          text,
          phase: item.phase || null,
          status: turn.status || null,
          createdAt: epochMs(turn.startedAt) + offset,
        });
        offset += 1;
      }
    }
    const pageSize = Math.max(10, Math.min(80, Number(options.limit) || 40));
    const end = Math.max(0, Math.min(messages.length, Number.isFinite(Number(options.before)) ? Number(options.before) : messages.length));
    const start = Math.max(0, end - pageSize);
    const page = messages.slice(start, end);
    return {
      id,
      title: task.title,
      cwd: task.cwd,
      status: task.status,
      canAcceptDirectInput: thread.canAcceptDirectInput !== false,
      messages: page,
      messageCount: messages.length,
      messagesTruncated: start > 0,
      nextBefore: start > 0 ? start : null,
      historyTruncatedAtSource: Boolean(thread.turnsTruncated),
      files: recentWorkspaceFiles(task.cwd, collectConversationFiles({ ...thread, cwd: task.cwd })),
      readAt: Date.now(),
    };
  }

  async sendTaskPrompt(id, prompt, options = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`任务不在最近扫描结果中：${id || "unknown"}`);
    let text = String(prompt || "").trim();
    if (!text) throw new Error("提示词不能为空");
    if (text.length > 20_000) throw new Error("单条提示词最多 20000 个字符");
    if (options.burn && !/Burn 执行策略|Burn execution strategy/i.test(text)) {
      text += options.locale === "en"
        ? "\n\n[Burn execution strategy]\nParallelize independent work, keep ownership boundaries explicit, verify each result, and continue until the requested outcome is complete."
        : "\n\n【Burn 执行策略】\n并行推进可独立完成的工作，明确任务边界，逐项验证结果，并持续执行直到目标真正完成。";
    }
    const result = await this.appServer.sendMessage(id, text, {
      model: options.model && options.model !== "preserve" ? options.model : null,
      effort: options.effort || null,
      fast: Boolean(options.fast),
    });
    return {
      id,
      turnId: result?.turn?.id || null,
      status: result?.turn?.status || "inProgress",
      fastRequested: Boolean(result?.fastRequested),
      fastUsed: Boolean(result?.fastUsed),
      fastFallbackReason: result?.fastFallbackReason || null,
      sentAt: Date.now(),
    };
  }

  readTaskFile(id, requestedPath) {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`任务不在最近扫描结果中：${id || "unknown"}`);
    if (!task.cwd) throw new Error("任务工作目录不可用");
    const root = resolve(String(task.cwd));
    if (!existsSync(root)) throw new Error("任务工作目录不可用");
    const candidate = resolve(root, String(requestedPath || ""));
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) {
      throw new Error("只能读取当前任务工作目录内的文件");
    }
    const stat = statSync(candidate);
    if (!stat.isFile()) throw new Error("目标不是文件");
    const maxBytes = 512 * 1024;
    const buffer = readFileSync(candidate);
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
      throw new Error("二进制文件暂不支持内嵌预览");
    }
    return {
      id,
      path: candidate,
      relativePath: rel,
      name: basename(candidate),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      content: buffer.subarray(0, maxBytes).toString("utf8"),
      truncated: buffer.length > maxBytes,
      readAt: Date.now(),
    };
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
