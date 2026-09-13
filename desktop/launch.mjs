import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_PATH = fileURLToPath(new URL("./server.mjs", import.meta.url));
const HOST = "127.0.0.1";
const PORTS = Array.from({ length: 10 }, (_, index) => 4763 + index);

function normalizePath(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

async function probe(port, timeoutMs = 250) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function portIsOpen(port, timeoutMs = 150) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function where(command) {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value && existsSync(value)) || null;
}

function findNewest(root, filename) {
  if (!root || !existsSync(root)) return null;
  const pending = [root];
  let newest = null;
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
        newest = fullPath;
      }
    }
  }
  return newest;
}

function resolveCodex() {
  for (const candidate of [process.env.CODEX_CLI_PATH, process.env.CODEX_BIN]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const onPath = where("codex");
  if (onPath) return onPath;
  return findNewest(join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin"), "codex.exe");
}

function resolveEdge() {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  const installed = candidates.find((candidate) => candidate && existsSync(candidate));
  return installed || where("msedge");
}

async function choosePort() {
  for (const port of PORTS) {
    const current = await probe(port, 120);
    if (current?.ok && normalizePath(current.root) === normalizePath(ROOT)) {
      return { port, running: true };
    }
  }
  for (const port of PORTS) {
    if (!(await portIsOpen(port))) return { port, running: false };
  }
  throw new Error("No free SILO desktop port is available.");
}

async function waitUntilReady(port, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await probe(port, 100);
    if (current?.ok && normalizePath(current.root) === normalizePath(ROOT)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("SILO desktop service did not become ready.");
}

async function main() {
  if (process.platform !== "win32") throw new Error("The SILO external panel currently requires Windows.");
  if (!existsSync(SERVER_PATH)) throw new Error("SILO desktop server is missing.");
  const edgePath = resolveEdge();
  if (!edgePath) throw new Error("Microsoft Edge was not found.");
  const selected = await choosePort();
  if (!selected.running) {
    const codexPath = resolveCodex();
    const pathEntries = [codexPath ? dirname(codexPath) : null, process.env.PATH]
      .filter(Boolean)
      .join(delimiter);
    const child = spawn(process.execPath, [SERVER_PATH, "--port", String(selected.port)], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        PATH: pathEntries,
        ...(codexPath ? { CODEX_CLI_PATH: codexPath } : {}),
      },
    });
    child.unref();
    await waitUntilReady(selected.port);
  }
  const url = `http://${HOST}:${selected.port}/?desktop=1`;
  const edge = spawn(
    edgePath,
    ["--app=" + url, "--start-maximized", "--disable-features=msEdgeSidebarV2"],
    { detached: true, stdio: "ignore", windowsHide: false },
  );
  edge.unref();
  process.stdout.write(JSON.stringify({ ok: true, port: selected.port, reused: selected.running, url }) + "\n");
}

main().catch((error) => {
  process.stderr.write(`SILO launch failed: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
