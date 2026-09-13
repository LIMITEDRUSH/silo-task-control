import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopDispatcher } from "../src/desktop-dispatcher.mjs";

async function waitForJob(dispatcher, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = dispatcher.get(jobId);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("dispatcher test timed out");
}

function createSpawn(results, calls) {
  return (command, args, options) => {
    const result = results.shift() || { code: 0 };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end(prompt) {
        calls.push({ command, args, options, prompt });
        queueMicrotask(() => {
          if (result.stderr) child.stderr.emit("data", result.stderr);
          child.emit("close", result.code, result.signal || null);
        });
      },
    };
    child.pid = 1234 + calls.length;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    return child;
  };
}

function plan(targets) {
  return { id: "plan-test", concurrency: 2, modelOverride: null, targets };
}

test("sends reviewed prompts through codex exec resume and tracks completion", async () => {
  const calls = [];
  const dispatcher = new DesktopDispatcher({
    codexBin: "codex-test",
    journalPath: false,
    spawnFn: createSpawn([{ code: 0 }, { code: 0 }], calls),
  });
  const started = dispatcher.launch(
    plan([
      { threadId: "thread-a", title: "A", prompt: "Continue A", cwd: process.cwd() },
      { threadId: "thread-b", title: "B", prompt: "Continue B", cwd: process.cwd() },
    ]),
  );
  const completed = await waitForJob(dispatcher, started.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.completed, 2);
  assert.equal(completed.failed, 0);
  assert.deepEqual(completed.targets.map((target) => target.status), ["completed", "completed"]);
  assert.deepEqual(calls.map((call) => call.prompt), ["Continue A", "Continue B"]);
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "exec",
    "resume",
    "--all",
    "--json",
    "--skip-git-repo-check",
  ]);
  assert.deepEqual(calls[0].args.slice(-2), ["thread-a", "-"]);
  assert.equal(dispatcher.list()[0].id, completed.id);
});

test("passes the fast service tier to Codex when a target requests it", async () => {
  const calls = [];
  const dispatcher = new DesktopDispatcher({
    codexBin: "codex-test",
    journalPath: false,
    spawnFn: createSpawn([{ code: 0 }], calls),
  });
  const started = dispatcher.launch(
    plan([{
      threadId: "thread-fast",
      title: "Fast",
      prompt: "Continue quickly",
      cwd: process.cwd(),
      modelOverride: { model: null, thinking: "high", serviceTier: "fast" },
    }]),
  );
  await waitForJob(dispatcher, started.id);

  assert.ok(calls[0].args.includes('service_tier="fast"'));
  assert.ok(calls[0].args.includes('model_reasoning_effort="high"'));
});

test("shows an externally owned task as a safe launch failure", async () => {
  const calls = [];
  const dispatcher = new DesktopDispatcher({
    journalPath: false,
    spawnFn: createSpawn(
      [{ code: 1, stderr: "thread already loaded and owned by another app-server" }],
      calls,
    ),
  });
  const started = dispatcher.launch(
    plan([{ threadId: "thread-active", title: "Active", prompt: "Continue", cwd: process.cwd() }]),
  );
  const completed = await waitForJob(dispatcher, started.id);

  assert.equal(completed.status, "completed_with_errors");
  assert.equal(completed.targets[0].status, "failed");
  assert.match(completed.targets[0].error, /其他 Codex 窗口/);
});

test("restores the last activity journal after a desktop service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "silo-journal-test-"));
  const journalPath = join(directory, "jobs.json");
  let child;
  const spawnFn = () => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    return child;
  };

  try {
    const first = new DesktopDispatcher({ spawnFn, journalPath });
    const started = first.launch(
      plan([{ threadId: "thread-long", title: "Long", prompt: "Continue", cwd: process.cwd() }]),
    );
    assert.equal(first.get(started.id).status, "running");

    const restored = new DesktopDispatcher({ journalPath });
    const last = restored.list()[0];
    assert.equal(last.status, "completed_with_errors");
    assert.equal(last.targets[0].status, "interrupted");
    assert.match(last.targets[0].phase, /服务已重启/);

    first.stopAll();
    await waitForJob(first, started.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stopping a batch cancels queued targets instead of launching them", async () => {
  const calls = [];
  const dispatcher = new DesktopDispatcher({
    journalPath: false,
    spawnFn: createSpawn([{ code: null }, { code: 0 }, { code: 0 }], calls),
  });
  const serialPlan = plan([
    { threadId: "thread-a", title: "A", prompt: "A", cwd: process.cwd() },
    { threadId: "thread-b", title: "B", prompt: "B", cwd: process.cwd() },
    { threadId: "thread-c", title: "C", prompt: "C", cwd: process.cwd() },
  ]);
  serialPlan.concurrency = 1;

  const started = dispatcher.launch(serialPlan);
  const stopped = dispatcher.stopAll("manual");
  const completed = await waitForJob(dispatcher, started.id);

  assert.equal(stopped.activeCount, 1);
  assert.equal(stopped.stoppedCount, 1);
  assert.equal(stopped.cancelledQueuedCount, 2);
  assert.equal(calls.length, 1);
  assert.equal(completed.status, "completed_with_errors");
  assert.equal(completed.completed, 3);
  assert.equal(completed.failed, 3);
  assert.deepEqual(
    completed.targets.map((target) => target.status),
    ["interrupted", "interrupted", "interrupted"],
  );
});

