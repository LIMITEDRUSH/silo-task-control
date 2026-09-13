import { randomUUID } from "node:crypto";

export const TASK_MODES = Object.freeze({
  continue: {
    label: "继续工作",
    prompt:
      "【执行目标】\n继续完成当前任务，直到用户目标真正达成。\n\n【执行要求】\n1. 先阅读完整对话、现有计划、工作区状态与最近一次结果，明确已完成和未完成部分。\n2. 从最关键的未完成项继续，不重复已经完成的工作，也不重新询问上下文已经回答的问题。\n3. 直接实施所需改动，并运行与风险相称的检查或测试。\n4. 如果遇到阻碍，先穷尽安全且在范围内的替代方案。\n\n【完成标准】\n交付可验证的结果，并简洁说明已完成内容、验证证据及仍需人工处理的事项。",
  },
  optimize: {
    label: "优化工作",
    prompt:
      "【执行目标】\n在保留有效成果的前提下，完成一次有证据的优化冲刺。\n\n【执行要求】\n1. 先检查完整对话、当前实现、未提交改动、测试结果和先前结论。\n2. 找出影响最大的正确性、可靠性、性能、可维护性或体验问题，并按价值排序。\n3. 优先修复高价值问题；避免没有证据的重写、装饰性改动或范围扩张。\n4. 对每项重要改动运行相称的验证，并复查是否引入回归。\n\n【完成标准】\n明确列出改进内容、验证证据和残余风险；没有必要的后续工作时才结束。",
  },
  burn: {
    label: "Burn",
    prompt:
      "【Burn 执行策略｜已开启】\n- 以吞吐量优先，但不降低正确性、验证强度或安全边界。\n- 将互不冲突、可独立验证的工作并行推进；只有确实能缩短关键路径时才使用子代理。\n- 避免等待式叙述、重复检查和已有上下文能够回答的提问。\n- 主动整合所有并行结果，持续推进到目标完成，并报告可核验的证据与残余风险。",
  },
});

const EN_TASK_MODES = Object.freeze({
  continue: {
    label: "Continue",
    prompt:
      "[Objective]\nContinue the current task until the user's goal is genuinely complete.\n\n[Requirements]\n1. Read the full conversation, current plan, workspace state, and latest result; distinguish completed work from remaining work.\n2. Continue from the highest-value unfinished item. Do not repeat completed work or ask for context already provided.\n3. Implement the required changes directly and run checks or tests proportional to the risk.\n4. If blocked, exhaust safe alternatives that remain within scope.\n\n[Done when]\nDeliver a verifiable result and briefly state what changed, the evidence from verification, and anything that still requires manual action.",
  },
  optimize: {
    label: "Optimize",
    prompt:
      "[Objective]\nRun an evidence-based improvement pass while preserving useful existing work.\n\n[Requirements]\n1. Inspect the full conversation, current implementation, uncommitted changes, test results, and prior conclusions.\n2. Identify the highest-impact correctness, reliability, performance, maintainability, or usability issues and rank them by value.\n3. Fix the highest-value issues first. Avoid unsupported rewrites, cosmetic churn, or scope expansion.\n4. Verify each material change and check for regressions.\n\n[Done when]\nState the improvements, verification evidence, and residual risks. Stop only when no necessary follow-up remains.",
  },
  burn: {
    label: "Burn",
    prompt:
      "[Burn execution strategy | On]\n- Prioritize throughput without weakening correctness, verification, or safety boundaries.\n- Run independent, non-conflicting, independently verifiable work in parallel; use subagents only when they shorten the critical path.\n- Avoid wait narration, repeated checks, and questions already answered by the available context.\n- Integrate every parallel result, keep moving until the objective is complete, and report verifiable evidence and residual risks.",
  },
});

function normalizeLocale(locale) {
  return locale === "en" ? "en" : "zh-CN";
}

function taskModesFor(locale) {
  return normalizeLocale(locale) === "en" ? EN_TASK_MODES : TASK_MODES;
}

export const MODEL_PROFILES = Object.freeze({
  preserve: { label: "保持各任务现有模型", model: null, thinking: null },
  spark: { label: "Spark 极速", model: "gpt-5.3-codex-spark", thinking: "xhigh" },
  "sol-max": { label: "Sol Max", model: "gpt-5.6-sol", thinking: "max" },
});

