import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 120_000;

export class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin =
      options.codexBin || process.env.CODEX_CLI_PATH || process.env.CODEX_BIN || "codex";
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.stderrTail = [];
    this.serverRequests = new Map();
    this.ready = false;
    this.closing = false;
  }

  async start() {
    if (this.ready && this.process) return;
    if (this.startPromise) return this.startPromise;
    this.closing = false;
    this.startPromise = this.#startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, LOG_FORMAT: "json" },
    });
    this.process = child;
    this.ready = false;

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.#handleLine(line));

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 80) this.stderrTail.shift();
      this.emit("diagnostic", line);
    });

    child.on("error", (error) => this.#handleExit(error));
    child.on("exit", (code, signal) => {
      const message = this.closing
        ? "Codex app-server closed"
        : `Codex app-server exited (code=${code ?? "?"}, signal=${signal ?? "none"})`;
      this.#handleExit(new Error(message));
    });

    await this.#requestRaw(
      "initialize",
      {
        clientInfo: {
          name: "silo_task_control",
          title: "SILO Task Control",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "item/agentMessage/delta",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
            "command/exec/outputDelta",
            "item/commandExecution/outputDelta",
          ],
        },
      },
      30_000,
    );
    this.#write({ method: "initialized", params: {} });
    this.ready = true;
    this.emit("ready");
  }

  #handleExit(error) {
    this.ready = false;
    this.process = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit("offline", error);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("diagnostic", `Non-JSON app-server output: ${line}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(String(message.id));
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      const supported = new Set([
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ]);
      if (!supported.has(message.method)) {
        this.#write({
          id: message.id,
          error: { code: -32601, message: `SILO cannot handle app-server request ${message.method}.` },
        });
        return;
      }
      const request = {
        id: String(message.id),
        method: message.method,
        params: message.params || {},
        createdAt: Date.now(),
      };
      this.serverRequests.set(request.id, request);
      this.emit("approval", request);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #write(payload) {
    if (!this.process?.stdin?.writable) throw new Error("Codex app-server is not writable");
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #requestRaw(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.start();
    return this.#requestRaw(method, params, timeoutMs);
  }

  async listThreads({ archived = false } = {}) {
    const all = [];
    let cursor = null;
    let pages = 0;
    do {
      const result = await this.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived,
        useStateDbOnly: true,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      });
      all.push(...(result?.data || []));
      cursor = result?.nextCursor || null;
      pages += 1;
    } while (cursor && pages < 20);
    return {
      items: all,
      truncated: Boolean(cursor),
      limit: 2000,
    };
  }

  async listProjects() {
    const all = [];
    let cursor = null;
    let pages = 0;
    do {
      const result = await this.request("project/list", { cursor, limit: 100 });
      all.push(...(result?.data || []));
      cursor = result?.nextCursor || null;
      pages += 1;
    } while (cursor && pages < 10);
    return all;
  }

  async readRateLimits() {
    return this.request("account/rateLimits/read", undefined, 30_000);
  }

  async readLatestTurn(threadId) {
    try {
      const result = await this.request("thread/turns/list", {
        threadId,
        cursor: null,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      return result?.data?.[0] || null;
    } catch (error) {
      if (!["-32601", -32601].includes(error?.code)) throw error;
      const result = await this.request("thread/read", { threadId, includeTurns: true });
      return result?.thread?.turns?.at(-1) || null;
    }
  }

  async readThread(threadId) {
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    return result?.thread || null;
  }

  async readThreadWithAllTurns(threadId) {
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    const thread = result?.thread;
    if (!thread) return null;
    const pages = [];
    let cursor = null;
    let pageCount = 0;
    do {
      const page = await this.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      });
      pages.push(...(page?.data || []));
      cursor = page?.nextCursor || null;
      pageCount += 1;
    } while (cursor && pageCount < 20);
    return { ...thread, turns: pages.reverse(), turnsTruncated: Boolean(cursor) };
  }

  async sendMessage(threadId, text, options = {}) {
    await this.request("thread/resume", { threadId, excludeTurns: true });
    const params = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      turnTrigger: "silo_direct_message",
    };
    if (options.model) params.model = options.model;
    if (options.effort) params.effort = options.effort;
    if (options.fast) params.serviceTierForTurn = "fast";
    try {
      const result = await this.request("turn/start", params);
      return { ...result, fastRequested: Boolean(options.fast), fastUsed: Boolean(options.fast) };
    } catch (error) {
      if (!options.fast || !/(?:service.?tier|fast|priority).*(?:unsupported|unavailable|invalid|not available)|(?:unsupported|unavailable|invalid).*(?:service.?tier|fast|priority)/i.test(error?.message || "")) {
        throw error;
      }
      delete params.serviceTierForTurn;
      const result = await this.request("turn/start", params);
      return { ...result, fastRequested: true, fastUsed: false, fastFallbackReason: error.message };
    }
  }

  listApprovals(threadId) {
    return [...this.serverRequests.values()]
      .filter((request) => !threadId || request.params?.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  resolveApproval(id, decision = "decline", scope = "turn") {
    const request = this.serverRequests.get(String(id));
    if (!request) throw new Error(`Approval request is no longer pending: ${id}`);
    let result;
    if (request.method === "item/permissions/requestApproval") {
      const requested = request.params?.permissions || {};
      result = {
        permissions: decision === "accept"
          ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value != null))
          : {},
        scope: scope === "session" ? "session" : "turn",
      };
    } else {
      const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);
      result = { decision: allowed.has(decision) ? decision : "decline" };
    }
    this.#write({ id: request.id, result });
    this.serverRequests.delete(request.id);
    return { id: request.id, threadId: request.params?.threadId || null, decision, resolvedAt: Date.now() };
  }

  async readRecentTurns(threadId, limit = 2) {
    const result = await this.request("thread/turns/list", {
      threadId,
      cursor: null,
      limit,
      sortDirection: "desc",
    });
    return { turns: result?.data || [] };
  }

  async close() {
    const child = this.process;
    if (!child) return;
    this.closing = true;
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex app-server client closed"));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.process = null;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1_000);
    timer.unref?.();
  }
}
