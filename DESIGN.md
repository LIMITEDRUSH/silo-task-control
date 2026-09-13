# SILO 0.2 interface direction

SILO is a control surface, not a reporting dashboard. Its primary job is to move from a large Codex task inventory to a small, reviewed batch with minimal uncertainty.

## Interaction model

1. Find work with views or global search.
2. Click a task title to inspect it without changing the batch.
3. Use the checkbox or `X` to add or remove it.
4. Review mode, model, effort, Burn, and the exact outgoing prompt in the command inspector.
5. Review the complete batch once, then launch.
6. Follow progress in the Run tab.

Drafts are keyed by task and mode. Removing a task, clearing the batch, or switching between Continue and Optimize does not erase prior text.

## Visual system

- Canvas: `#fbfbfa`
- Quiet surface: `#f4f4f1`
- Ink: `#1d1d1b`
- Secondary text: `#666761`
- Borders: `#dfdfda`
- Batch signal: `#b64e32`

The interface is deliberately flat and dense. Borders encode structure; the terracotta signal is reserved for selected batch state and the final launch action.

## Reference patterns

- Linear list selection: checkboxes change selection while the item title opens details; bulk actions live outside each row. <https://linear.app/docs/select-issues>
- Linear search and peek: `/` focuses search and a lightweight preview keeps the user in the list context. <https://linear.app/docs/search> and <https://linear.app/docs/peek>
- Raycast keyboard navigation: arrow-key list navigation and a small set of discoverable shortcuts reduce pointer travel. <https://manual.raycast.com/keyboard-shortcuts>
- GitHub Actions concurrency: concurrency belongs to the batch/run level because it controls shared execution capacity. <https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency>
- Codex app: SILO uses the same task, project, worktree, and long-running-agent vocabulary as its host. <https://openai.com/index/introducing-the-codex-app/>

## Responsive behavior

- Above 980px: task ledger and 400px command inspector appear side by side.
- 761–980px: the inspector narrows and task metadata collapses to two rows.
- 760px and below: inventory and inspector become one vertical work surface; opening a task scrolls the inspector into view and the launch bar remains reachable.

## Verification

- 44 Node tests pass.
- Static UI contract check passes.
- Server bundle builds successfully.
- Desktop smoke test passes.
- Browser checks cover view-only task opening, selection, prompt readiness, mode-specific draft retention, re-selection draft retention, model/effort constraints, launch review, and a 420px host surface.
