import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NativeJobStore, defaultNativeJobsPath } from "../src/native-job-store.mjs";
import { PlanStore } from "../src/plan-store.mjs";

const execFileAsync = promisify(execFile);
const nativeJobStoreUrl = new URL("../src/native-job-store.mjs", import.meta.url).href;

async function claimInChild(filePath, jobId, threadId) {
  const script = [
    `import { NativeJobStore } from ${JSON.stringify(nativeJobStoreUrl)};`,
    `const store = new NativeJobStore({ filePath: ${JSON.stringify(filePath)} });`,
    `const result = store.claim(${JSON.stringify(jobId)}, ${JSON.stringify(threadId)});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { timeout: 15_000, windowsHide: true },
  );
  return JSON.parse(stdout);
}

function tempStore(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "silo-native-job-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, "native-jobs.json");
  return { directory, filePath, store: new NativeJobStore({ filePath, ...options }) };
}

function plan(targets = ["thread-123456"]) {
  const now = Date.now();
  return {
    id: `silo-plan-${now}`,
    createdAt: now,
    expiresAt: now + 60_000,
    concurrency: 2,
    modelProfile: "preserve",
    modelOverride: null,
    selectedCount: targets.length,
    targets: targets.map((threadId, index) => ({
      threadId,
      hostId: "local",
      title: `Task ${index + 1}`,
      cwd: `C:\\workspace\\${index + 1}`,
      mode: "continue",
      prompt: `Continue ${index + 1}`,
      collisionRisk: false,
    })),
  };
}

test("uses LOCALAPPDATA/SILO/native-jobs.json by default", () => {
  assert.equal(
    defaultNativeJobsPath({ LOCALAPPDATA: "C:\\LocalData" }),
    join("C:\\LocalData", "SILO", "native-jobs.json"),
  );
  assert.throws(
    () => new NativeJobStore({ persistence: false, claimLeaseMs: 0 }),
    /claimLeaseMs/,
  );
});

test("uses the native macOS Application Support directory", () => {
  assert.equal(
    defaultNativeJobsPath({}, { platform: "darwin", home: "/Users/tester" }),
    join("/Users/tester", "Library", "Application Support", "SILO", "native-jobs.json"),
  );
});

test("persists a prepared job and restores both job and plan after restart", (t) => {
  const { filePath, store } = tempStore(t);
  const sourcePlan = plan();
  const created = store.create(sourcePlan);

  assert.match(created.id, /^native-/);
  assert.equal(created.planId, sourcePlan.id);
  assert.equal(created.status, "prepared");
  assert.equal(created.total, 1);
  assert.equal(created.pending, 1);
  assert.equal(created.revision, 1);
  assert.deepEqual(
    Object.keys(created.targets[0]).filter((key) =>
      ["threadId", "title", "cwd", "status", "phase", "error"].includes(key)
    ),
    ["threadId", "title", "cwd", "status", "phase", "error"],
  );
  assert.ok(existsSync(filePath));
  assert.equal(store.create(sourcePlan).id, created.id);

  const restarted = new NativeJobStore({ filePath });
  assert.deepEqual(restarted.read(created.id), created);
  assert.deepEqual(restarted.readByPlanId(sourcePlan.id), created);
  assert.equal(restarted.getPlan(sourcePlan.id).targets[0].prompt, "Continue 1");
});

test("atomically grants one sender across store instances", (t) => {
  const { filePath, store } = tempStore(t);
  const created = store.create(plan());
  const secondProcess = new NativeJobStore({ filePath });

  const first = store.claim(created.id, "thread-123456");
  const duplicate = secondProcess.claim(created.id, "thread-123456");

  assert.equal(first.claimed, true);
  assert.match(first.claimToken, /^claim-/);
  assert.equal(first.target.claimToken, first.claimToken);
  assert.ok(first.claimExpiresAt > first.target.claimedAt);
  assert.equal(first.job.running, 1);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, "target-already-claimed");
  assert.equal(duplicate.job.revision, first.job.revision);
});

test("atomically skips a thread already running in another job", (t) => {
  const { filePath, store } = tempStore(t);
  const firstPlan = plan();
  firstPlan.id = "silo-plan-overlap-running-a";
  const secondPlan = plan();
  secondPlan.id = "silo-plan-overlap-running-b";
  const firstJob = store.create(firstPlan);
  const secondJob = store.create(secondPlan);
  const firstClaim = store.claim(firstJob.id, "thread-123456");
  store.record(firstJob.id, "thread-123456", {
    status: "running",
    phase: "sent",
    claimToken: firstClaim.claimToken,
  });

  const secondProcess = new NativeJobStore({ filePath });
  const overlap = secondProcess.claim(secondJob.id, "thread-123456");
  assert.equal(overlap.claimed, false);
  assert.equal(overlap.reason, "target-active-in-other-job");
  assert.equal(overlap.conflictJobId, firstJob.id);
  assert.equal(overlap.target.status, "skipped");
  assert.equal(overlap.target.phase, "overlap");
  assert.match(overlap.target.error, new RegExp(firstJob.id));
  assert.equal(overlap.job.status, "completed_with_errors");

  const persisted = new NativeJobStore({ filePath }).read(secondJob.id);
  assert.deepEqual(persisted, overlap.job);
});

test("an expired claim in another job does not block a fresh claim", (t) => {
  let now = 50_000;
  const { filePath, store } = tempStore(t, {
    claimLeaseMs: 100,
    now: () => now,
  });
  const firstPlan = plan();
  firstPlan.id = "silo-plan-expired-overlap-a";
  firstPlan.expiresAt = now + 10_000;
  const secondPlan = plan();
  secondPlan.id = "silo-plan-expired-overlap-b";
  secondPlan.expiresAt = now + 10_000;
  const firstJob = store.create(firstPlan);
  const secondJob = store.create(secondPlan);
  const firstClaim = store.claim(firstJob.id, "thread-123456");

  now = firstClaim.claimExpiresAt + 1;
  const secondProcess = new NativeJobStore({
    filePath,
    claimLeaseMs: 100,
    now: () => now,
  });
  const fresh = secondProcess.claim(secondJob.id, "thread-123456");
  assert.equal(fresh.claimed, true);
  assert.equal(fresh.job.id, secondJob.id);
  const expired = secondProcess.read(firstJob.id);
  assert.equal(expired.targets[0].status, "failed");
  assert.equal(expired.targets[0].phase, "claim-timeout");
});

test("concurrent processes grant only one claim across overlapping jobs", async (t) => {
  const { filePath, store } = tempStore(t);
  const firstPlan = plan();
  firstPlan.id = "silo-plan-concurrent-overlap-a";
  const secondPlan = plan();
  secondPlan.id = "silo-plan-concurrent-overlap-b";
  const firstJob = store.create(firstPlan);
  const secondJob = store.create(secondPlan);

  const results = await Promise.all([
    claimInChild(filePath, firstJob.id, "thread-123456"),
    claimInChild(filePath, secondJob.id, "thread-123456"),
  ]);
  const winners = results.filter((result) => result.claimed);
  const losers = results.filter((result) => !result.claimed);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, "target-active-in-other-job");
  assert.equal(losers[0].conflictJobId, winners[0].job.id);
  assert.equal(losers[0].target.status, "skipped");

  const persistedWinner = store.read(winners[0].job.id);
  const persistedLoser = store.read(losers[0].job.id);
  assert.equal(persistedWinner.targets[0].status, "claimed");
  assert.equal(persistedLoser.targets[0].status, "skipped");
  assert.equal(persistedLoser.targets[0].phase, "overlap");
});

test("validates membership and lifecycle while keeping terminal states irreversible", (t) => {
  const { store } = tempStore(t);
  const created = store.create(plan());

  assert.throws(
    () => store.claim(created.id, "thread-outside"),
    /不属于该批次计划/,
  );
  assert.throws(
    () => store.record(created.id, "thread-123456", { status: "running" }),
    /非法任务状态转换/,
  );
  assert.throws(
    () => store.record(created.id, "thread-123456", { status: "invented" }),
    /无效任务状态/,
  );

  const claim = store.claim(created.id, "thread-123456");
  const sent = store.record(created.id, "thread-123456", {
    status: "running",
    phase: "sent",
    claimToken: claim.claimToken,
  });
  assert.equal(sent.job.running, 1);
  assert.equal(sent.job.completed, 0);

  const finished = store.record(created.id, "thread-123456", {
    status: "completed",
    phase: "finished",
    claimToken: claim.claimToken,
  });
  assert.equal(finished.job.status, "completed");
  assert.equal(finished.job.running, 0);
  assert.equal(finished.job.completed, 1);
  assert.throws(
    () => store.record(created.id, "thread-123456", { status: "running" }),
    /终态不可回退/,
  );
});

test("derives mixed terminal totals and persists updates without lock or temp debris", (t) => {
  const { directory, store } = tempStore(t);
  const created = store.create(plan(["thread-first", "thread-second", "thread-third"]));
  store.record(created.id, "thread-first", {
    status: "skipped",
    phase: "preflight",
    error: "already active",
  });
  const secondClaim = store.claim(created.id, "thread-second");
  store.record(created.id, "thread-second", {
    status: "failed",
    phase: "dispatch",
    error: "send failed",
    claimToken: secondClaim.claimToken,
  });
  const thirdClaim = store.claim(created.id, "thread-third");
  const result = store.record(created.id, "thread-third", {
    status: "completed",
    phase: "finished",
    claimToken: thirdClaim.claimToken,
  });

  assert.equal(result.job.status, "completed_with_errors");
  assert.equal(result.job.total, 3);
  assert.equal(result.job.running, 0);
  assert.equal(result.job.completed, 1);
  assert.equal(result.job.failed, 1);
  assert.equal(result.job.skipped, 1);
  assert.deepEqual(readdirSync(directory), ["native-jobs.json"]);
});

test("fences claimed updates with the lease token and keeps running work recoverable", (t) => {
  let now = 10_000;
  const { filePath, store } = tempStore(t, {
    claimLeaseMs: 100,
    now: () => now,
  });
  const created = store.create(plan());
  const claim = store.claim(created.id, "thread-123456");

  assert.throws(
    () => store.record(created.id, "thread-123456", {
      status: "running",
      phase: "sent",
    }),
    /必须提供 claimToken/,
  );
  assert.throws(
    () => store.record(created.id, "thread-123456", {
      status: "running",
      phase: "sent",
      claimToken: "claim-not-the-owner",
    }),
    /claimToken.*不匹配/,
  );
  const running = store.record(created.id, "thread-123456", {
    status: "running",
    phase: "sent",
    claimToken: claim.claimToken,
  });
  assert.equal(running.target.claimExpiresAt, null);
  assert.throws(
    () => store.record(created.id, "thread-123456", {
      status: "running",
      phase: "monitoring",
    }),
    /必须提供 claimToken/,
  );

  now += 10_000;
  const restarted = new NativeJobStore({
    filePath,
    claimLeaseMs: 100,
    now: () => now,
  });
  assert.equal(restarted.read(created.id).targets[0].status, "running");
  const finished = restarted.record(created.id, "thread-123456", {
    status: "completed",
    phase: "finished",
    claimToken: claim.claimToken,
  });
  assert.equal(finished.job.status, "completed");
});

test("durably times out an abandoned claim instead of leaving the job stuck", (t) => {
  let now = 20_000;
  const { filePath, store } = tempStore(t, {
    claimLeaseMs: 100,
    now: () => now,
  });
  const created = store.create(plan());
  const claim = store.claim(created.id, "thread-123456");

  const competing = new NativeJobStore({
    filePath,
    claimLeaseMs: 100,
    now: () => now,
  });
  assert.equal(competing.claim(created.id, "thread-123456").claimed, false);

  now = claim.claimExpiresAt + 1;
  assert.throws(
    () => store.record(created.id, "thread-123456", {
      status: "running",
      phase: "sent",
      claimToken: claim.claimToken,
    }),
    /终态不可回退/,
  );
  const restarted = new NativeJobStore({
    filePath,
    claimLeaseMs: 100,
    now: () => now,
  });
  const expired = restarted.readByPlanId(created.planId);
  assert.equal(expired.status, "failed");
  assert.equal(expired.running, 0);
  assert.equal(expired.failed, 1);
  assert.equal(expired.targets[0].status, "failed");
  assert.equal(expired.targets[0].phase, "claim-timeout");
  assert.match(expired.targets[0].error, /不会自动重试/);
  assert.equal(restarted.claim(created.id, "thread-123456").reason, "target-terminal");

  const afterSecondRestart = new NativeJobStore({
    filePath,
    claimLeaseMs: 100,
    now: () => now,
  });
  assert.deepEqual(afterSecondRestart.read(created.id), expired);
});

test("durably times out only pending targets after the dispatch window expires", (t) => {
  let now = 30_000;
  const { filePath, store } = tempStore(t, {
    claimLeaseMs: 10_000,
    now: () => now,
  });
  const sourcePlan = plan([
    "thread-pending",
    "thread-claimed",
    "thread-running",
    "thread-terminal",
  ]);
  sourcePlan.expiresAt = now + 100;
  const created = store.create(sourcePlan);
  assert.equal(created.expiresAt, sourcePlan.expiresAt);

  const claimed = store.claim(created.id, "thread-claimed");
  const runningClaim = store.claim(created.id, "thread-running");
  store.record(created.id, "thread-running", {
    status: "running",
    phase: "sent",
    claimToken: runningClaim.claimToken,
  });
  store.record(created.id, "thread-terminal", {
    status: "skipped",
    phase: "preflight",
    error: "already active",
  });

  now = sourcePlan.expiresAt + 1;
  const expired = store.read(created.id);
  const byId = new Map(expired.targets.map((target) => [target.threadId, target]));
  assert.equal(byId.get("thread-pending").status, "failed");
  assert.equal(byId.get("thread-pending").phase, "dispatch-timeout");
  assert.match(byId.get("thread-pending").error, /未发送/);
  assert.equal(byId.get("thread-claimed").status, "claimed");
  assert.equal(byId.get("thread-running").status, "running");
  assert.equal(byId.get("thread-terminal").status, "skipped");
  assert.equal(expired.status, "running");

  const restarted = new NativeJobStore({
    filePath,
    claimLeaseMs: 10_000,
    now: () => now,
  });
  assert.deepEqual(restarted.read(created.id), expired);
  restarted.record(created.id, "thread-claimed", {
    status: "completed",
    phase: "finished",
    claimToken: claimed.claimToken,
  });
  const finished = restarted.record(created.id, "thread-running", {
    status: "completed",
    phase: "finished",
    claimToken: runningClaim.claimToken,
  });
  assert.equal(finished.job.status, "completed_with_errors");
});

test("keeps legacy persisted jobs without expiresAt compatible", (t) => {
  let now = 40_000;
  const { filePath, store } = tempStore(t, { now: () => now });
  const sourcePlan = plan();
  sourcePlan.expiresAt = now + 100;
  const created = store.create(sourcePlan);
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  delete payload.jobs[0].job.expiresAt;
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  now = sourcePlan.expiresAt + 10_000;
  const restarted = new NativeJobStore({ filePath, now: () => now });
  const legacy = restarted.read(created.id);
  assert.equal(legacy.expiresAt, undefined);
  assert.equal(legacy.status, "prepared");
  assert.equal(legacy.targets[0].status, "pending");
});

test("lists recent jobs as safe newest-first summaries", () => {
  let now = 1_000;
  const store = new NativeJobStore({ persistence: false, now: () => now });
  const olderPlan = plan(["thread-list-old"]);
  olderPlan.id = "silo-list-older";
  const older = store.create(olderPlan);
  store.record(older.id, "thread-list-old", {
    status: "failed",
    phase: "dispatch",
    error: `first line\nsecond line ${"x".repeat(400)}`,
  });

  now = 2_000;
  const newerPlan = plan(["thread-list-new"]);
  newerPlan.id = "silo-list-newer";
  const newer = store.create(newerPlan);
  const claimed = store.claim(newer.id, "thread-list-new");
  assert.ok(claimed.claimToken);

  const jobs = store.list();
  assert.deepEqual(jobs.map((job) => job.id), [newer.id, older.id]);
  assert.equal(jobs[0].targets[0].status, "claimed");
  assert.equal(jobs[0].targets[0].threadId, "thread-list-new");
  assert.equal("claimToken" in jobs[0].targets[0], false);
  assert.equal("claimExpiresAt" in jobs[0].targets[0], false);
  assert.equal(jobs[0].targets[0].error, null);
  assert.match(jobs[1].targets[0].error, /^first line second line /);
  assert.ok(jobs[1].targets[0].error.length <= 300);
  assert.doesNotMatch(JSON.stringify(jobs), /Continue 1/);
  assert.deepEqual(store.list(1).map((job) => job.id), [newer.id]);
  assert.throws(() => store.list(0), /1 到 50/);
  assert.throws(() => store.list(51), /1 到 50/);
  assert.throws(() => store.list(1.5), /1 到 50/);
});

test("PlanStore persists jobs, emits explicit skill dispatch, and restores live plans", (t) => {
  const { filePath, store } = tempStore(t);
  const task = {
    id: "thread-planned",
    title: "Planned task",
    hostId: "local",
    runnable: true,
    collisionRisk: false,
    cwd: process.cwd(),
  };
  const inventory = { getTask(id) { return id === task.id ? task : null; } };
  const plans = new PlanStore(inventory, { jobStore: store });
  const prepared = plans.prepare({
    tasks: [{ id: task.id, mode: "continue" }],
    concurrency: 1,
    modelProfile: "preserve",
    confirmed: true,
  });

  assert.match(prepared.jobId, /^native-/);
  assert.equal(prepared.job.id, prepared.jobId);
  assert.equal(prepared.nativeJob.id, prepared.jobId);
  assert.match(prepared.dispatchMessage, /\$silo-task-control/);
  assert.match(prepared.dispatchMessage, /read_native_batch_job/);
  assert.match(prepared.dispatchMessage, /消息已显示在对应 Codex 任务/);

  const restartedJobs = new NativeJobStore({ filePath });
  const restartedPlans = new PlanStore(inventory, { jobStore: restartedJobs });
  assert.equal(restartedPlans.get(prepared.planId).targets[0].threadId, task.id);
});

test("supports explicitly disabled persistence for isolated tests", () => {
  const store = new NativeJobStore({ persistence: false });
  const created = store.create(plan());
  assert.equal(store.read(created.id).id, created.id);
});
