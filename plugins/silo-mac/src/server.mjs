import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v3";
import { CodexAppServer } from "./app-server-client.mjs";
import { InventoryService } from "./inventory-service.mjs";
import { NativeJobStore, TARGET_STATUSES } from "./native-job-store.mjs";
import { PlanStore } from "./plan-store.mjs";
import { readResetPrediction } from "./reset-prediction.mjs";

const FALLBACK_VERSION = "0.1.0";
const PLUGIN_MANIFEST_PATH = fileURLToPath(new URL("../.codex-plugin/plugin.json", import.meta.url));
const VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, "utf8"));
    return typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version.trim()
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
})();
const CONTROL_URI = "ui://silo-task-control/control-v2.html";
const CONTROL_HTML_PATH = fileURLToPath(new URL("../ui/control.html", import.meta.url));
const DEFAULT_LOCALE = process.env.SILO_DEFAULT_LOCALE === "en" ? "en" : "zh-CN";
const readControlHtml = () =>
  readFileSync(CONTROL_HTML_PATH, "utf8")
    .replaceAll("__SILO_BUILD_VERSION__", VERSION)
    .replaceAll("__SILO_DEFAULT_LOCALE__", DEFAULT_LOCALE);
const PLUGIN_ROOT_PATH = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_PLUGIN_ROOT_PATH = join(homedir(), "plugins", "silo-task-control");
const EXTERNAL_PANEL_LAUNCHER_PATH = [
  join(SOURCE_PLUGIN_ROOT_PATH, "desktop", "launch.mjs"),
  fileURLToPath(new URL("../desktop/launch.mjs", import.meta.url)),
].find((candidate) => existsSync(candidate));

const appServer = new CodexAppServer();
const inventory = new InventoryService(appServer);
const nativeJobPath = process.env.SILO_NATIVE_JOB_PATH;
const nativeJobs = new NativeJobStore({
  filePath: nativeJobPath === "false" ? false : nativeJobPath || undefined,
});
const plans = new PlanStore(inventory, { jobStore: nativeJobs });

const server = new McpServer(
  { name: "silo-task-control", title: "SILO Task Control", version: VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

const liveThreadShape = z.object({
  id: z.string().min(6).max(128),
  status: z.enum([
    "active",
    "idle",
    "notLoaded",
    "not_loaded",
    "waiting_approval",
    "waiting_input",
  ]),
  hostId: z.string().min(1).max(128).optional(),
});

const scanInputShape = {
  scope: z.enum(["active", "archived", "all"]).default("active"),
  liveThreads: z.array(liveThreadShape).max(200).default([]),
};

function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error?.message || String(error) }],
  };
}

function resolveNativeJob({ jobId, planId }) {
  if (!jobId && !planId) throw new Error("必须提供 jobId 或 planId");
  const job = jobId ? nativeJobs.read(jobId) : nativeJobs.readByPlanId(planId);
  if (planId && job.planId !== planId) {
    throw new Error(`job ${job.id} 不属于批次计划 ${planId}`);
  }
  return job;
}

function nativeJobToolResult(job) {
  return {
    structuredContent: job,
    content: [
      {
        type: "text",
        text:
          `原生 job ${job.id}：${job.status}；等待 ${job.pending || 0}，运行 ${job.running}，` +
          `完成 ${job.completed}，失败 ${job.failed}，跳过 ${job.skipped || 0} / ${job.total}。`,
      },
    ],
  };
}

