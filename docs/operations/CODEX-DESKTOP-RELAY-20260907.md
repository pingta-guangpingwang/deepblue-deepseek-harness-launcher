# Codex 桌面原对话桥接：本机验收记录

日期：2026-09-07。范围：本机实现、覆盖、验收及两个模块的公网热更新发布。

## 22:09 公网发布与实际启动器检查

- 修复源码 `cac5648` 已推送 GitHub 的 `codex/launcher-agent-host` 分支；本次未合并 main。
- agent-host `1.0.0+f979af8c34c9`（121619 字节）、launcher-ui `ui-be272626e5dc477d`（249568 字节）已上传 OSS 公共读与 GitHub Releases，并分别通过匿名完整下载和 SHA-256 校验。
- 生产清单 `release-v2/launcher-manifest.json` 已使用指纹匹配的 `runtime-production-v2-1` 密钥签名、最后切换并回下载验签；基础 EXE 仍为 0.10.34，安装器链接及其清单内容未改动。仅保留已验证的 OSS/GitHub 镜像，没有加入未经验证的 Gitee 链接。
- 实际安装版点击“检查更新”后，在线目录与本机两个修复模块一致，显示 0 可更新、5 无需更新、0 手动处理，不再推荐旧模块。截图：`output/playwright/online-hotfix-update-check.png`。
- 发布记录与切换前备份：`release/hotfix-f979af8c34c9/PUBLICATION-VERIFIED.json`、`before.json`。全套回归 189 通过、1 跳过。
- 本轮没有从空白目录重做公网全新安装；本机桌面 companion 已单独更新，但其他用户的 companion 自动配置/升级仍未完成，不能将模块发布等同于所有电脑已自动接通原生桌面桥接。

以下未发布描述为当时的历史状态，由本节覆盖。

## 20:41 本机复测与修复（覆盖下文早期验收边界）

用户反馈复现属实。早期只测专用短对话，没有覆盖当前长工作对话。