export const MODELS = Object.freeze({
  preserve: { label: "保持各任务现有模型", model: null },
  "gpt-6-astra": { label: "GPT-6 Astra", model: "gpt-6-astra" },
  "gpt-5.6-sol": { label: "GPT-5.6 Sol", model: "gpt-5.6-sol" },
  "gpt-5.6-terra": { label: "GPT-5.6 Terra", model: "gpt-5.6-terra" },
  "gpt-5.6-luna": { label: "GPT-5.6 Luna（快速）", model: "gpt-5.6-luna" },
  "gpt-5.5": { label: "GPT-5.5", model: "gpt-5.5" },
  "gpt-5.4-mini": { label: "GPT-5.4 Mini", model: "gpt-5.4-mini" },
  "gpt-5.3-codex-spark": { label: "GPT-5.3 Spark（极速）", model: "gpt-5.3-codex-spark" },
});
const THINKING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL_EFFORTS = Object.freeze({
  "gpt-6-astra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-terra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-luna": new Set(["low", "medium", "high", "xhigh", "max"]),
  "gpt-5.5": new Set(["low", "medium", "high", "xhigh"]),
  "gpt-5.4-mini": new Set(["low", "medium", "high", "xhigh"]),
  "gpt-5.3-codex-spark": new Set(["low", "medium", "high", "xhigh"]),
});

const CONCURRENCY_LEVELS = new Set([1, 2, 4, 8]);
const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_PROMPT_LENGTH = 6000;

export function buildTaskPrompt(mode, additionalPrompt = "", promptOverride, burn = false, locale = "zh-CN") {
  const localizedModes = taskModesFor(locale);
  const definition = localizedModes[mode];
  if (!definition) throw new Error(`无效任务模式：${mode}`);
  const hasOverride = promptOverride !== undefined && promptOverride !== null;
  const override = hasOverride ? String(promptOverride).trim() : "";
  if (override.length > MAX_PROMPT_LENGTH) {
    throw new Error(`单个任务指令最多 ${MAX_PROMPT_LENGTH} 个字符`);
  }
  if (hasOverride && !override) throw new Error("自定义任务指令不能为空");
  const extra = String(additionalPrompt || "").trim();
  const base = hasOverride ? override : definition.prompt;
  const hasBurnDirective = base.includes("【Burn 执行策略｜已开启】") || base.includes("[Burn execution strategy | On]");
  const burnPrompt = burn && !hasBurnDirective ? `\n\n${localizedModes.burn.prompt}` : "";
  const extraHeading = normalizeLocale(locale) === "en" ? "[Additional batch instructions]" : "【本批次附加要求】";
  const extraPrompt = !hasOverride && extra ? `\n\n${extraHeading}\n${extra}` : "";
  return `${base}${burnPrompt}${extraPrompt}`;
}

function contextualPrompt(task, mode, additionalPrompt, burn, conversation = {}, locale = "zh-CN") {
  const english = normalizeLocale(locale) === "en";
  const separator = english ? ": " : "：";
  const context = [
    `${english ? "Task" : "任务"}${separator}${task.title}`,
    conversation.user ? `${english ? "Latest user objective" : "最近用户目标"}${separator}${conversation.user}` : task.preview ? `${english ? "Latest request summary" : "最近请求摘要"}${separator}${task.preview}` : "",
    conversation.agent ? `${english ? "Latest execution result" : "最近执行结果"}${separator}${conversation.agent}` : "",
    task.cwd ? `${english ? "Working directory" : "工作目录"}${separator}${task.cwd}` : "",
    task.lastTurnStatus ? `${english ? "Latest turn status" : "最近回合状态"}${separator}${task.lastTurnStatus}` : "",
  ].filter(Boolean).join("\n");
  if (english) return `[Task context]\n${context}\n\n${buildTaskPrompt(mode, additionalPrompt, undefined, burn, locale)}\n\n[Context check]\nBefore starting, compare this summary with the full conversation. If they conflict, trust the full conversation and current workspace evidence.`;
  return `【任务上下文】\n${context}\n\n${buildTaskPrompt(mode, additionalPrompt, undefined, burn, locale)}\n\n【上下文校验】\n开始前核对上述摘要与完整对话；如有冲突，以完整对话和当前工作区证据为准。`;
}