test("launch is idempotent for the same reviewed plan", async () => {
  const calls = [];
  const dispatcher = new DesktopDispatcher({
    journalPath: false,
    spawnFn: createSpawn([{ code: 0 }, { code: 0 }], calls),
  });
  const reviewedPlan = plan([
    { threadId: "thread-once", title: "Once", prompt: "Continue", cwd: process.cwd() },
  ]);

  const first = dispatcher.launch(reviewedPlan);
  const retried = dispatcher.launch(reviewedPlan);
  const completed = await waitForJob(dispatcher, first.id);

  assert.equal(retried.id, first.id);
  assert.equal(dispatcher.getByPlanId(reviewedPlan.id).id, first.id);
  assert.equal(completed.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal("output" in completed.targets[0], false);
});

test("overlapping plans never send the same task twice", async () => {
  const calls = [];
  let activeChild;
  const dispatcher = new DesktopDispatcher({
    journalPath: false,
    spawnFn(command, args, options) {
      activeChild = new EventEmitter();
      activeChild.stdout = new EventEmitter();
      activeChild.stderr = new EventEmitter();
      activeChild.stdin = {
        end(prompt) {
          calls.push({ command, args, options, prompt });
        },
      };
      activeChild.killed = false;
      activeChild.kill = () => true;
      return activeChild;
    },
  });
  const firstPlan = plan([
    { threadId: "thread-shared", title: "Shared", prompt: "First", cwd: process.cwd() },
  ]);
  firstPlan.id = "plan-overlap-one";
  const secondPlan = plan([
    { threadId: "thread-shared", title: "Shared", prompt: "Second", cwd: process.cwd() },
  ]);
  secondPlan.id = "plan-overlap-two";

  const first = dispatcher.launch(firstPlan);
  const second = dispatcher.launch(secondPlan);
  const skipped = await waitForJob(dispatcher, second.id);

  assert.equal(calls.length, 1);
  assert.equal(skipped.status, "completed_with_errors");
  assert.equal(skipped.completed, 1);
  assert.equal(skipped.failed, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.targets[0].status, "skipped");
  assert.match(skipped.targets[0].error, /避免重复发送/);

  activeChild.emit("close", 0, null);
  assert.equal((await waitForJob(dispatcher, first.id)).status, "completed");
});

test("a synchronous spawn failure becomes a terminal target failure", async () => {
  const dispatcher = new DesktopDispatcher({
    journalPath: false,
    spawnFn() {
      throw new Error("spawn exploded");
    },
  });

  const started = dispatcher.launch(
    plan([{ threadId: "thread-bad-spawn", title: "Bad", prompt: "Continue", cwd: process.cwd() }]),
  );
  const completed = await waitForJob(dispatcher, started.id);

  assert.equal(completed.status, "completed_with_errors");
  assert.equal(completed.running, 0);
  assert.equal(completed.completed, 1);
  assert.equal(completed.failed, 1);
  assert.equal(completed.targets[0].status, "failed");
  assert.match(completed.targets[0].error, /spawn exploded/);
});

test("a child stdin error becomes a terminal target failure", async () => {
  const dispatcher = new DesktopDispatcher({
    journalPath: false,
    spawnFn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => queueMicrotask(() => child.stdin.emit("error", new Error("EPIPE")));
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      return child;
    },
  });

  const started = dispatcher.launch(
    plan([{ threadId: "thread-epipe", title: "EPIPE", prompt: "Continue", cwd: process.cwd() }]),
  );
  const completed = await waitForJob(dispatcher, started.id);

  assert.equal(completed.status, "completed_with_errors");
  assert.equal(completed.targets[0].status, "failed");
  assert.match(completed.targets[0].error, /EPIPE/);
});
