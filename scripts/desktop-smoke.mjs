import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";

const port = 4764;
const child = spawn(process.execPath, ["./desktop/server.mjs", "--port", String(port)], {
  cwd: new URL("..", import.meta.url),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, SILO_JOURNAL_PATH: "false" },
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

function requestStatusWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const probe = request(
      { hostname: "127.0.0.1", port, path, headers: { host } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    probe.on("error", reject);
    probe.end();
  });
}

async function waitForReady() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("desktop server did not start\n" + stderr.join(""));
}

try {
  const ping = await waitForReady();
  assert.equal(ping.ok, true);
  const page = await fetch(`http://127.0.0.1:${port}/?desktop=1`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /SILO Task Control/);
  assert.match(html, /id="folderList"/);

  const hostSpoofStatus = await requestStatusWithHost(
    "/api/ping",
    `127.0.0.1.evil.example:${port}`,
  );
  assert.equal(hostSpoofStatus, 403);

  const crossSite = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ method: "tools/call", params: { name: "desktop_jobs" } }),
  });
  assert.equal(crossSite.status, 403);

  const plainText = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ method: "tools/call", params: { name: "desktop_jobs" } }),
  });
  assert.equal(plainText.status, 415);

  const localRpc = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({
      method: "tools/call",
      params: { name: "desktop_jobs", arguments: { limit: 1 } },
    }),
  });
  assert.equal(localRpc.status, 200);
  const localRpcBody = await localRpc.json();
  assert.ok(Array.isArray(localRpcBody.result.structuredContent.jobs));
  process.stdout.write(JSON.stringify({ ok: true, port }) + "\n");
} finally {
  child.kill();
}