export class PlanStore {
  constructor(inventory, options = {}) {
    this.inventory = inventory;
    this.ttlMs = options.ttlMs || PLAN_TTL_MS;
    this.jobStore = options.jobStore || null;
    this.plans = new Map();
  }

  preview(payload = {}) {
    const task = this.inventory.getTask(payload.id);
    if (!task) throw new Error(`任务不在最近扫描结果中：${payload.id || "unknown"}`);
    const mode = String(payload.mode || "continue");
    if (!TASK_MODES[mode]) throw new Error(`无效任务模式：${mode}`);
    const additionalPrompt = String(payload.additionalPrompt || "").trim();
    if (additionalPrompt.length > 1000) throw new Error("附加指令最多 1000 个字符");
    const locale = normalizeLocale(payload.locale);
    const localizedModes = taskModesFor(locale);
    return {
      id: task.id,
      title: task.title,
      mode,
      modeLabel: localizedModes[mode].label,
      prompt: contextualPrompt(task, mode, additionalPrompt, Boolean(payload.burn), {}, locale),
      maxLength: MAX_PROMPT_LENGTH,
    };
  }

  async previewContextual(payload = {}) {
    const task = this.inventory.getTask(payload.id);
    if (!task) throw new Error(`任务不在最近扫描结果中：${payload.id || "unknown"}`);
    const mode = String(payload.mode || "continue");
    if (!TASK_MODES[mode]) throw new Error(`无效任务模式：${mode}`);
    const additionalPrompt = String(payload.additionalPrompt || "").trim();
    if (additionalPrompt.length > 1000) throw new Error("附加指令最多 1000 个字符");
    const conversation = await this.inventory.readTaskContext(payload.id);
    const locale = normalizeLocale(payload.locale);
    const localizedModes = taskModesFor(locale);
    return {
      id: task.id,
      title: task.title,
      mode,
      modeLabel: localizedModes[mode].label,
      prompt: contextualPrompt(task, mode, additionalPrompt, Boolean(payload.burn), conversation, locale),
      maxLength: MAX_PROMPT_LENGTH,
    };
  }

