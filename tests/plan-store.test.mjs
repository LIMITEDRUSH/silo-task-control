import test from "node:test";
import assert from "node:assert/strict";
import { PlanStore } from "../src/plan-store.mjs";

function inventoryWith(tasks) {
  const map = new Map(tasks.map((task) => [task.id, task]));
  return { getTask(id) { return map.get(id) || null; } };
}

const runnable = {
  id: "thread-123456",
  title: "Example task",
  hostId: "local",
  runnable: true,
  collisionRisk: false,
  cwd: process.cwd(),
};

test("previews the exact SILO prompt for a selected task", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const preview = store.preview({
    id: runnable.id,
    mode: "optimize",
    additionalPrompt: "保留用户已有改动。",
  });
  assert.equal(preview.id, runnable.id);
  assert.equal(preview.modeLabel, "优化工作");
  assert.match(preview.prompt, /优化冲刺/);
  assert.match(preview.prompt, /保留用户已有改动/);
});

test("builds a task-specific contextual preview and composes Burn independently", async () => {
  const inventory = inventoryWith([runnable]);
  inventory.readTaskContext = async () => ({
    user: "修复列表与准备区之间的拖拽分隔条。",
    agent: "基础布局已经改成上下结构。",
  });
  const store = new PlanStore(inventory);
  const preview = await store.previewContextual({
    id: runnable.id,
    mode: "optimize",
    burn: true,
  });
  assert.match(preview.prompt, /最近用户目标：修复列表与准备区之间的拖拽分隔条/);
  assert.match(preview.prompt, /最近执行结果：基础布局已经改成上下结构/);
  assert.match(preview.prompt, /优化冲刺/);
  assert.match(preview.prompt, /Burn 执行策略｜已开启/);
});

test("prepares an exact short-lived plan", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const prepared = store.prepare({
    tasks: [{ id: runnable.id, mode: "continue" }],
    concurrency: 8,
    modelProfile: "preserve",
    additionalPrompt: "只修改必要文件。",
    confirmed: true,
  });
  assert.match(prepared.planId, /^silo-/);
  assert.equal(prepared.selectedCount, 1);
  const plan = store.get(prepared.planId);
  assert.equal(plan.targets[0].threadId, runnable.id);
  assert.equal(plan.targets[0].cwd, runnable.cwd);
  assert.match(plan.targets[0].prompt, /只修改必要文件/);
  assert.equal(plan.modelOverride, null);
});

test("uses an edited per-task prompt exactly and rejects an empty edit", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const prepared = store.prepare({
    tasks: [{ id: runnable.id, mode: "continue", prompt: "只执行用户审核后的这一条语句。" }],
    concurrency: 1,
    additionalPrompt: "这条全局附加指令不应覆盖单任务编辑。",
    confirmed: true,
  });
  assert.equal(store.get(prepared.planId).targets[0].prompt, "只执行用户审核后的这一条语句。");
  assert.throws(
    () =>
      store.prepare({
        tasks: [{ id: runnable.id, mode: "continue", prompt: "   " }],
        concurrency: 1,
        confirmed: true,
      }),
    /不能为空/,
  );
});

test("appends Burn to an edited prompt exactly once without appending the global prompt", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const prepared = store.prepare({
    tasks: [{
      id: runnable.id,
      mode: "continue",
      prompt: "只执行用户审核后的这一条语句。",
      burn: true,
    }],
    concurrency: 1,
    additionalPrompt: "这条全局附加指令不应覆盖单任务编辑。",
    confirmed: true,
  });
  const prompt = store.get(prepared.planId).targets[0].prompt;
  assert.match(prompt, /^只执行用户审核后的这一条语句。/);
  assert.match(prompt, /Burn 执行策略｜已开启/);
  assert.doesNotMatch(prompt, /这条全局附加指令/);
  assert.equal(prompt.match(/Burn 执行策略｜已开启/g)?.length, 1);
});

test("does not duplicate Burn when the reviewed preview already contains it", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const preview = store.preview({ id: runnable.id, mode: "continue", burn: true });
  const prepared = store.prepare({
    tasks: [{ id: runnable.id, mode: "continue", prompt: preview.prompt, burn: true }],
    concurrency: 1,
    confirmed: true,
  });
  const prompt = store.get(prepared.planId).targets[0].prompt;
  assert.equal(prompt.match(/Burn 执行策略｜已开启/g)?.length, 1);
});

test("rejects missing confirmation and duplicate IDs", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  assert.throws(
    () => store.prepare({ tasks: [{ id: runnable.id, mode: "continue" }], concurrency: 8 }),
    /确认/,
  );
  assert.throws(
    () =>
      store.prepare({
        tasks: [
          { id: runnable.id, mode: "continue" },
          { id: runnable.id, mode: "optimize" },
        ],
        concurrency: 8,
        confirmed: true,
      }),
    /重复/,
  );
});

test("rejects stale, blocked, and invalid selections", () => {
  const blocked = { ...runnable, id: "thread-blocked", runnable: false };
  const store = new PlanStore(inventoryWith([runnable, blocked]));
  assert.throws(
    () =>
      store.prepare({
        tasks: [{ id: blocked.id, mode: "continue" }],
        concurrency: 8,
        confirmed: true,
      }),
    /不可调度/,
  );
  assert.throws(
    () =>
      store.prepare({
        tasks: [{ id: "thread-missing", mode: "continue" }],
        concurrency: 8,
        confirmed: true,
      }),
    /最近扫描结果/,
  );
  assert.throws(
    () =>
      store.prepare({
        tasks: [{ id: runnable.id, mode: "continue" }],
        concurrency: 3,
        confirmed: true,
      }),
    /并发数/,
  );
});

test("applies supported model profiles only", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const prepared = store.prepare({
    tasks: [{ id: runnable.id, mode: "optimize" }],
    concurrency: 2,
    modelProfile: "sol-max",
    confirmed: true,
  });
  const plan = store.get(prepared.planId);
  assert.deepEqual(plan.modelOverride, { model: "gpt-5.6-sol", thinking: "max" });
  assert.match(plan.targets[0].prompt, /优化冲刺/);
});

test("applies and validates per-task model and effort overrides", () => {
  const store = new PlanStore(inventoryWith([runnable]));
  const prepared = store.prepare({
    tasks: [{
      id: runnable.id,
      mode: "continue",
      burn: true,
      model: "gpt-5.6-luna",
      thinking: "max",
    }],
    concurrency: 1,
    confirmed: true,
  });
  const target = store.get(prepared.planId).targets[0];
  assert.deepEqual(target.modelOverride, { model: "gpt-5.6-luna", thinking: "max" });
  assert.equal(target.burn, true);
  assert.match(target.prompt, /Burn 执行策略｜已开启/);

  assert.throws(
    () => store.prepare({
      tasks: [{
        id: runnable.id,
        mode: "continue",
        model: "gpt-5.6-luna",
        thinking: "ultra",
      }],
      concurrency: 1,
      confirmed: true,
    }),
    /不支持 effort ultra/,
  );
});

test("expires plans", async () => {
  const store = new PlanStore(inventoryWith([runnable]), { ttlMs: 1 });
  const prepared = store.prepare({
    tasks: [{ id: runnable.id, mode: "continue" }],
    concurrency: 1,
    confirmed: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => store.get(prepared.planId), /过期/);
});
