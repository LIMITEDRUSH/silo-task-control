import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../ui/control.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(
  (match) => match[1],
);
assert.equal(scripts.length, 1, "expected one inline application script");
new Function(scripts[0]);

for (const id of [
  "taskCount",
  "internalSurface",
  "externalSurface",
  "viewAll",
  "viewRunning",
  "viewContinue",
  "viewCompleted",
  "viewAllCount",
  "viewRunningCount",
  "viewContinueCount",
  "viewCompletedCount",
  "smartSelect",
  "globalBurn",
  "folderList",
  "inspectorBody",
  "quotaMonitor",
  "stopAll",
  "prepareTab",
  "activityTab",
  "activityLiveDot",
  "activityList",
  "historyList",
  "mobileActivity",
  "mobileActivitySummary",
  "hiddenSelection",
  "showSelected",
  "launchDialog",
  "launchReview",
  "launchConfirm",
  "launch",
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing required control #${id}`);
}
assert.doesNotMatch(html, /id=["']languageDialog["']/);
assert.doesNotMatch(html, /id=["']languageSwitch["']/);
assert.doesNotMatch(html, /localeKey|silo\.locale/);
assert.match(html, /packagedLocale=["']__SILO_DEFAULT_LOCALE__["']/);
assert.match(html, /function normalizeSupportedLocale\(value\)/);
assert.match(html, /navigator\.languages.*navigator\.language/);
assert.match(html, /function followHostLocale\(context\)/);
assert.match(html, /hostContext.*followHostLocale\(hostContext\)/s);
assert.match(html, /ui\/notifications\/host-context-changed/);
assert.match(html, /openai:set_globals.*followHostLocale/s);
assert.match(html, /locale:locale.*preview_task_prompt|preview_task_prompt.*locale:locale/s);
assert.match(html, /prepare_batch.*locale:locale/s);

assert.doesNotMatch(html, /id=["']projectCount["']/);
assert.doesNotMatch(html, /id=["']runnableCount["']/);
assert.doesNotMatch(html, /id=["']confirmed["']/);
assert.match(html, /role=["']tablist["']/);
assert.match(
  html,
  /id=["']prepareTab["'].*id=["']filesTab["'].*id=["']historyTab["'].*id=["']activityTab["']/s,
  "detail tabs must end with Running",
);
assert.match(html, /id=["']activityTab["'][^>]*>运行中.*id=["']activityLiveDot["']/s);
assert.match(html, /\.rail-tabs>button:not\(\.close-inspector\):hover:not\(\.active\)/);
assert.match(html, /@keyframes livePulse/);
const headerActions = html.match(/<div class=["']header-actions["']>([\s\S]*?)<\/div>\s*<\/header>/)?.[1] || "";
assert.doesNotMatch(headerActions, /id=["']languageSwitch["']/);
assert.match(html, /\.rail-settings\{display:block\}/, "settings must remain available without a selected task");
assert.match(html, /\.advanced-settings\{display:none\}/, "avoid a duplicate task-only settings entry");
assert.match(html, /role=["']progressbar["']/);
assert.match(html, /role=["']progressbar["'][^>]*aria-label=["']批次完成进度["']/);
assert.match(html, /bootstrapThreads=Array\.from\(state\.liveThreads\.values\(\)\)/);
assert.match(html, /state\.liveThreads\.clear\(\);state\.liveThreadsConsumed=true;state\.scanStarted=true/);
assert.doesNotMatch(html, /statusEvidence===["']codex_app_live["']\)state\.liveThreads\.set/);
assert.match(html, /!task\|\|!task\.runnable/);
assert.match(html, /个任务因状态变化已移出批次；草稿仍然保留/);
assert.match(html, /name:["']read_native_job["']/);
assert.match(html, /name:["']read_native_batch_job["']/);
assert.match(html, /正在把调度消息显示到 Codex 对话/);
assert.match(html, /method===["']tools\/call["']\|\|method===["']ui\/message["']/);
assert.match(html, /rawRequest\(["']ui\/initialize["']/);
assert.match(html, /protocolVersion:["']2026-01-26["']}.*,3000\)/);
assert.match(html, /name:["']silo-task-control-ui["'],version:["']__SILO_BUILD_VERSION__["']/);
assert.match(html, /availableDisplayModes:\[["']inline["'],["']fullscreen["']\]/);
assert.match(html, /protocolVersion:["']2026-01-26["']/);
assert.match(html, /postNotification\(["']ui\/notifications\/initialized["']/);
assert.match(html, /caps\.serverTools/);
assert.match(html, /caps\.message/);
assert.match(html, /renderLaunchState\(\);return bridge/);
assert.match(html, /monitoring:["']等待任务完成["']/);
assert.match(html, /finished:["']已完成["']/);
assert.match(html, /sent:["']消息已显示在 Codex["']/);
assert.match(html, /name:["']open_external_panel["']/);
assert.match(html, /name:["']scan_running_tasks["']/);
assert.match(html, /state\.runningTasks=new Map/);
assert.match(html, /function observedTargets\(job\)[\s\S]*state\.jobs\.forEach/);
assert.match(html, /function manageActivityTarget\(target\)/);
assert.match(html, /row\.addEventListener\(["']click["'].*manageActivityTarget\(target\)/s);
assert.match(html, /els\.activityLiveDot\.hidden=!runningIds\.size/);
assert.match(html, /function renderHistory\(\)/);
assert.match(html, /state\.inspectedJobId=job\.id/);
assert.doesNotMatch(html, /function requestNativeStatusSync/);
assert.match(html, /async function refreshFromUser\(\)\{await refresh\(\)\}/);
assert.match(html, /正在当前面板内刷新任务与运行状态/);
assert.match(html, /p\.liveThreads\|\|\[\][\s\S]*state\.runningTasks=new Map/);
assert.match(html, /Codex 当前正在进行/);
assert.match(html, /setInterval\(function\(\)\{void pollRunningTasks\(\)\},10000\)/);
assert.match(html, /conversationVisibleAt/);
assert.match(html, /Codex 对话已显示调度消息/);
assert.match(html, />全部<.*>运行中<.*>待处理<.*>已完成</s);
assert.match(html, /function workflowOf\(t\)/);
assert.match(html, /state\.view==="running"&&flow!=="running"/);
assert.match(html, /state\.view==="continue"&&flow!=="unfinished"&&flow!=="unknown"&&!state\.smartIncluded\.has\(t\.id\)/);
assert.match(html, /state\.view==="completed"&&flow!=="completed"/);
assert.match(html, /status\.textContent=completed\?"已完成"/);
assert.match(html, /name:"recommend_tasks"/);
assert.match(html, /正在理解最近任务上下文/);
assert.match(html, /拖动调整上下两个面板的高度/);
assert.match(html, /localStorage\.setItem\("silo\.railHeight"/);
assert.match(html, /taskModels:new Map/);
assert.match(html, /id=["']globalBurn["'][^>]*class=["']global-burn["']/);
assert.match(html, /id=["']globalBurn["'][^>]*>🔥 Burn<\/button>/);
assert.match(html, /burn\.textContent="🔥 Burn"/);
assert.match(html, /burnEnabled\?"🔥 Burn · 已开启":"🔥 Burn"/);
assert.match(html, /function toggleBurnForSelection\(\)/);
assert.match(html, /Quota remaining/);
assert.match(html, /Reset timing from an unofficial third-party tracker/);
assert.match(html, /Task conversation history/);
assert.match(html, /Copy path/);
assert.match(html, /ACTIVE CODEX TASKS/);
assert.doesNotMatch(html, /quota-line:first-of-type:before/);
assert.match(html, /ids\.forEach\(function\(id\)\{if\(enable\)\{state\.burn\.add\(id\);state\.fast\.add\(id\)\}/);
assert.match(html, /state\.promptStatus\.delete\(key\)/);
assert.match(html, /ids\.forEach\(function\(id\)\{void loadPrompt\(id,true\)\}/);
assert.match(html, /preview_task_prompt.*burn/s);
assert.match(html, /name:["']read_task_details["']/);
assert.match(html, /name:["']read_task_file["']/);
assert.match(html, /name:["']send_task_prompt["']/);
assert.match(html, /name:["']list_task_approvals["']/);
assert.match(html, /name:["']resolve_task_approval["']/);
assert.match(html, /renderConversationBase=renderConversationInspector/);
assert.match(html, /classList\.toggle\("has-task-focus",Boolean\(state\.focusedId\)\)/);
assert.match(html, /function setConversationMode\(task,mode\)/);
assert.match(html, /className=["']conversation-modebar["']/);
assert.match(html, /item\[0\]\.dataset\.mode=item\[1\]/);
assert.match(html, /继续工作/);
assert.match(html, /优化结果/);
assert.match(html, /function enhanceFileReader\(\)/);
assert.match(html, /className=["']code-reader["']/);
assert.match(html, /function enhanceBatchComposer\(task\)/);
assert.match(html, /classList\.add\("batch-composer",mode\)/);
assert.match(html, /state\.promptOverrides\.set\(key,ta\.value\)/);
assert.match(html, /send\.textContent=state\.sendingTaskId===task\.id\?["']发送中…["']:["']立即发送["']/);
assert.match(html, /enhanceConversationHeader\(task\);enhanceBatchComposer\(task\);enhanceComposerChoices\(task\)/);
assert.match(html, /function createComposerChoice\(kind,value,choices,onChoose,disabledValues\)/);
assert.match(html, /className="composer-choice "\+kind/);
assert.match(html, /modelName\.textContent=shownModel/);
assert.match(html, /modelEffort\.textContent=effortChoiceLabel\(shownEffort\)\+" effort"/);
assert.match(html, /tag\.className="task-mode-tag "\+\(mode\|\|"conversation"\)/);
assert.match(html, /tag\.textContent=english\?"In chat":"对话中"/);
assert.doesNotMatch(html, /Local MCP Apps|Mock Host|No Real Task Mutations/);
assert.match(html, /#filesPane\{display:block;width:100%;max-width:100%;min-width:0;min-height:0;overflow:hidden\}/);
assert.match(html, /\.code-reader\{width:100%;max-width:100%;min-width:0;min-height:0;overflow:auto/);
assert.match(html, /views\.appendChild\(els\.smartSelect\)/);
assert.match(html, /\.view-switch>button\{flex:0 0 auto;height:58px!important;min-height:58px!important/);
assert.match(html, /\.message\.assistant \.message-copy\{max-width:94%;border-color:/);
assert.match(html, /\.message\.user \.message-copy\{max-width:min\(88%,540px\);border-color:/);
assert.match(html, /"Segoe UI Variable Text"/);
assert.match(html, /"Cascadia Mono"/);
assert.match(html, /\.view-switch>\.smart-select:before\{content:"✦"/);
assert.match(html, /\.conversation-modes button\{min-height:32px;padding:5px 12px;color:var\(--text\);font-size:12px/);
assert.match(html, /\.batch-composer textarea\{padding:13px 14px 10px;font-family:var\(--font\);font-size:13px/);
assert.match(html, /snapshot&&snapshot\.hasMessages/);
assert.match(html, /next\.scrollTop=nearBottom\?next\.scrollHeight/);
assert.match(html, /fingerprint===pollTaskApprovals\.fingerprint/);
assert.doesNotMatch(html, /document\.querySelector\("\.rail"\)\.scrollIntoView/);
assert.match(html, /className=["']fast-toggle["']/);
assert.match(html, /state\.burn\.add\(t\.id\);state\.fast\.add\(t\.id\)/);
assert.match(html, />对话<.*>文件<.*>历史.*>运行中</s);
assert.match(html, /Burn 将在发送时追加/);
assert.match(html, /burn:Array\.from\(state\.burn\)/);
assert.match(html, /taskModels:Array\.from\(state\.taskModels\.entries\(\)\)/);
assert.doesNotMatch(html, /这里仅显示未完成或智能建议的任务/);
assert.doesNotMatch(html, /一键找出下一步/);
assert.doesNotMatch(html, /点“智能选择”，SILO 会查看最近两轮对话/);
assert.match(html, /setTimeout\(function\(\)\{if\(desktop\).*ensureBridge\(\)\.then.*\},0\)/);
assert.match(html, /\.shell\{width:100%;height:100dvh;min-height:520px;max-height:100dvh/);
assert.doesNotMatch(html, /height:clamp\(720px,86vh,980px\)|min-height:980px/);
assert.match(
  html,
  /legacyAllowed=isMethodUnsupported\(e\)\|\|isTimeoutError\(e\)&&legacyTools&&legacyMessage/,
);
assert.match(html, /dispatchUncertain=true/);
assert.match(html, /name:["']desktop_job_by_plan["']/);
assert.doesNotMatch(html, /async function sendFollowUp\(text\)\{[^\n]*window\.openai/);
assert.doesNotMatch(html, /\.workspace\{grid-row:4/);
assert.match(html, /main=document\.createElement\(["']button["']\)/);
assert.match(html, /main\.setAttribute\("aria-label",english\?'View task:/);
assert.match(html, /check\.setAttribute\("aria-label",english\?'Select task:/);
assert.match(html, /function promptKey\(id,mode\)/);
assert.match(html, /已清空批次；任务草稿仍然保留/);
assert.match(html, /等待 "\+waiting\+" 条指令/);
assert.match(html, /aria-labelledby=["']launchTitle["']/);
assert.match(html, /aria-labelledby=["']dangerTitle["']/);
const nativeLaunchStart = html.indexOf("var initialJob=makeInitialNativeJob");
const nativeLaunchEnd = html.indexOf('state.panel="activity";state.selected.clear()', nativeLaunchStart);
assert.ok(nativeLaunchStart >= 0 && nativeLaunchEnd > nativeLaunchStart, "missing native launch flow");
const nativeLaunch = html.slice(nativeLaunchStart, nativeLaunchEnd);
assert.ok(
  nativeLaunch.indexOf("rememberJob(initialJob)") < nativeLaunch.indexOf("watchNativeJob(initialJob)"),
  "native job must be remembered before its watcher starts",
);
assert.ok(
  nativeLaunch.indexOf("watchNativeJob(initialJob)") < nativeLaunch.indexOf("sendFollowUp(p.dispatchMessage)"),
  "native watcher must start before ui/message",
);
const refreshStart = html.indexOf("async function refresh()");
const refreshEnd = html.indexOf("async function pollQuota", refreshStart);
assert.doesNotMatch(
  html.slice(refreshStart, refreshEnd),
  /dispatchUncertain=false/,
  "ordinary inventory refresh must not unlock an uncertain dispatch",
);
assert.match(html, /if\(nativeJobIsTerminal\(current\)\)\{clearDispatchUncertain\(current\)/);
assert.match(html, /if\(isNativeJobUnavailable\(e\)\)/);
assert.match(html, /name:["']list_native_jobs["'],arguments:\{limit:20\}/);
assert.match(html, /setTimeout\(function\(\)\{void loadNativeJobs\(\)\},0\)/);
const nativeRestoreStart = html.indexOf("async function loadNativeJobs()");
const nativeRestoreEnd = html.indexOf("function openLaunchConfirm", nativeRestoreStart);
const nativeRestore = html.slice(nativeRestoreStart, nativeRestoreEnd);
assert.match(nativeRestore, /rememberJob\(job\)/);
assert.match(nativeRestore, /watchNativeJob\(job\)/);
assert.doesNotMatch(nativeRestore, /sendFollowUp|ui\/message/);
assert.match(nativeRestore, /if\(activeAtMerge\)state\.activeJobId=activeAtMerge/);
assert.match(
  html,
  /reportedDone=isNativeJob\(job\)\?nativeReportedDone:Math\.max\(0,Number\(job&&job\.completed\)\|\|0\)/,
);
const jobStatsStart = scripts[0].indexOf("function jobStats(job)");
const jobStatsEnd = scripts[0].indexOf("function normalizeNativeTargetStatus", jobStatsStart);
const jobStats = new Function(
  `function isNativeJob(job){return Boolean(job&&job.channel==="native")};${scripts[0].slice(jobStatsStart, jobStatsEnd)};return jobStats;`,
)();
assert.equal(
  jobStats({
    total: 2,
    completed: 1,
    failed: 1,
    running: 1,
    targets: [{ status: "failed" }, { status: "running" }],
  }).done,
  1,
  "desktop completed already includes failed terminal targets",
);
assert.equal(
  jobStats({
    channel: "native",
    total: 2,
    completed: 0,
    failed: 1,
    skipped: 0,
    running: 1,
    targets: [{ status: "failed" }, { status: "running" }],
  }).done,
  1,
  "native completed is success-only and must still include failed targets",
);
const mockHost = await readFile(new URL("../tests/ui-host.html", import.meta.url), "utf8");
assert.match(mockHost, /message\.method === "ui\/initialize"/);
assert.match(mockHost, /hostLocale = hostParams\.get\("hostLocale"\)/);
assert.match(mockHost, /hostContext: \{ theme: "light", displayMode: "inline", locale: hostLocale \}/);
assert.match(mockHost, /nativeDone = nativeReads >= 4/);
assert.match(mockHost, /phase: nativeDone \? "finished" : "sent"/);
assert.match(mockHost, /legacyInit === "timeout"/);
assert.match(mockHost, /name === "list_native_jobs"/);
assert.match(mockHost, /name === "open_external_panel"/);
assert.match(mockHost, /MOCK EXTERNAL PANEL REQUESTED/);
process.stdout.write(JSON.stringify({ ok: true, scripts: scripts.length }) + "\n");
