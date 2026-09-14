import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function applicationDataRoot(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || homedir();
  if (platform === "win32") {
    return env.LOCALAPPDATA || join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return env.XDG_DATA_HOME || join(home, ".local", "share");
}

export function siloDataPath(filename, options = {}) {
  return join(applicationDataRoot(options), "SILO", filename);
}

export function executableOnPath(command, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.existsFn || existsSync;
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveCodexCommand(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || homedir();
  const exists = options.existsFn || existsSync;
  for (const candidate of [env.CODEX_CLI_PATH, env.CODEX_BIN]) {
    if (candidate && exists(candidate)) return candidate;
  }
  const onPath = executableOnPath("codex", { env, platform, existsFn: exists });
  if (onPath) return onPath;
  if (platform === "darwin") {
    const candidates = [
      join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ];
    const installed = candidates.find((candidate) => exists(candidate));
    if (installed) return installed;
  }
  return "codex";
}
