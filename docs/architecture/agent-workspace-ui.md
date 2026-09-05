# Native agent workspace

Scope: the launcher's **智能体工作台** is an Operate surface, extending the current DeepSeek-blue desktop design. It does not embed or open a remote webpage. It uses the AI历史书 account and the website's existing agent, project, session and task IDs.

## Layout and status

- Desktop: fixed three panes for agents, authorized projects/native sessions, and conversation. Only the lists and conversation scroll.
- Narrow windows: three explicit pane tabs keep one pane fully usable. The composer stays within the conversation pane.
- Device connection, local runtime readiness, and task status are independent. A connected computer does not imply the agent is authenticated or ready.
- Local management exposes discovery, one-time account binding, selected-directory authorization, start/stop/restart, pause/resume and explicit removal/remote-access revocation.
- DSH stays on the existing launcher home. This surface does not claim a DSH adapter is implemented.

## Native API boundary

The optional `agentHostState`, `agentHostAction`, and `agentWorkspaceRequest` IPC methods are required. Missing methods show a real upgrade instruction and the permanent download page, never a demo transport or simulated success.

Hub reads use `bootstrap`, `agent_state`, and `session_history`. Writes use `activate_sync`, `request_sync`, `request_session_history`, `send_task`, and `cancel_task`. The renderer never receives connector/device keys, executable paths, or arbitrary shell commands. Adding an agent or project delegates directory selection to the main process.

## Sync and reliability

Polling is limited to the mounted workspace, pauses while the document is hidden, and runs at a four-second cadence after each completed cycle. A shared in-flight guard prevents overlapping cycles; generation and account guards discard stale results. Enter sends, Shift+Enter inserts a newline, and IME confirmation does not send.

Task retries reuse the same client request ID for unchanged content and selection. An acknowledged task remains visible until it appears in a subsequent website snapshot. Native conversations remain authoritative on the user's computer; only the website's existing recent-message retention is shown. Selecting a new native session scrolls to latest. Further updates scroll only when the reader was already at the bottom; otherwise a new-content control appears without moving the viewport.

Power limitations are explicit: a sleeping/offline computer or a fully exited launcher cannot receive remote start commands. Native permission approvals remain on the agent's own local interface; the renderer cannot silently approve them.

## Verification

Targeted unit tests cover website field/ID normalization, history-role filtering, chronological order, native/task deduplication, scroll behavior and IME-safe sending. Browser fixtures are UI-only verification and must not be described as authenticated production or real-agent end-to-end testing.