- 当前总控对话 `019f740b-5b47-7523-872e-39aad3056717` 在发送前调用原生 `read_thread`，约 15.7 秒失败，尚未进入发送。改为只读原生 SQLite 精确索引和最多 512 KiB JSONL 尾部，响应控制在 192 KiB；本机只读探测约 1.03 秒。
- SQLite 的 Windows `\\?\` 路径导致与普通项目路径比较失败；统一命名空间路径后校验，不放松项目隔离。
- 自动目录刷新不再清除发送错误。同项目其他对话不会被无关任务锁死。
- 同一正在执行的 turn 接收注入消息后可跟踪；排除发送前旧消息 ID，保存已匹配 turn，避免把旧的相同文本当成完成，或消息滚出读取尾部后丢失跟踪。
- 模型下拉框提供“刷新模型”，聚焦时读取本机目录。不同 Codex 进程会覆盖同一缓存：合并本次启动已观察到的可见模型，并补入当前原生会话实际使用的模型。不是硬编码模型清单，也不声称接通所有平台的实时 model/list。

真实界面验收：

1. 安装版启动器向当前正在执行的总控原对话发送 `SAME_WINDOW_20260907_02`，该消息实际进入当前 Codex 上下文；启动器原生历史出现消息，状态从已送达到执行中。不创建新任务，不抢 writer lock。
2. 已有空闲测试对话选择 `gpt-6-astra`，实际返回 `ASTRA_MODEL_AND_REPLY_OK_20260907`，启动器显示完成。
3. 最终模块覆盖、启动器重启后，Astra 等 7 个可见模型、两条新测试记录与已完成回复均保留。
4. 类型检查、33 项相关测试、diff 检查通过。当前总控测试的完成状态要在本轮真正结束后才会出现，不能提前报告完成。

最终本机：agent-host `1.0.0+f979af8c34c9`；launcher-ui `ui-be272626e5dc477d`；基础 EXE 仍 0.10.34。备份 `backups/local-agent-preview-20260907-204103`。

证据：`output/playwright/actual-user-thread-report.json`、`current-thread-delivered-astra.png`、`current-thread-after-restart.png`、`astra-roundtrip-attempt.json`。截图是实际安装的启动器，不是 Codex 原生窗口截图；Codex 收件证据为当前任务实际收到的原生转发消息。没有完成手机公网全链路和 Codex 全进程重启验收，也没有发布 GitHub/OSS；不要把线上旧模块覆盖本机修复版。

## 已实现

- 已存在的 Codex 会话通过本机 companion 调用桌面的 `codex_app.send_message_to_thread`，不再另开 CLI/app-server 恢复该会话。
- 保留项目和原对话 ID，发送前以真实路径再次核对项目归属，包括 Windows 短路径；不新建替代会话，不移除 writer lock。
- 桌面返回确认只代表“已送达”。任务完成需匹配原生 turn、请求文本和 completed 状态。部分桌面版本不返回 delegated turn items 时，只读读取该会话原生 JSONL 的末尾，补齐本轮文本。
- 本机桥接只监听随机 Windows named pipe，使用随机令牌校验；私有配置目录仅当前 Windows 用户和 SYSTEM 可访问。令牌不进入仓库或发布包。
- 请求编号写入本机去重凭据后才发送；不确定的投递不会自动重试。任务状态沿用启动器已有系统加密持久化，启动器重启后恢复。
- 网站 Connector 的继续原会话入口也已接到相同通道，不再等待桌面释放原对话。保留登录、设备和项目白名单，不修改生产 API。
- 原生桥接模块随 agent-host 构建；本机 Codex 已注册 `shenlan-desktop-relay` MCP，同时为当前正在运行的 Codex 激活了 companion，无需中断当前工作。

## 实际安装

- 启动器基础版本：0.10.34，未替换 EXE。
- agent-host：`1.0.0+5ec41591433d`。
- launcher-ui：`ui-148d5ac698c0fc13`。
- 当前回滚备份：`C:/Users/Administrator/AppData/Roaming/deepseek-harness-launcher/backups/local-agent-preview-20260907-163206`。
- 桥接安装脚本：`scripts/install-codex-desktop-relay.ps1`。当前执行上下文使用此前已有的独立连通性测试会话，不用于普通目标会话。

## 验收证据

目标一直是已有测试对话 `01a07a0e-d5da-7831-8801-2f5eeff6c097`，已在 Codex 桌面打开，扫描确认 `native_owned`。

1. 实际安装版窗口中点击“发送到桌面原对话”，得到 `DESKTOP_SAME_THREAD_OK_20260907_V2`；任务转为 completed，原生 thread ID 未变。
2. 重发同一请求编号只返回原回执，原对话 turn ID 未增加。
3. 重启本机启动器后恢复原任务状态及回复，没有重新发送。
4. 通过 Connector 的 `runRuntimeTask` 入口，得到 `REMOTE_SAME_THREAD_OK_20260907`；再次以相同远程任务编号执行，只读恢复原结果，没有第二次模型执行。
5. 类型检查通过；启动器相关单元测试 28 项通过，Connector 相关专项测试 14 项通过，模块边界与差异空白检查通过。

证据目录：`output/playwright/native-desktop-relay/`，包括 `report.json`、`remote-runner-report.json`、`installed-same-thread.png`。脚本有一次性发消息保护，复核界面应设置 `QA_CHECK_ONLY=1`，不要删除 attempt 文件来自动重试。

## 未宣称完成的范围

- 没有实测手机经生产网站到本机的完整往返，没有推送 GitHub 或 OSS 下载包。
- Codex 重启后通过 MCP 自动拉起 companion 的配置已注册，但本轮没有重启 Codex 做独立验收，以免中断其他工作；本轮实测的是已激活 companion 和启动器重启恢复。
- 原生接口属于内部协议，版本变动时必须重新探测；不可用时保留草稿，不回退抢占式 CLI。
- 当前桥接执行上下文不能作为发送目标。通用安装仍需独立有效执行上下文的自动配置流程。
- 远程只读沙箱不能直接映射为桌面原生权限，因此明确拒绝，不静默升级权限。
- 远程临时附件尚未接通持久化，明确拒绝该类请求；本机选取附件仅以本机文件路径交给原对话。
- 远程停止原生任务尚未接通，界面/接口提示需在 Codex 停止，不会把停止观察报告成任务已停止。
- 向正在执行中的原生 turn 插入消息、跨多个同时活跃窗口的压力测试尚未完成；本轮验收为已打开且空闲的原对话继续执行。
- 旧线上清单仍可能推荐旧模块；本机预览期间不要用线上旧模块覆盖本次版本。

## 参考

协议研究参考 `https://github.com/buidangminh23/codex-mcp-bridge/issues/23` 和该项目 native relay 源码。此处为独立实现，没有运行第三方安装脚本，也没有修改 Codex 二进制或绕过其对等进程身份检查。
