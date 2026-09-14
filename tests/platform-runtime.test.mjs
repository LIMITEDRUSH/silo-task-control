import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  applicationDataRoot,
  resolveCodexCommand,
  siloDataPath,
} from "../src/platform-runtime.mjs";
import { defaultJournalPath } from "../src/desktop-dispatcher.mjs";
import { browserArguments, resolveDesktopBrowser } from "../desktop/launch.mjs";

test("maps SILO persistence to platform-native data directories", () => {
  assert.equal(
    applicationDataRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\Data" }, home: "C:\\Users\\A" }),
    "C:\\Data",
  );
  assert.equal(
    applicationDataRoot({ platform: "darwin", env: {}, home: "/Users/a" }),
    join("/Users/a", "Library", "Application Support"),
  );
  assert.equal(
    siloDataPath("native-snapshot.json", { platform: "darwin", env: {}, home: "/Users/a" }),
    join("/Users/a", "Library", "Application Support", "SILO", "native-snapshot.json"),
  );
  assert.equal(
    defaultJournalPath({ platform: "darwin", env: {}, home: "/Users/a" }),
    join("/Users/a", "Library", "Application Support", "SILO", "jobs.json"),
  );
});

test("finds common Apple Silicon Codex CLI installations", () => {
  assert.equal(
    resolveCodexCommand({
      platform: "darwin",
      env: { PATH: "" },
      home: "/Users/a",
      existsFn: (path) => path === "/opt/homebrew/bin/codex",
    }),
    "/opt/homebrew/bin/codex",
  );
});

test("opens the identical panel in a macOS Chromium app window with a safe fallback", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = resolveDesktopBrowser({
    platform: "darwin",
    env: {},
    existsFn: (path) => path === chrome,
  });
  assert.deepEqual(browser, { executable: chrome, mode: "chromium-app" });
  assert.deepEqual(browserArguments(browser, "http://127.0.0.1:4763/?desktop=1"), [
    "--app=http://127.0.0.1:4763/?desktop=1",
    "--start-maximized",
    "--disable-features=msEdgeSidebarV2",
  ]);
  assert.deepEqual(
    resolveDesktopBrowser({ platform: "darwin", env: {}, existsFn: () => false }),
    { executable: "/usr/bin/open", mode: "default-browser" },
  );
});
