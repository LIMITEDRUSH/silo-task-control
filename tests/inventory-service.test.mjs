import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { InventoryService } from "../src/inventory-service.mjs";

class MockAppServer extends EventEmitter {
  constructor() {
    super();
    this.ready = true;
    this.stderrTail = [];
  }

  async listThreads() {
    return {
      items: [
        {
          id: "thread-inventory-test",
          title: "Inventory test",
          cwd: process.cwd(),
          archived: false,
          status: { type: "idle" },
          recencyAt: Math.floor(Date.now() / 1000),
        },
      ],
      truncated: true,
      limit: 2000,
    };
  }

  async listProjects() { return []; }
  async readRateLimits() { return null; }
  async readLatestTurn() { return null; }
}

test("reports inventory truncation without hiding scanned tasks", async () => {
  const inventory = new InventoryService(new MockAppServer(), { snapshotPath: false });
  const result = await inventory.scan({ scope: "active", liveThreads: [] });
  assert.equal(result.count, 1);
  assert.equal(result.tasks[0].id, "thread-inventory-test");
  assert.equal(result.tasks[0].folderPath, process.cwd());
  assert.ok(result.tasks[0].folderName);
  assert.equal(result.inventoryTruncated, true);
  assert.match(result.warning, /2000/);
});

test("recognizes a not-loaded thread whose latest turn is still in progress", async () => {
  class ExternalTurnAppServer extends MockAppServer {
    async listThreads() {
      return {
        items: [
          {
            id: "thread-running-elsewhere",
            title: "Running elsewhere",
            cwd: process.cwd(),
            archived: false,
            status: { type: "notLoaded" },
            recencyAt: Math.floor(Date.now() / 1000),
          },
        ],
        truncated: false,
        limit: 2000,
      };
    }

    async readLatestTurn() {
      return { id: "turn-in-progress", status: "inProgress" };
    }
  }

  const inventory = new InventoryService(new ExternalTurnAppServer(), { snapshotPath: false });
  const result = await inventory.scan({ scope: "active", liveThreads: [] });
  assert.equal(result.tasks[0].status, "active");
  assert.equal(result.tasks[0].statusEvidence, "latest_turn_in_progress");
  assert.equal(result.tasks[0].workflowState, "running");
  assert.equal(result.tasks[0].runnable, false);
  assert.match(result.tasks[0].blockedReason, /正在工作/);

  const running = await inventory.scanRunning();
  assert.equal(running.tasks.some((task) => task.id === "thread-running-elsewhere"), true);
});

test("does not treat a normalized interrupted history turn as authoritative live state", async () => {
  class NormalizedHistoryAppServer extends MockAppServer {
    async listThreads() {
      const listed = await super.listThreads();
      listed.items[0].status = { type: "notLoaded" };
      return listed;
    }

    async readLatestTurn() {
      return { id: "turn-normalized", status: "interrupted" };
    }
  }

  const inventory = new InventoryService(new NormalizedHistoryAppServer(), { snapshotPath: false });
  const result = await inventory.scan({ scope: "active", liveThreads: [] });
  assert.equal(result.tasks[0].status, "not_loaded");
  assert.equal(result.tasks[0].statusEvidence, "inventory_process");
  assert.equal(result.tasks[0].collisionRisk, true);
  assert.equal(result.tasks[0].runnable, true);
});

test("never lets an idle bootstrap snapshot override a currently active process", async () => {
  class ActiveAppServer extends MockAppServer {
    async listThreads() {
      const listed = await super.listThreads();
      listed.items[0].status = { type: "active" };
      return listed;
    }
  }

  const inventory = new InventoryService(new ActiveAppServer(), { snapshotPath: false });
  const result = await inventory.scan({
    scope: "active",
    liveThreads: [{ id: "thread-inventory-test", status: "idle", hostId: "local" }],
  });
  assert.equal(result.tasks[0].status, "active");
  assert.equal(result.tasks[0].statusEvidence, "inventory_process");
  assert.equal(result.tasks[0].runnable, false);
});

test("lightweight running scan returns only active and attention-waiting root tasks", async () => {
  class RunningAppServer extends MockAppServer {
    async listThreads() {
      const task = (id, type, activeFlags = []) => ({
        id,
        title: id,
        cwd: process.cwd(),
        archived: false,
        status: { type, activeFlags },
        recencyAt: Math.floor(Date.now() / 1000),
      });
      return {
        items: [
          task("thread-running", "active"),
          task("thread-approval", "active", ["waitingOnApproval"]),
          task("thread-input", "active", ["waitingOnUserInput"]),
          task("thread-idle", "idle"),
          { ...task("thread-child", "active"), parentThreadId: "thread-running" },
        ],
        truncated: false,
      };
    }
  }

  const inventory = new InventoryService(new RunningAppServer(), { snapshotPath: false });
  const result = await inventory.scanRunning();
  assert.equal(result.source, "app-server+latest-turn-observation");
  assert.deepEqual(
    result.tasks.map((task) => task.status).sort(),
    ["active", "waiting_approval", "waiting_input"],
  );
  assert.equal(result.tasks.some((task) => task.id === "thread-idle"), false);
  assert.equal(result.tasks.some((task) => task.id === "thread-child"), false);
});

