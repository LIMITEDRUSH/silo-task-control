import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";

const pluginVersion = JSON.parse(
  readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"),
).version;

const child = spawn(process.execPath, ["./dist/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, SILO_NATIVE_JOB_PATH: "false" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const lines = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
const stderr = [];

readline.createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error("Non-JSON stdout: " + line);
  }
  if (message.id === undefined) return;
  const item = pending.get(String(message.id));
  if (!item) return;
  pending.delete(String(message.id));
  clearTimeout(item.timer);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result);
});

function send(method, params, timeoutMs = 180_000) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out\n" + stderr.join("\n")));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params = {}) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

try {
  await send("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "silo-smoke", version: "0.1.0" },
  });
  notify("notifications/initialized");

  const listed = await send("tools/list", {});
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "claim_native_job_target",
    "diagnostics",
    "get_batch_plan",
    "list_native_jobs",
    "open_external_panel",
    "prepare_batch",
    "preview_task_prompt",
    "read_native_batch_job",
    "read_native_job",
    "read_quota",
    "read_reset_prediction",
    "recommend_tasks",
    "record_native_job_target",
    "render_task_control_panel",
    "scan_running_tasks",
    "scan_tasks",
  ]);
  const renderTool = listed.tools.find((tool) => tool.name === "render_task_control_panel");
  assert.equal(renderTool.title, "SILO");
  assert.equal(renderTool._meta.ui.resourceUri, "ui://silo-task-control/control-v2.html");
  assert.deepEqual(renderTool._meta["openai/ui"].entrypoints, [{ type: "global" }]);
  assert.equal(renderTool._meta["openai/ui"].preferredModelDisplayMode, "fullscreen");
  const listNativeJobsTool = listed.tools.find((tool) => tool.name === "list_native_jobs");
  assert.deepEqual(listNativeJobsTool._meta.ui.visibility, ["app"]);
  const externalPanelTool = listed.tools.find((tool) => tool.name === "open_external_panel");
  assert.equal(externalPanelTool.annotations.destructiveHint, false);
  const renderStartedAt = performance.now();
  const opened = await send("tools/call", {
    name: "render_task_control_panel",
    arguments: { scope: "active", liveThreads: [] },
  });
  const renderMs = performance.now() - renderStartedAt;
  assert.ok(renderMs < 3_000, `panel render should return immediately, got ${Math.round(renderMs)}ms`);
  assert.equal(opened.isError, undefined);
  assert.equal(opened.structuredContent.deferredScan, true);
  assert.equal(opened._meta.siloBootstrap.scope, "active");
  assert.ok(opened.structuredContent.resetPrediction);
  assert.equal(opened.structuredContent.resetPrediction.sourceUrl, "https://codex-reset.com/zh/");
  assert.equal(opened._meta.siloBootstrap.resetPrediction.checkedAt, opened.structuredContent.resetPrediction.checkedAt);

  const running = await send("tools/call", {
    name: "scan_running_tasks",
    arguments: {},
  });
  assert.equal(running.isError, undefined);
  assert.ok(Array.isArray(running.structuredContent.tasks));
  assert.ok(
    running.structuredContent.tasks.every((task) =>
      ["active", "waiting_approval", "waiting_input"].includes(task.status),
    ),
  );

  const resource = await send("resources/read", {
    uri: "ui://silo-task-control/control-v2.html",
  });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /<div class="wordmark">SILO<\/div>/);
  assert.match(resource.contents[0].text, /id="folderList" class="folder-list"/);
  assert.match(resource.contents[0].text, /id="activityPane" class="rail-pane"/);
  assert.match(resource.contents[0].text, /id="launch"[^>]*>启动任务<\/button>/);
  assert.match(resource.contents[0].text, /id="launchDialog"/);
  assert.match(resource.contents[0].text, /id="internalSurface"/);
  assert.match(resource.contents[0].text, /id="externalSurface"/);
  assert.match(resource.contents[0].text, /name:"list_native_jobs"/);
  assert.match(resource.contents[0].text, /name:"open_external_panel"/);
  assert.match(resource.contents[0].text, new RegExp(`version:"${pluginVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(resource.contents[0].text, /__SILO_BUILD_VERSION__/);
  assert.match(resource.contents[0]._meta["openai/widgetDescription"], /restores persisted native-job progress/);

  const diagnostics = await send("tools/call", { name: "diagnostics", arguments: {} });
  assert.equal(diagnostics.isError, undefined);
  assert.equal(diagnostics.structuredContent.version, pluginVersion);

  const scan = await send(
    "tools/call",
    { name: "scan_tasks", arguments: { scope: "active", liveThreads: [] } },
    240_000,
  );
  assert.equal(scan.isError, undefined);
  assert.ok(Array.isArray(scan.structuredContent.tasks));
  assert.ok(scan.structuredContent.count >= scan.structuredContent.tasks.length);
  assert.ok(scan.structuredContent.projectCount >= 1);

  const sample = scan.structuredContent.tasks.find((task) => task.runnable);
  assert.ok(sample, "expected at least one runnable task");
  const preview = await send("tools/call", {
    name: "preview_task_prompt",
    arguments: { id: sample.id, mode: "continue", additionalPrompt: "" },
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.structuredContent.prompt, /继续完成当前任务/);
  const prepared = await send("tools/call", {
    name: "prepare_batch",
    arguments: {
      tasks: [{ id: sample.id, mode: "continue" }],
      concurrency: 1,
      modelProfile: "preserve",
      additionalPrompt: "",
      confirmed: true,
    },
  });
  assert.equal(prepared.isError, undefined);
  assert.ok(prepared.structuredContent.jobId);
  assert.equal(prepared.structuredContent.nativeJob.id, prepared.structuredContent.jobId);
  assert.equal(prepared.structuredContent.nativeJob.planId, prepared.structuredContent.planId);
  const plan = await send("tools/call", {
    name: "get_batch_plan",
    arguments: { planId: prepared.structuredContent.planId },
  });
  assert.equal(plan.structuredContent.targets[0].threadId, sample.id);
  const nativeByPlan = await send("tools/call", {
    name: "read_native_batch_job",
    arguments: { planId: prepared.structuredContent.planId },
  });
  assert.equal(nativeByPlan.isError, undefined);
  assert.equal(nativeByPlan.structuredContent.id, prepared.structuredContent.jobId);
  const nativeByJob = await send("tools/call", {
    name: "read_native_job",
    arguments: {
      jobId: prepared.structuredContent.jobId,
      planId: prepared.structuredContent.planId,
    },
  });
  assert.equal(nativeByJob.isError, undefined);
  assert.equal(nativeByJob.structuredContent.planId, prepared.structuredContent.planId);
  const recentNativeJobs = await send("tools/call", {
    name: "list_native_jobs",
    arguments: { limit: 1 },
  });
  assert.equal(recentNativeJobs.isError, undefined);
  assert.equal(recentNativeJobs.structuredContent.jobs.length, 1);
  assert.equal(recentNativeJobs.structuredContent.jobs[0].id, prepared.structuredContent.jobId);
  assert.equal("claimToken" in recentNativeJobs.structuredContent.jobs[0].targets[0], false);
  assert.equal(recentNativeJobs.structuredContent.jobs[0].targets[0].error, null);
  assert.equal("output" in recentNativeJobs.structuredContent.jobs[0].targets[0], false);
  assert.equal("prompt" in recentNativeJobs.structuredContent.jobs[0].targets[0], false);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      tools: names.length,
      renderMs: Math.round(renderMs),
      tasks: scan.structuredContent.count,
      projects: scan.structuredContent.projectCount,
      source: scan.structuredContent.source,
      plan: prepared.structuredContent.planId,
      stderrLines: stderr.length,
    }) + "\n",
  );
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 2_000);
  timer.unref?.();
}
