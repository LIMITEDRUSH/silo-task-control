# SILO Task Control

SILO is a local Codex plugin for scanning existing Codex tasks across projects, choosing **Continue** or **Optimize** per task, and dispatching a confirmed batch through Codex's native task tools.

Current release: **v0.2.1** (`0.2.1+codex.20260913`)

## Install from GitHub

SILO is distributed as a Codex repository marketplace. Add the GitHub repository, then install the plugin:

```powershell
codex plugin marketplace add LIMITEDRUSH/silo-task-control
codex plugin add silo-task-control@silo-plugins
```

Restart Codex after the first installation, then open **SILO** from the sidebar or start a new task and ask:

```text
$silo-task-control 打开控制面板，扫描我现在的任务
```

To update later:

```powershell
codex plugin marketplace upgrade silo-plugins
```

SILO currently targets Windows and requires Codex Desktop plus Node.js 22.5 or newer. The plugin reads local Codex task metadata and can send reviewed follow-up prompts only after explicit launch confirmation.

## What it contains

- A read-only local inventory bridge over `codex app-server` with SQLite fallback, merged with Codex Desktop's native task snapshot.
- MCP tools for scanning, diagnostics, short-lived plan preparation, and plan retrieval.
- A compact task ledger with **All / To do / Completed** views, global search, folder grouping, a persistent command inspector, exact prompt review, explicit launch confirmation, and a live activity rail.
- Keyboard-first navigation: `/` focuses search, arrow keys move through visible tasks, `X` toggles batch selection, `Space` opens the task inspector, and `Esc` clears the batch without deleting drafts.
- One-click **Smart Select** that reads at most the latest two turns of recent candidates and recommends **Continue** for interrupted or clearly unfinished work and **Optimize** for completed project work that warrants a quality pass. Recommendations only select tasks; users still review and press Launch.
- A Codex skill that exact-reads selected tasks for context and live preflight, then converts one confirmed Launch plan into native `send_message_to_thread` calls.
- A lightweight Windows desktop shell that reuses the same inventory and planning core, resumes confirmed tasks through the supported `codex exec resume` command, and tracks each launched child process.
- A quota and reset monitor plus a desktop STOP control scoped strictly to tasks launched by that SILO desktop process.

The embedded plugin panel sends a visible follow-up message that invokes the skill's native dispatch flow and immediately shows a timestamped “Codex 对话已显示消息” receipt after the host accepts it. Codex's own task tools then re-read exact targets immediately before sending. The standalone desktop cannot observe another Codex process's live runtime state, so unloaded tasks are labeled “启动时复核”; `codex exec resume` performs the final atomic ownership check and reports conflicts in the activity rail.

The embedded panel first renders immediately, then asks Codex Desktop for its native task list and merges active, waiting, and idle states into the local inventory. A recent native snapshot is retained for ten minutes so the external panel and background refreshes do not immediately lose the authoritative running state.

Selections are never silently hidden: changing filters shows an exact hidden-selection count and a “查看已选” recovery action. A failed refresh marks the previous inventory stale and disables Launch until a fresh scan succeeds. Desktop activity is journaled locally so a service restart preserves the last known outcome instead of presenting an empty rail.

## Windows desktop app

Choose “外置窗口” in the Codex panel, or double-click `desktop\Start SILO.cmd`. The launcher locates the Node and Codex runtimes bundled with the Codex desktop app, starts a loopback-only local service, and opens SILO in an Edge application window. It does not require `codex` to be present in the user's global PowerShell `PATH`. Keep the panel or desktop window open while quota monitoring is armed.

## Use

Start a new Codex task after installation, then say:

```text
$silo-task-control 打开控制面板，扫描我现在的任务
```

In the panel, use the four views to inspect current work. Click **推荐下一步** to analyze recent context and append recommended tasks without overwriting the current batch or drafts. Review each Continue/Optimize instruction and per-task model settings on the right, then press **启动任务**. Clicking **刷新** requests a fresh Codex-native state sync.

Without MCP Apps UI, ask SILO to scan and show a conversational checklist; the same MCP tools and dispatch workflow remain available.

## Codex sidebar entry (preview)

SILO advertises its existing MCP App as a global entry point. Codex Desktop builds that entry into its sidebar catalog, so after installing or updating the plugin, restart Codex and open **SILO** directly from the sidebar. This does not patch Codex, inject browser code, or modify `app.asar`; removing the plugin (or reverting the `openai/ui` metadata on `render_task_control_panel`) removes the entry.

The global-entry metadata is recognized by current Codex Desktop builds but is not yet documented as a public plugin API. After every Codex Desktop upgrade, run:

```powershell
npm run sidebar-doctor
```

The doctor performs a read-only check of the installed Codex package and this plugin. If the host markers disappear, leave SILO conversationally accessible and investigate compatibility before considering any CDP-based fallback. Do not patch the installed Codex ASAR.

## Development

```powershell
npm install
npm run check
```

The bundled MCP server is `dist/server.mjs`. The plugin requires Node.js 22.5 or newer for SQLite fallback; the primary scan path uses the Codex app server.

## Safety model

- Scans and plan creation are read-only.
- Plans expire after 15 minutes and contain only previously scanned task IDs.
- The panel cannot silently dispatch: it requires an explicit confirmation dialog and sends a visible follow-up message.
- Edited prompts are stored only in the reviewed short-lived plan and are sent exactly as shown.
- The standalone desktop STOP action requires typing `STOP` and affects only tasks launched by that desktop process; the one-shot quota monitor uses the same scope.
- Every selected task is read again through the native Codex task API immediately before dispatch.
- Native dispatch skips active or attention-blocked tasks and never creates, forks, archives, renames, or interrupts tasks.

## License

MIT
