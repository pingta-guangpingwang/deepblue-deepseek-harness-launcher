# Vendored AI历史书 connector

Source: https://github.com/pingta-guangpingwang/ailishishu (packages/agent-connector).

Authorization follows the upstream project's existing terms. This snapshot adds no license grant and must not be assumed to inherit the launcher's license.
The upstream package metadata currently declares no license field; maintainers must verify the existing authorization before redistributing it. No additional MIT statement is introduced here.

This source snapshot is copied mechanically after connector tests; do not maintain a divergent second implementation. Only src and package metadata are synchronized, excluding private configurations, credentials, node_modules and runtime state. Removed upstream source files are removed from this snapshot on synchronization.

Standalone build: run `npm ci` at the launcher repository root, then `npm run agent-host:build`.
Update: set `AILISHISHU_CONNECTOR_SOURCE` to the reviewed upstream package and run `node scripts/build-agent-host-module.mjs --vendor-from-source`.

Snapshot package: @shenlan/agent-connector@0.10.9
Source SHA-256 (src plus package.json): ce933f91ffd76264774c6478b315fd4a687469f869257ee37a7d3759a9750a92
