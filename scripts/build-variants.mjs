import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const rootLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const version = `${rootPackage.version}+codex.20260914`;

const variants = [
  {
    name: "silo-cn",
    locale: "zh-CN",
    displayName: "SILO 中文",
    shortDescription: "用一个轻量面板管理 Codex 任务。",
    longDescription: "SILO 会自动跟随本地 Codex 的语言，用于扫描、筛选、批量继续或优化任务，并查看当前运行任务与历史批次。",
    defaultPrompt: [
      "打开 SILO 控制面板，扫描我现在的 Codex 任务。",
      "列出当前运行中的 Codex 任务。",
      "使用 SILO 智能选择，推荐应该继续或优化的任务。",
    ],
  },
  {
    name: "silo-en",
    locale: "en",
    displayName: "SILO English",
    shortDescription: "Manage Codex tasks from one lightweight panel.",
    longDescription: "SILO follows the local Codex language automatically, scans and filters tasks, and batch-continues or optimizes reviewed work.",
    defaultPrompt: [
      "Open the SILO control panel and scan my current Codex tasks.",
      "Show every Codex task that is currently running.",
      "Use SILO Smart select and recommend tasks to continue or optimize.",
    ],
  },
  {
    name: "silo-mac",
    locale: "en",
    packageVersion: `${rootPackage.version}-mac.1`,
    displayName: "SILO for Mac",
    shortDescription: "The v0.6.1 SILO panel, fitted for Codex on macOS.",
    longDescription: "SILO for Mac preserves the v0.6.1 workbench and behavior while adapting its task ledger, header, toolbar, and shortcuts to the macOS Codex panel.",
    defaultPrompt: [
      "Open the SILO control panel and scan my current Codex tasks.",
      "Show every Codex task that is currently running.",
      "Use SILO Smart select and recommend tasks to continue or optimize.",
    ],
  },
];

const sharedDirectories = ["assets", "desktop", "dist", "src", "ui"];

for (const variant of variants) {
  const target = join(root, "plugins", variant.name);
  await mkdir(join(target, ".codex-plugin"), { recursive: true });
  await mkdir(join(target, "skills", "silo-task-control"), { recursive: true });
  for (const directory of sharedDirectories) {
    await cp(join(root, directory), join(target, directory), {
      recursive: true,
      force: true,
    });
  }
  const bundledServerPath = join(target, "dist", "server.mjs");
  const bundledServer = await readFile(bundledServerPath, "utf8");
  await writeFile(bundledServerPath, bundledServer.replace(/[ \t]+$/gm, ""));
  await cp(
    join(root, "skills", "silo-task-control", "SKILL.md"),
    join(target, "skills", "silo-task-control", "SKILL.md"),
    { force: true },
  );
  const packageVersion = variant.packageVersion || rootPackage.version;
  const packageJson = {
    name: variant.name,
    version: packageVersion,
    private: true,
    type: "module",
    engines: rootPackage.engines,
    dependencies: rootPackage.dependencies,
  };
  const packageLock = structuredClone(rootLock);
  packageLock.name = variant.name;
  packageLock.version = packageVersion;
  packageLock.packages[""].name = variant.name;
  packageLock.packages[""].version = packageVersion;
  await writeFile(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(join(target, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`);

  const manifest = {
    name: variant.name,
    version: variant.packageVersion ? `${variant.packageVersion}+codex.20260914` : version,
    description: variant.longDescription,
    author: { name: "LIMITEDRUSH" },
    skills: "./skills/",
    interface: {
      displayName: variant.displayName,
      shortDescription: variant.shortDescription,
      longDescription: variant.longDescription,
      developerName: "LIMITEDRUSH",
      category: "Productivity",
      capabilities: ["Interactive", "Task management", "Local inventory", "Quota monitoring"],
      defaultPrompt: variant.defaultPrompt,
      brandColor: "#D97757",
      composerIcon: "./assets/icon.svg",
      logo: "./assets/logo.svg",
    },
    mcpServers: "./.mcp.json",
  };
  await writeFile(
    join(target, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const mcp = {
    mcpServers: {
      [variant.name.replace("-", "_")]: {
        command: "node",
        args: ["./dist/server.mjs"],
        cwd: ".",
        enabled: true,
        default_tools_approval_mode: "approve",
        env: { SILO_DEFAULT_LOCALE: variant.locale },
        env_vars: [
          "CODEX_CLI_PATH",
          "CODEX_HOME",
          "HOME",
          "USERPROFILE",
          "LOCALAPPDATA",
          "XDG_DATA_HOME",
          "PATH",
        ],
        startup_timeout_sec: 20,
        tool_timeout_sec: 900,
      },
    },
  };
  await writeFile(join(target, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
}
