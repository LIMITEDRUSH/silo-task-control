import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const builtServer = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const sourceServer = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

function readCodexPackage() {
  const command = [
    "$pkg = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1",
    "if ($null -eq $pkg) { exit 4 }",
    "$pkg | Select-Object Name, Version, InstallLocation | ConvertTo-Json -Compress",
  ].join("; ");
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  return JSON.parse(stdout);
}

async function scanFile(path, needles) {
  const found = Object.fromEntries(needles.map((needle) => [needle, false]));
  let carry = "";
  const longest = Math.max(...needles.map((needle) => needle.length));
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const text = carry + chunk.toString("utf8");
    for (const needle of needles) {
      if (!found[needle] && text.includes(needle)) found[needle] = true;
    }
    carry = text.slice(-(longest - 1));
  }
  return found;
}

let report;
try {
  const codexPackage = readCodexPackage();
  const asarPath = `${codexPackage.InstallLocation}\\app\\resources\\app.asar`;
  if (!existsSync(asarPath)) throw new Error(`Codex app.asar not found: ${asarPath}`);

  const hostMarkers = await scanFile(asarPath, [
    "openai/ui",
    "entrypoints",
    "mcp-extension-sidebar-catalog",
  ]);
  const serverPath = existsSync(builtServer) ? builtServer : sourceServer;
  const serverText = readFileSync(serverPath, "utf8");
  const siloMetadata = {
    globalEntrypoint:
      serverText.includes('"openai/ui"') &&
      /entrypoints\s*:\s*\[\s*\{\s*type\s*:\s*["']global["']/.test(serverText),
    fullscreenPreference: serverText.includes("preferredModelDisplayMode") && serverText.includes("fullscreen"),
  };
  const ok = Object.values(hostMarkers).every(Boolean) && Object.values(siloMetadata).every(Boolean);
  report = {
    ok,
    pluginRoot,
    codex: {
      name: codexPackage.Name,
      version: String(codexPackage.Version),
      installLocation: codexPackage.InstallLocation,
      asarPath,
    },
    hostMarkers,
    siloMetadata,
    recommendation: ok
      ? "Compatible markers detected. Restart Codex after installing/updating SILO, then verify the SILO sidebar entry."
      : "Compatibility markers are missing. Keep using SILO conversationally; do not patch app.asar. Re-check the new Codex host before enabling a sidebar fallback.",
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 2;
} catch (error) {
  report = {
    ok: false,
    pluginRoot,
    error: error instanceof Error ? error.message : String(error),
    recommendation: "Could not verify the host. Do not modify Codex installation files.",
  };
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
