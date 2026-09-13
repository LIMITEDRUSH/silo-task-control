import test from "node:test";
import assert from "node:assert/strict";
import { preflightDesktopPlan } from "../src/desktop-preflight.mjs";

function target(threadId) {
  return { threadId, title: threadId, cwd: process.cwd(), prompt: "continue" };
}

test("desktop preflight keeps resumable tasks and skips active or missing targets", async () => {
  const plan = {
    id: "plan-1",
    concurrency: 8,
    targets: [target("idle"), target("active"), target("missing")],
  };
  const result = await preflightDesktopPlan(plan, [
    { id: "idle", cwd: process.cwd(), status: { type: "idle" } },
    { id: "active", cwd: process.cwd(), status: { type: "active" } },
  ]);
  assert.deepEqual(result.plan.targets.map((item) => item.threadId), ["idle"]);
  assert.equal(result.requestedCount, 3);
  assert.equal(result.eligibleCount, 1);
  assert.deepEqual(result.skipped.map((item) => item.threadId), ["active", "missing"]);
});

test("desktop preflight keeps unloaded tasks for atomic codex exec resume", async () => {
  const plan = {
    id: "plan-2",
    concurrency: 2,
    targets: [target("safe"), target("external")],
  };
  const result = await preflightDesktopPlan(plan, [
    { id: "safe", cwd: process.cwd(), status: { type: "notLoaded" } },
    { id: "external", cwd: process.cwd(), status: { type: "notLoaded" } },
  ]);
  assert.deepEqual(result.plan.targets.map((item) => item.threadId), ["safe", "external"]);
  assert.equal(result.skipped.length, 0);
});

test("desktop preflight dispatches from the thread's current working directory", async () => {
  const stale = { ...target("moved"), cwd: new URL("..", import.meta.url).pathname };
  const current = process.cwd();
  const result = await preflightDesktopPlan(
    { id: "plan-moved", concurrency: 1, targets: [stale] },
    [{ id: "moved", cwd: current, status: { type: "idle" } }],
  );

  assert.equal(result.eligibleCount, 1);
  assert.equal(result.plan.targets[0].cwd, current);
});
