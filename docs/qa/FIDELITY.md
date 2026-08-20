# Visual fidelity ledger

Compared assets:

- Concept: `docs/design/dashboard-concept.png`
- Concept: `docs/design/updates-concept.png`
- Implementation: `docs/qa/dashboard-1440.png`
- Implementation: `docs/qa/versions-1440.png`
- Responsive implementation: `docs/qa/dashboard-390.png`

## Comparison points

| Area | Concept target | Implemented result |
| --- | --- | --- |
| Navigation | Dark 224 px rail, seven clearly named sections, status footer | Same hierarchy and selected-state treatment; adds platform string beside launcher version |
| Primary action | One dominant Harness start button and prominent readiness state | Same first-screen priority; button also becomes an explicit stop action while running |
| Configuration | Harness version, port and workspace beside the run card | Same three editable values; configuration-file row was omitted because the launcher does not own model/API credentials |
| Readiness and sources | Two symmetric cards for environment components and GitHub/Gitee/npmmirror/OSS | Same arrangement, real status vocabulary, latency, URL truncation and unconfigured states |
| Operational feedback | Recent task progress and dark terminal log card | Same lower dashboard structure; progress and process output are driven by main-process events |
| Version management | Summary strip, update card, history, source priority and update protection | Same information architecture; update action is disabled when npm reports no newer version and supports a separate signed launcher update banner |
| Responsive behavior | Desktop-native primary design | Adds a 390 px QA layout with drawer navigation and single-column cards; Electron itself keeps a 1040 px minimum window |

## Copy differences

- Concept copy “当前版本” became “Harness 版本” where needed to distinguish Harness, launcher and Node versions.
- “模型目录” explicitly says it updates provider metadata rather than model weights.
- Plugin copy warns that third-party bundles are trusted executable code.
- Update protection names user-data backup, parallel version directories and SHA-256 rather than generic “safe update” claims.

## Intentional visual deviations

- Uses system Chinese fonts only; no Google Fonts or other online asset is required for offline rendering.
- Uses solid blue for the primary action instead of a large gradient.
- Removes decorative banners and imagery to keep the launcher focused on state, progress and recovery.
- The application icon uses the same sail motif as the in-app mark but is generated from a deterministic local source.