test("marks tasks returned by the archived query as completed and non-runnable", async () => {
  const inventory = new InventoryService(new MockAppServer(), { snapshotPath: false });
  const result = await inventory.scan({ scope: "archived", liveThreads: [] });
  assert.equal(result.tasks[0].archived, true);
  assert.equal(result.tasks[0].workflowState, "completed");
  assert.equal(result.tasks[0].runnable, false);
  assert.match(result.tasks[0].blockedReason, /归档/);
});

test("retains a recent native status snapshot across background scans", async () => {
  const inventory = new InventoryService(new MockAppServer(), { snapshotPath: false });
  await inventory.scan({
    scope: "active",
    liveThreads: [{ id: "thread-inventory-test", status: "active", hostId: "local" }],
  });
  const refreshed = await inventory.scan({ scope: "active", liveThreads: [] });
  assert.equal(refreshed.tasks[0].status, "active");
  assert.equal(refreshed.tasks[0].workflowState, "running");
  const running = await inventory.scanRunning();
  assert.equal(running.tasks.some((task) => task.id === "thread-inventory-test"), true);
  assert.equal(running.source, "native-snapshot+app-server");
});

test("one-click recommendations use recent turns for continue and optimize", async () => {
  class RecommendationAppServer extends MockAppServer {
    async listThreads() {
      return {
        items: [
          {
            id: "thread-unfinished",
            title: "继续开发任务控制插件",
            cwd: process.cwd(),
            status: { type: "notLoaded" },
            recencyAt: Math.floor(Date.now() / 1000),
          },
          {
            id: "thread-optimize",
            title: "优化产品面板设计",
            cwd: process.cwd(),
            status: { type: "notLoaded" },
            recencyAt: Math.floor(Date.now() / 1000) - 1,
          },
        ],
        truncated: false,
      };
    }

    async readLatestTurn(id) {
      return { status: id === "thread-unfinished" ? "interrupted" : "completed" };
    }

    async readRecentTurns(id) {
      return {
        turns: [
          {
            items: [
              {
                type: "userMessage",
                content: [{ type: "text", text: id === "thread-unfinished" ? "继续完成插件" : "优化产品面板设计" }],
              },
              { type: "agentMessage", text: id === "thread-unfinished" ? "正在处理" : "界面已经完成并通过测试" },
            ],
          },
        ],
      };
    }
  }

  const inventory = new InventoryService(new RecommendationAppServer(), { snapshotPath: false });
  await inventory.scan({ scope: "active", liveThreads: [] });
  const result = await inventory.recommendTasks({ limit: 8 });
  assert.deepEqual(
    result.recommendations.map((item) => [item.id, item.mode]),
    [
      ["thread-unfinished", "continue"],
      ["thread-optimize", "optimize"],
    ],
  );
});

test("a slower superseded scan cannot overwrite the newest inventory cache", async () => {
  class RacingAppServer extends EventEmitter {
    constructor() {
      super();
      this.ready = true;
      this.stderrTail = [];
      this.pending = [];
    }

    listThreads() {
      return new Promise((resolve) => this.pending.push(resolve));
    }

    async listProjects() { return []; }
    async readRateLimits() { return null; }
    async readLatestTurn() { return null; }
  }

  const appServer = new RacingAppServer();
  const inventory = new InventoryService(appServer, { snapshotPath: false });
  const olderPromise = inventory.scan({ scope: "active", liveThreads: [] });
  const newerPromise = inventory.scan({ scope: "active", liveThreads: [] });
  const thread = (id) => ({
    id,
    title: id,
    cwd: process.cwd(),
    archived: false,
    status: { type: "idle" },
    recencyAt: Math.floor(Date.now() / 1000),
  });

  appServer.pending[1]({ items: [thread("thread-newer")], truncated: false });
  const newer = await newerPromise;
  appServer.pending[0]({ items: [thread("thread-older")], truncated: false });
  const older = await olderPromise;

  assert.equal(newer.superseded, false);
  assert.equal(older.superseded, true);
  assert.equal(inventory.getTask("thread-newer").id, "thread-newer");
  assert.equal(inventory.getTask("thread-older"), null);
  assert.equal(inventory.diagnostics().lastScan.scanId, newer.scanId);
});
