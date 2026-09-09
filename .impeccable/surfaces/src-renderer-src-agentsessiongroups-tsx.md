---
version: 1
slug: "src-renderer-src-agentsessiongroups-tsx"
primary_target: "src/renderer/src/AgentSessionGroups.tsx"
related_targets: ["src/renderer/src/AgentWorkspacePage.tsx"]
---

# Multi-agent room workspace

- Scope: `AgentSessionGroups.tsx`, its room styles, and the `AgentWorkspacePage.tsx` entry tab.
- Visitor mode: Operate.
- Audience: signed-in Windows users coordinating several existing local agents without learning orchestration syntax.
- Job: name a room, assign room identities to existing agents and authorized projects, then speak in one public chat while the task ledger proves who assigned what and whether it finished.
- Primary action: send a public room message; no structured mention routes to the named coordinator, while a suggestion-selected mention routes to that stable member ID.
- Proof and content: public transcript, who-to-whom task ledger, whole-run approval, offline queue state, lazy dedicated-session state, and truthful synthetic QA labeling.
- Constraints: inherit the established flat white/light-gray/DeepSeek-blue operator world; public chat stays largest; member configuration stays in a drawer/editor; no visible participant count, manual/coordinator mode, or maximum-step control; first release is workspace-write-only and every run requires one whole-run approval; malformed v2 scope fails closed; destructive room deletion must disclose every permanently scrubbed text/identity field before the request; 0.10.34 fails closed before any room request.
- Direction: desktop uses a secondary room rail, persistent task ledger, and dominant public chat. Mobile opens Chat and replaces it with Tasks or Members through accessible 44px view controls.
- Memorable moment: typing `@` opens a compact identity list; selecting a member creates a visible route preview while the serialized request keeps only the member's stable ID.
- Unresolved outside this surface: production API deployment, real multi-agent execution, real dedicated-session isolation, and signed public release.
- Method note: this was a precisely specified local extension inside an established visual world, so concept-seed, FORM seed key, QUALITY BAR card, and approved concept composition are not applicable.
