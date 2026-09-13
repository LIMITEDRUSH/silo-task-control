import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/app-server-client.mjs";
import { InventoryService } from "../src/inventory-service.mjs";
import { PlanStore } from "../src/plan-store.mjs";
import { DesktopDispatcher } from "../src/desktop-dispatcher.mjs";
import { preflightDesktopPlan } from "../src/desktop-preflight.mjs";
import { readResetPrediction } from "../src/reset-prediction.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI_PATH = fileURLToPath(new URL("../ui/control.html", import.meta.url));
const DEFAULT_LOCALE = process.env.SILO_DEFAULT_LOCALE === "en" ? "en" : "zh-CN";
const UI_HTML = (await readFile(UI_PATH, "utf8"))
  .replaceAll("__SILO_BUILD_VERSION__", "desktop")
  .replaceAll("__SILO_DEFAULT_LOCALE__", DEFAULT_LOCALE);
const PORT_INDEX = process.argv.indexOf("--port");
const PORT = Number(PORT_INDEX >= 0 ? process.argv[PORT_INDEX + 1] : 4763);
const HOST = "127.0.0.1";
const MAX_BODY = 1_000_000;

function configuredJournalPath() {
  const value = process.env.SILO_JOURNAL_PATH;
  if (!value) return undefined;
  if (["false", "off", "none"].includes(value.toLowerCase())) return false;
  return value;
}

const appServer = new CodexAppServer();
const inventory = new InventoryService(appServer);
const plans = new PlanStore(inventory);
const dispatcher = new DesktopDispatcher({ journalPath: configuredJournalPath() });
let lastPing = Date.now();

function result(structuredContent, text = "") {
  return { structuredContent, content: text ? [{ type: "text", text }] : [] };
}

function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function callTool(name, args = {}, context = {}) {
  try {
    if (name === "scan_tasks") {
      const value = await inventory.scan(args);
      return result(value, `扫描到 ${value.count} 个任务。`);
    }
    if (name === "scan_running_tasks") {
      const value = await inventory.scanRunning();
      return result(value, `当前有 ${value.count} 个任务正在进行。`);
    }
    if (name === "read_task_details") {
      const value = await inventory.readTaskDetails(args.id, args);
      return result(value, `已读取 ${value.messageCount} 条对话消息和 ${value.files.length} 个相关文件。`);
    }
    if (name === "read_task_file") return result(inventory.readTaskFile(args.id, args.path), "文件预览已读取。");
    if (name === "send_task_prompt") return result(await inventory.sendTaskPrompt(args.id, args.prompt, args), "消息已发送到原任务。");
    if (name === "list_task_approvals") {
      const approvals = appServer.listApprovals(args.id);
      return result({ approvals, count: approvals.length, readAt: Date.now() });
    }
    if (name === "resolve_task_approval") return result(appServer.resolveApproval(args.requestId, args.decision, args.scope), "审批已处理。");
    if (name === "recommend_tasks") {
      const value = await inventory.recommendTasks(args);
      return result(value, `建议选择 ${value.selectedCount} 个任务。`);
    }
    if (name === "preview_task_prompt") return result(await plans.previewContextual(args), "指令预览已生成。");
    if (name === "prepare_batch") {
      const value = plans.prepare(args);
      return result(value, `批次 ${value.planId} 已准备。`);
    }
    if (name === "read_quota") return result(await inventory.readQuota(), "额度已更新。");
    if (name === "read_reset_prediction") {
      return result(await readResetPrediction({ force: Boolean(args.force) }), "重置预测已更新。");
    }
    if (name === "stop_active_tasks") {
      if (args.confirmed !== true || args.confirmationText !== "STOP") {
        throw new Error("停止全部任务需要输入 STOP 并明确确认");
      }
      const value = dispatcher.stopAll(args.reason || "manual");
      return result({ ...value, reason: args.reason || "manual", stoppedAt: Date.now() });
    }
    if (name === "desktop_dispatch_batch") {
      const plan = plans.get(args.planId);
      const listed = await appServer.listThreads({ archived: false });
      const preflight = await preflightDesktopPlan(plan, listed.items);
      if (context.isCancelled?.()) {
        throw new Error("客户端已断开，批次尚未派发");
      }
      if (!preflight.eligibleCount) {
        throw new Error("实时复核后没有可安全继续的任务；请重新扫描后再选择");
      }
      const job = dispatcher.launch(preflight.plan);
      return result(
        {
          ...job,
          requestedCount: preflight.requestedCount,
          skippedPreflight: preflight.skipped,
        },
        `桌面批次已启动；${preflight.skipped.length} 个目标因实时状态变化被跳过。`,
      );
    }
    if (name === "desktop_job") return result(dispatcher.get(args.jobId));
    if (name === "desktop_job_by_plan") {
      return result({ job: dispatcher.getByPlanId(args.planId) });
    }
    if (name === "desktop_jobs") return result({ jobs: dispatcher.list(args.limit) });
    throw new Error(`桌面应用不支持工具：${name}`);
  } catch (error) {
    return errorResult(error);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function isAllowedHost(value) {
  const host = String(value || "").toLowerCase();
  return [HOST, `${HOST}:${PORT}`, "localhost", `localhost:${PORT}`].includes(host);
}

function isAllowedOrigin(request) {
  if (String(request.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
    return false;
  }
  const value = request.headers.origin;
  if (!value) return true;
  try {
    const origin = new URL(String(value));
    const port = origin.port || (origin.protocol === "http:" ? "80" : "443");
    return (
      origin.protocol === "http:" &&
      [HOST, "localhost"].includes(origin.hostname.toLowerCase()) &&
      port === String(PORT)
    );
  } catch {
    return false;
  }
}

function isJsonRequest(request) {
  const type = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  if (!isAllowedHost(request.headers.host)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  lastPing = Date.now();
  let clientGone = false;
  response.on("close", () => {
    if (!response.writableEnded) clientGone = true;
  });
  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
      });
      response.end(UI_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/ping") {
      sendJson(response, 200, { ok: true, root: ROOT });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rpc") {
      if (!isAllowedOrigin(request)) {
        sendJson(response, 403, { error: "拒绝跨站桌面控制请求" });
        return;
      }
      if (!isJsonRequest(request)) {
        sendJson(response, 415, { error: "桌面控制请求必须使用 application/json" });
        return;
      }
      const payload = await bodyJson(request);
      if (payload.method !== "tools/call") throw new Error("仅支持本地工具调用");
      const tool = await callTool(payload.params?.name, payload.params?.arguments || {}, {
        isCancelled: () => clientGone || request.aborted,
      });
      if (!clientGone) sendJson(response, 200, { result: tool });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (!clientGone) sendJson(response, 400, { error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`SILO desktop ready at http://${HOST}:${PORT}/?desktop=1\n`);
});
server.on("error", (error) => {
  process.stderr.write(`SILO desktop failed: ${error?.message || String(error)}\n`);
  void appServer.close().finally(() => {
    process.exitCode = 1;
  });
});

const idleTimer = setInterval(() => {
  if (Date.now() - lastPing < 5 * 60_000 || dispatcher.hasRunningJobs()) return;
  clearInterval(idleTimer);
  void appServer.close().finally(() => server.close(() => process.exit(0)));
}, 30_000);
idleTimer.unref?.();

async function shutdown() {
  clearInterval(idleTimer);
  dispatcher.stopAll("shutdown");
  await appServer.close().catch(() => {});
  const deadline = Date.now() + 2_000;
  while (dispatcher.hasRunningJobs() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
