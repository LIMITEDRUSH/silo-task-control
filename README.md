# SILO Task Control

[English](README.md) | [简体中文](README.zh-CN.md)

SILO is a lightweight Codex control panel for scanning existing tasks across projects, reviewing the exact Continue or Optimize prompt for each task, and dispatching a confirmed batch through Codex's native task tools.

Current release: **v0.4.1** (`0.4.1+codex.20260913`)

## Install

Add the GitHub repository as a Codex marketplace, then install SILO:

```powershell
codex plugin marketplace add LIMITEDRUSH/silo-task-control
codex plugin add silo-en@silo-plugins
# Or install the fixed Chinese edition:
codex plugin add silo-cn@silo-plugins
```

Restart Codex after the first installation. Open **SILO** from the sidebar or start a new task and ask:

```text
$silo-task-control Open the control panel and scan my current tasks.
```

Choose exactly one edition during installation: `silo-en` fixes both the panel and generated prompts to English; `silo-cn` fixes both to Simplified Chinese. There is no in-panel language switch, so the interface cannot drift between languages.

Update later with:

```powershell
codex plugin marketplace upgrade silo-plugins
codex plugin add silo-en@silo-plugins
```

SILO currently targets Windows and requires Codex Desktop plus Node.js 22.5 or newer.

## Highlights

- Fast local task inventory with Codex-native running-state synchronization and a SQLite fallback.
- Minimal **All / To do / Completed / Smart select** workflow with global search and project grouping.
- Exact per-task prompt review, Continue/Optimize mode, independent Burn strategy, model and reasoning controls, and explicit launch confirmation.
- A live activity rail backed by durable native jobs, atomic target claims, and progress restoration after the panel or server restarts.
- Lightweight quota polling and reset prediction. Reset information is fetched from the third-party [codex-reset.com](https://codex-reset.com/) service when the panel opens.
- Keyboard navigation: `/` focuses search, arrows move between visible tasks, `X` toggles selection, `Space` opens details, and `Esc` clears the batch without deleting drafts.

## How dispatch works

Opening, scanning, filtering, and Smart select are read-only. Smart select reviews at most the latest two turns of recent candidates and proposes Continue or Optimize without launching anything.

Launch requires an explicit review dialog. SILO persists a short-lived plan, sends a visible follow-up message, re-reads each target through native Codex task tools, skips active or attention-blocked tasks, atomically claims each eligible target, and records progress in the activity rail. It never creates, forks, archives, renames, or interrupts unrelated tasks.

## External Windows panel

Choose **External window** in SILO, or double-click `desktop\Start SILO.cmd`. The launcher uses the Node and Codex runtimes bundled with Codex Desktop, starts a loopback-only service, and opens the same panel in an Edge application window.

## Sidebar entry

SILO advertises its MCP App as a global entry point, allowing compatible Codex Desktop builds to show **SILO** in the sidebar. This metadata is still an undocumented host behavior. After a Codex Desktop upgrade, run:

```powershell
npm run sidebar-doctor
```

The doctor performs a read-only compatibility check. SILO does not patch Codex or modify `app.asar`.

## Development

```powershell
npm install
npm run check
```

The bundled MCP server is `dist/server.mjs`.

## Safety

- Scans and plan creation are read-only.
- Plans expire after 15 minutes and contain only previously scanned task IDs.
- Dispatch requires explicit confirmation and produces a visible Codex message.
- Edited prompts are sent exactly as reviewed; Burn is appended once when enabled.
- Every target is checked again immediately before dispatch.
- The desktop STOP control affects only child tasks launched by that SILO desktop process.

## License

MIT