  prepare(payload = {}) {
    const locale = normalizeLocale(payload.locale);
    const requested = Array.isArray(payload.tasks) ? payload.tasks : [];
    if (!requested.length) throw new Error("至少选择一个任务");
    if (requested.length > 50) throw new Error("单次最多选择 50 个任务");
    if (payload.confirmed !== true) throw new Error("必须在控制面板确认批量调度");

    const concurrency = Number(payload.concurrency ?? 8);
    if (!CONCURRENCY_LEVELS.has(concurrency)) {
      throw new Error("并发数只能是 1、2、4 或 8");
    }
    const modelProfile = String(payload.modelProfile || "preserve");
    if (!MODEL_PROFILES[modelProfile]) throw new Error(`无效模型配置：${modelProfile}`);
    const modelKey = String(payload.model || "preserve");
    if (!MODELS[modelKey]) throw new Error(`无效模型：${modelKey}`);
    const thinking = String(payload.thinking || "").trim() || null;
    if (thinking && !THINKING_LEVELS.has(thinking)) throw new Error(`无效 effort：${thinking}`);
    const additionalPrompt = String(payload.additionalPrompt || "").trim();
    if (additionalPrompt.length > 1000) throw new Error("附加指令最多 1000 个字符");

    const seen = new Set();
    const targets = requested.map((item) => {
      if (!item?.id || seen.has(item.id)) throw new Error("任务列表包含重复或无效 ID");
      seen.add(item.id);
      if (!TASK_MODES[item.mode]) throw new Error(`无效任务模式：${item.mode}`);
      const itemModelKey = String(item.model || modelKey);
      if (!MODELS[itemModelKey]) throw new Error(`无效任务模型：${itemModelKey}`);
      const itemThinking = String(item.thinking || thinking || "medium");
      if (!THINKING_LEVELS.has(itemThinking)) throw new Error(`无效任务 effort：${itemThinking}`);
      if (MODELS[itemModelKey].model && !MODEL_EFFORTS[itemModelKey]?.has(itemThinking)) {
        throw new Error(`${MODELS[itemModelKey].label} 不支持 effort ${itemThinking}`);
      }
      const task = this.inventory.getTask(item.id);
      if (!task) throw new Error(`任务不在最近扫描结果中：${item.id}`);
      if (!task.runnable) throw new Error(`任务当前不可调度：${task.title}`);
      return {
        threadId: task.id,
        hostId: task.hostId || "local",
        title: task.title,
        cwd: task.cwd,
        mode: item.mode,
        prompt: item.prompt !== undefined
          ? buildTaskPrompt(item.mode, additionalPrompt, item.prompt, Boolean(item.burn), locale)
          : contextualPrompt(task, item.mode, additionalPrompt, Boolean(item.burn), {}, locale),
        burn: Boolean(item.burn),
        modelOverride: MODELS[itemModelKey].model
          ? { model: MODELS[itemModelKey].model, thinking: itemThinking }
          : null,
        collisionRisk: Boolean(task.collisionRisk),
      };
    });

    const now = Date.now();
    const id = `silo-${randomUUID()}`;
    const profile = MODEL_PROFILES[modelProfile];
    const selectedModel = MODELS[modelKey];
    const plan = {
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      concurrency,
      locale,
      modelProfile,
      modelOverride: selectedModel.model
        ? { model: selectedModel.model, thinking: thinking || "medium" }
        : profile.model
          ? { model: profile.model, thinking: profile.thinking }
        : null,
      targets,
      selectedCount: targets.length,
      continueCount: targets.filter((target) => target.mode === "continue").length,
      optimizeCount: targets.filter((target) => target.mode === "optimize").length,
      collisionRiskCount: targets.filter((target) => target.collisionRisk).length,
    };
    this.#prune(now);
    const job = this.jobStore?.create(plan) || null;
    this.plans.set(id, plan);

    return {
      planId: id,
      jobId: job?.id || null,
      nativeJob: job,
      // Backward-compatible alias for older control panels.
      job,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      selectedCount: plan.selectedCount,
      continueCount: plan.continueCount,
      optimizeCount: plan.optimizeCount,
      collisionRiskCount: plan.collisionRiskCount,
      concurrency: plan.concurrency,
      modelProfile,
      modelLabel: profile.label,
      model: modelKey,
      thinking,
      dispatchMessage: locale === "en" ?
        `Execute confirmed SILO batch ${id} (native job ${job?.id || "unavailable"}). ` +
        "Use $silo-task-control to call get_batch_plan and read_native_batch_job({planId}), then follow the skill's Native Dispatch workflow exactly. Preflight, claim, and send with native Codex task tools; after send succeeds, immediately record the target as running/sent, then wait and keep recording progress. Do not create tasks, touch targets outside the plan, or request confirmation again. Finally report sent, skipped, and failed counts." :
        `执行已确认的 SILO 批次 ${id}（原生 job ${job?.id || "未启用"}）。` +
        "使用 $silo-task-control，调用 get_batch_plan 与 read_native_batch_job({planId}) 取回权威计划和 job，然后严格按该 skill 的 Native Dispatch 流程，" +
        "用 Codex 原生任务工具预检、claim、发送；发送工具成功返回后立即把目标回写为 running/sent，确认消息已显示在对应 Codex 任务，再等待并持续回写。" +
        "不要创建新任务，不要处理计划外任务，不要再次询问确认；最后报告已发送、跳过和失败数量。",
    };
  }

  get(id) {
    const now = Date.now();
    this.#prune(now);
    let plan = this.plans.get(id);
    if (!plan && this.jobStore) {
      plan = this.jobStore.getPlan(id);
      if (plan && plan.expiresAt > now) this.plans.set(id, plan);
    }
    if (!plan || plan.expiresAt <= now) {
      this.plans.delete(id);
      throw new Error("找不到批次计划，或计划已经过期");
    }
    return JSON.parse(JSON.stringify(plan));
  }

  #prune(now = Date.now()) {
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= now) this.plans.delete(id);
    }
  }
}
