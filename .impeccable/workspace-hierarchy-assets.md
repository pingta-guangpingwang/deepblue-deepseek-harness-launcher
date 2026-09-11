# Workspace hierarchy asset manifest

Reference: `.impeccable/mocks/workspace-hierarchy-a.png` (1588 × 992). Inventory visually compared to the approved mock and checked against PRODUCT.md and DESIGN.md. This manifest is a semantic build handoff; it does not certify the future implementation's visual QA.

## produce

None. The approved view contains operational UI, with no photographic or illustrative role requiring raster production. Never crop the mock into shipping assets.

## direct

None. Existing vector logo reuse is classified below as semantic to keep every visual role in exactly one bucket.

## semantic

| id | implementation | notes | qa_status |
| --- | --- | --- | --- |
| application-shell | Reuse existing app sidebar, header, account footer, window controls and page tabs. CSS owns white surfaces, gray dividers, compact labels and DeepSeek-blue active indicators. Reuse `src/renderer/src/assets/deepseek-logo.svg` unchanged with its intrinsic 50 × 50 viewBox; nearby product name remains DOM text. | Mock is a hierarchy reference, not permission to replace the established shell. Existing logo has dark-mode media styling; verify it stays visible in the actual active theme. No raster composition. | accepted |
| workspace-columns | Implement the inner workbench as a height-constrained CSS grid: device tree, conversation list, chat. At the reference width the inner columns occupy roughly 289 / 259 / 790 px; keep chat flexible and dominant, with `min-width: 0` and independent scroll regions. CSS owns the 1px separators and outer corner clipping. | Preserve access at smaller widths by moving tree/list into togglable panels or progressive views; do not squeeze three columns into unusable narrow strips. Shell follows existing 860px drawer behavior. No new illustrated empty state. | accepted |
| device-agent-project-tree | Build `WorkspaceTree` from nested lists and native disclosure/selection buttons, or a fully keyboard-compliant ARIA tree. Device row contains Monitor, name, actual runtime status; agent row contains existing agent icon/Bot, name, status; expanded projects use Folder with another indent. Use ChevronRight/ChevronDown for expansion. CSS supplies 16–20px incremental indentation, compact row height, pale-blue selected project and a small status dot paired with text. | Sample names and green availability in the mock are not evidence. Derive entries and status from actual discovered data; omit fictional projects. Expansion and selection are separate actions. Long names ellipsize with accessible full text. | accepted |
| conversation-list | Build a heading with live count, labeled new-conversation button and optional existing sort control; use a labeled search input with Search icon. Render actual conversation rows as buttons with title, timestamp and a one-line preview. CSS provides soft selected-row blue, clear two-line hierarchy, ellipsis and its own scroll region. | Empty, loading and failure states remain text with an appropriate Lucide icon and real available action. No fabricated recent conversations. | accepted |
| chat-context | Build a breadcrumb/header from selected device, agent, project and conversation with semantic text, separators and a labeled overflow button only when real actions exist. CSS truncates long path fragments while preserving conversation identity. | The visible hierarchy must match the active conversation's actual context. | accepted |
| message-transcript | Reuse the real message renderer and tool-result components. User text aligns right on a pale-blue surface; assistant name/time and avatar sit left with readable body text. Render code through existing escaped code/pre elements. CSS owns widths, spacing and pale neutral tool-message surfaces. Lucide Bot or a CSS initial avatar substitutes for the mock's decorative letter disc. | Preserve history, streaming, tool output, links and scroll-position behavior. Use actual timestamps. No mock transcript becomes default live data. No produced raster needed. | accepted |
| inline-approval | Place the existing approval component inside the relevant assistant/tool message. Use CircleAlert plus text, restrained warning border/background, a definition list for real command/workdir/reason, and code elements for command/path. Native buttons bind to actual one-time approval/rejection handlers and show disabled/pending/resolved states. | Keep approval inline in the dominant chat. Do not copy `npm test`, demo paths, sample badge or mock approval state into real runtime. Show a demo badge only in an explicitly selected demo. No automatic approval from styling. | accepted |
| composer | Reuse the real composer as the bottom row of the chat grid: attachment button with Paperclip, current-agent selector when supported, labeled textarea, Send button. CSS keeps input visible and transcript independently scrollable, wraps ancillary controls on narrow widths, and preserves focus rings. | Preserve actual keybindings and send-state logic; visible keyboard hint must match implementation. Mock controls that lack real handlers must not ship as enabled actions. | accepted |
| icon-status-system | Use installed `lucide-react` (package declares 0.468.0) for Monitor, Folder, Bot, ChevronRight/Down, RefreshCw, Plus, Search, MoreVertical, Paperclip, Send and CircleAlert. Keep icons 16–20px with consistent stroke weight. Buttons need accessible names; decorative icons are aria-hidden. CSS owns colored status dots and selected fills. | Reuse existing icon choices when equivalent; do not draw agent trademarks or source icons from screenshot pixels. Status uses both text and color. | accepted |

## execution_order

1. No image production or conversion is necessary.
2. Reuse existing shell, logo and Lucide dependency.
3. Build height-constrained columns and responsive panel behavior.
4. Bind device → agent → project tree and conversation list to actual data.
5. Compose existing transcript, inline approval and composer inside the dominant chat column.
6. Visually compare the real rendered view at reference and minimum window sizes; verify keyboard access, long paths and real empty/error/loading states.

## blockers

None for asset production. Runtime support is an implementation verification responsibility: a mock availability label or actionable control is never proof of a supported integration.

## assumptions

- The parent-approved choice is the hierarchy and spatial allocation shown in mock A.
- Existing flat white/gray/DeepSeek-blue tokens and brand source remain authoritative; mock gradient/shadow artifacts are not new design tokens.
- Every UI word, status and interaction is semantic code. All screenshot regions are reference material only.
- The only new file in this pass is this manifest; no implementation code or approved mock was edited.