function launchExternalPanel() {
  if (!["win32", "darwin"].includes(process.platform)) {
    throw new Error("SILO 外置面板目前支持 Windows 和 macOS");
  }
  if (!EXTERNAL_PANEL_LAUNCHER_PATH) {
    throw new Error("找不到 SILO 外置面板启动器");
  }
  const child = spawn(
    process.execPath,
    [EXTERNAL_PANEL_LAUNCHER_PATH],
    {
      cwd: PLUGIN_ROOT_PATH,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return { status: "opening", requestedAt: Date.now(), surface: "external" };
}

function inventorySummary(result) {
  return (
    `扫描到 ${result.count} 个 Codex 任务，分布在 ${result.projectCount} 个项目；` +
    `${result.runnableCount} 个可加入批次，${result.collisionRiskCount} 个需要额外注意运行状态。` +
    ` 数据源：${result.source}，耗时 ${result.durationMs} ms。` +
    (result.inventoryTruncated ? " 结果已达到 2000 个根任务的扫描上限。" : "")
  );
}

async function runScan(args) {
  return inventory.scan({ scope: args.scope, liveThreads: args.liveThreads });
}

async function readResetForPanelOpen() {
  try {
    return await readResetPrediction({ force: true, timeoutMs: 1_800 });
  } catch (error) {
    return {
      status: "unavailable",
      lastReset: "读取失败",
      nextReset: "读取失败",
      detail: error?.message || "无法连接 Codex Reset",
      sourceUrl: "https://codex-reset.com/zh/",
      checkedAt: Date.now(),
    };
  }
}

registerAppResource(server, "silo-task-control", CONTROL_URI, {}, async () => {
  const html = readControlHtml();
  return {
    contents: [
      {
        uri: CONTROL_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/widgetDescription":
            "SILO task control scans local Codex tasks, previews reviewed batch prompts, and restores persisted native-job progress in its activity rail without resending work.",
        },
      },
    ],
  };
});

server.registerTool(
  "scan_tasks",
  {
    title: "Scan Codex tasks",
    description:
      "Read the local Codex root-task inventory across projects and report if the 2,000-task safety cap is reached. This is data-only and does not resume, interrupt, or modify any task.",
    inputSchema: scanInputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Scanning Codex tasks…",
      "openai/toolInvocation/invoked": "Task scan complete.",
    },
  },
  async (args) => {
    try {
      const result = await runScan(args);
      return {
        structuredContent: result,
        content: [{ type: "text", text: inventorySummary(result) }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "scan_running_tasks",
  {
    title: "Scan running Codex tasks",
    description:
      "Lightweight read-only scan of Codex root tasks that are currently active, waiting for approval, or waiting for user input. Used by the SILO activity rail; it does not dispatch or modify tasks.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Checking running Codex tasks…",
      "openai/toolInvocation/invoked": "Running task status updated.",
    },
  },
  async () => {
    try {
      const result = await inventory.scanRunning();
      return {
        structuredContent: result,
        content: [{ type: "text", text: `当前有 ${result.count} 个 Codex 任务正在进行。` }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "read_task_details",
  {
    title: "Read Codex task conversation and files",
    description:
      "Read the visible user/assistant conversation history and a bounded recent-file list for one task already present in the SILO inventory. This is read-only.",
    inputSchema: {
      id: z.string().min(6).max(128),
      before: z.number().int().min(0).optional(),
      limit: z.number().int().min(10).max(80).default(40),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Loading task conversation…",
      "openai/toolInvocation/invoked": "Task conversation loaded.",
    },
  },
  async ({ id, before, limit }) => {
    try {
      const result = await inventory.readTaskDetails(id, { before, limit });
      return {
        structuredContent: result,
        content: [{ type: "text", text: `已读取 ${result.messageCount} 条对话消息和 ${result.files.length} 个相关文件。` }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "read_task_file",
  {
    title: "Read a task workspace file",
    description: "Read a bounded text preview for a file inside the selected task workspace.",
    inputSchema: { id: z.string().min(6).max(128), path: z.string().min(1).max(2048) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, path }) => {
    try {
      const result = inventory.readTaskFile(id, path);
      return { structuredContent: result, content: [{ type: "text", text: `已读取 ${result.relativePath}。` }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "send_task_prompt",
  {
    title: "Send a prompt to a Codex task",
    description: "Start or steer one existing Codex task with a user-confirmed direct prompt from SILO.",
    inputSchema: {
      id: z.string().min(6).max(128),
      prompt: z.string().min(1).max(20_000),
      model: z.string().min(1).max(128).default("preserve"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
      fast: z.boolean().default(false),
      burn: z.boolean().default(false),
      locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: {
      "openai/toolInvocation/invoking": "Sending message to task…",
      "openai/toolInvocation/invoked": "Message sent to task.",
    },
  },
  async (args) => {
    try {
      const result = await inventory.sendTaskPrompt(args.id, args.prompt, args);
      return { structuredContent: result, content: [{ type: "text", text: "消息已发送到原 Codex 任务。" }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "list_task_approvals",
  {
    title: "List pending task approvals",
    description: "List approval requests raised by Codex tasks started directly from SILO.",
    inputSchema: { id: z.string().min(6).max(128).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    const approvals = appServer.listApprovals(id);
    return { structuredContent: { approvals, count: approvals.length, readAt: Date.now() }, content: [] };
  },
);

server.registerTool(
  "resolve_task_approval",
  {
    title: "Resolve a task approval",
    description: "Approve or decline one pending approval shown inside SILO.",
    inputSchema: {
      requestId: z.string().min(1).max(128),
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      scope: z.enum(["turn", "session"]).default("turn"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ requestId, decision, scope }) => {
    try {
      const result = appServer.resolveApproval(requestId, decision, scope);
      return { structuredContent: result, content: [{ type: "text", text: "审批已处理。" }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "recommend_tasks",
  {
    title: "Recommend Codex tasks",
    description:
      "Read only the recent two turns of recent unfinished or reviewable Codex tasks, then recommend a small safe selection as Continue or Optimize. This does not send messages or start tasks.",
    inputSchema: {
      limit: z.number().int().min(1).max(12).default(8),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Analyzing recent task context…",
      "openai/toolInvocation/invoked": "Task recommendations ready.",
    },
  },
  async (args) => {
    try {
      const result = await inventory.recommendTasks(args);
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: `已分析 ${result.reviewedCount} 个最近任务，建议选择 ${result.selectedCount} 个。`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "render_task_control_panel",
  {
    title: "SILO",
    description:
      "Open the SILO selection panel immediately. After rendering, it scans local Codex tasks and restores recent persisted native-job activity without dispatching anything.",
    inputSchema: scanInputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: CONTROL_URI },
      "openai/ui": {
        entrypoints: [{ type: "global" }],
        preferredModelDisplayMode: "fullscreen",
      },
      "openai/outputTemplate": CONTROL_URI,
      "openai/toolInvocation/invoking": "Opening SILO control…",
      "openai/toolInvocation/invoked": "SILO control ready.",
    },
  },
  async (args) => {
    const resetPrediction = await readResetForPanelOpen();
    const bootstrap = {
      openedAt: Date.now(),
      scope: args.scope,
      liveThreads: args.liveThreads,
      deferredScan: true,
      resetPrediction,
    };
    return {
      structuredContent: bootstrap,
      content: [{ type: "text", text: "SILO 控制面板已打开，任务与额度将在面板内异步载入。" }],
      _meta: { siloBootstrap: bootstrap },
    };
  },
);

server.registerTool(
  "open_external_panel",
  {
    title: "Open SILO external panel",
    description:
      "Open SILO in its lightweight external Windows or macOS panel. Use only when the user explicitly chooses the external surface; this does not dispatch or modify any Codex task.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Opening SILO external panel…",
      "openai/toolInvocation/invoked": "SILO external panel requested.",
    },
  },
  async () => {
    try {
      const result = launchExternalPanel();
      return {
        structuredContent: result,
        content: [{ type: "text", text: "SILO 外置面板正在打开。" }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "preview_task_prompt",
  {
    title: "Preview SILO task prompt",
    description:
      "Return the exact default prompt SILO would send for one scanned task and mode. This is read-only and supports user review before batch preparation.",
    inputSchema: {
      id: z.string().min(6).max(128),
      mode: z.enum(["continue", "optimize", "burn"]),
      locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
      burn: z.boolean().default(false),
      additionalPrompt: z.string().max(1000).default(""),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    try {
      const result = await plans.previewContextual(args);
      return {
        structuredContent: result,
        content: [{ type: "text", text: `已生成“${result.modeLabel}”指令预览。` }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "read_quota",
  {
    title: "Read Codex quota",
    description: "Read the current Codex quota snapshot without rescanning task history.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const result = await inventory.readQuota();
      return {
        structuredContent: result,
        content: [{ type: "text", text: "Codex 额度状态已更新。" }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "read_reset_prediction",
  {
    title: "Read Codex reset prediction",
    description: "Read the current public reset signal from codex-reset.com without changing Codex state.",
    inputSchema: { force: z.boolean().default(false) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args) => {
    try {
      const result = await readResetPrediction({ force: args.force });
      return {
        structuredContent: result,
        content: [{ type: "text", text: `上次重置：${result.lastReset}；下次预计重置：${result.nextReset}` }],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "prepare_batch",
  {
    title: "Prepare SILO batch",
    description:
      "Validate an explicitly confirmed selection and persist a native dispatch job. This does not send messages or start tasks by itself.",
    inputSchema: {
      tasks: z
        .array(
          z.object({
            id: z.string().min(6).max(128),
            mode: z.enum(["continue", "optimize", "burn"]),
            prompt: z.string().min(1).max(6000).optional(),
            burn: z.boolean().default(false),
            model: z.enum(["preserve", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex-spark"]).default("preserve"),
            thinking: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).default("medium"),
          }),
        )
        .min(1)
        .max(50),
      concurrency: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
      modelProfile: z.enum(["preserve", "spark", "sol-max"]).default("preserve"),
      model: z.enum(["preserve", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex-spark"]).default("preserve"),
      thinking: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
      additionalPrompt: z.string().max(1000).default(""),
      locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
      confirmed: z.literal(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Checking launch plan…",
      "openai/toolInvocation/invoked": "Launch plan armed.",
    },
  },
  async (args) => {
    try {
      const result = plans.prepare(args);
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text:
              `批次 ${result.planId} 已校验并持久化为 job ${result.jobId}：` +
              `${result.selectedCount} 个任务，并发 ${result.concurrency}。`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_batch_plan",
  {
    title: "Get SILO batch plan",
    description:
      "Retrieve a previously confirmed short-lived SILO dispatch plan by exact plan ID. Use before native Codex task dispatch.",
    inputSchema: { planId: z.string().min(10).max(128) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ planId }) => {
    try {
      const result = plans.get(planId);
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text:
              `SILO 批次 ${planId} 包含 ${result.selectedCount} 个目标，并发 ${result.concurrency}；` +
              `计划将在 ${new Date(result.expiresAt).toISOString()} 过期。`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "read_native_batch_job",
  {
    title: "Read SILO native batch job",
    description:
      "Read the latest persisted native dispatch state by exact SILO plan ID. The control panel polls this tool for its activity rail.",
    inputSchema: { planId: z.string().min(10).max(128) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ planId }) => {
    try {
      return nativeJobToolResult(resolveNativeJob({ planId }));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "read_native_job",
  {
    title: "Read SILO native job",
    description:
      "Backward-compatible native job lookup by jobId or planId. If both are supplied they must identify the same persisted job.",
    inputSchema: {
      jobId: z.string().min(10).max(128).optional(),
      planId: z.string().min(10).max(128).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ jobId, planId }) => {
    try {
      return nativeJobToolResult(resolveNativeJob({ jobId, planId }));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "list_native_jobs",
  {
    title: "List recent SILO native jobs",
    description:
      "Return recent persisted native-job summaries in newest-update order for restoring the control panel activity rail. This is read-only and excludes claim tokens, prompts, and raw task output.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(20),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  async ({ limit }) => {
    try {
      const jobs = nativeJobs.list(limit);
      return {
        structuredContent: { jobs },
        content: [
          {
            type: "text",
            text: `已读取 ${jobs.length} 个最近的 SILO 原生 job 摘要。`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "claim_native_job_target",
  {
    title: "Claim SILO native job target",
    description:
      "Atomically lease one planned target across all persisted SILO jobs immediately before native send. Only claimed=true authorizes the send; persist the returned claimToken on subsequent updates. Cross-job overlap is atomically skipped, and an unrecorded claim times out instead of remaining stuck forever.",
    inputSchema: {
      jobId: z.string().min(10).max(128),
      threadId: z.string().min(6).max(128),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ jobId, threadId }) => {
    try {
      const result = nativeJobs.claim(jobId, threadId);
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: result.claimed
              ? `已取得任务 ${threadId} 的唯一发送权；租约到 ${new Date(result.claimExpiresAt).toISOString()}。`
              : `未取得任务 ${threadId} 的发送权：${result.reason}。不得发送。`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "record_native_job_target",
  {
    title: "Record SILO native job target",
    description:
      "Persist a validated progress or terminal update for one target that belongs to the exact native job. Pass the claimToken returned by claim when available. Terminal states cannot be changed to another state.",
    inputSchema: {
      jobId: z.string().min(10).max(128),
      threadId: z.string().min(6).max(128),
      status: z.enum(TARGET_STATUSES),
      phase: z.string().min(1).max(128).optional(),
      error: z.string().max(4000).nullable().optional(),
      claimToken: z.string().min(10).max(128).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ jobId, threadId, status, phase, error, claimToken }) => {
    try {
      const result = nativeJobs.record(jobId, threadId, {
        status,
        phase,
        error,
        claimToken,
      });
      return {
        structuredContent: result,
        content: [
          {
            type: "text",
            text: `任务 ${threadId} 已回写为 ${result.target.status} / ${result.target.phase}。`,
          },
        ],
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "diagnostics",
  {
    title: "Inspect SILO diagnostics",
    description: "Read local plugin, Codex inventory, and fallback-index diagnostics without changing state.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const result = { version: VERSION, ...inventory.diagnostics() };
    return {
      structuredContent: result,
      content: [
        {
          type: "text",
          text: `SILO ${VERSION}; inventory=${result.source}; app-server=${result.appServerReady ? "ready" : "offline"}.`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await appServer.close().catch(() => {});
  await server.close().catch(() => {});
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.stdin.on("end", () => {
  const timer = setTimeout(() => void shutdown().finally(() => process.exit(0)), 100);
  timer.unref?.();
});
