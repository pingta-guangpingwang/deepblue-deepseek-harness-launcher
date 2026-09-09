# 智能体连接与会话群实施队列

日期：2026-09-07。主程：019f740b-5b47-7523-872e-39aad3056717。
工作树：launcher-agent-host（启动器）、agent-host-site（网站与 Connector）。

按依赖顺序验收，不以服务器历史 online 字段代替真实执行成功。

| 阶段 | 内容 | 验收条件 | 状态 |
| --- | --- | --- | --- |
| 1 | 首次绑定授权弹窗、清晰跳转 | 未登录/未绑定/已有云端实例均有对应指引；不静默扩大目录权限 | 本地完成，待公共模块验收 |
| 2 | 启动检测、账号/设备/智能体分层状态 | 启动即检测；历史目录不等于可执行；明确启动、登录与错误状态 | 本地完成，待公共模块验收 |
| 3 | 五种实际智能体绑定与启动，TRAE 暂不支持 | 用户于 2026-09-08 回复继续，接受 TRAE 暂不支持；其余五种复用原实例完成真实收发 | 五种通过，TRAE 明确禁用远程执行 |
| 4 | 手机网页远程路径与节流 | 启动器接收命令，真正启动相应运行时；在线/离线/任务完成回传；无人查看保留低频控制心跳 | 部分通过：QClaw 手机收发完成，其余矩阵待补 |
| 5 | 群聊办公开源调研 | 比较成熟高星项目、许可、角色与协作协议，记录来源和取舍 | 已完成 AutoGen、CrewAI、LangGraph 取舍 |
| 6 | 智能体会话群 | 创建群、同智能体多角色独立会话、用户派发、主控委派、限轮数、取消、失败恢复、权限隔离和真实多智能体验收 | 本地安全候选完成；待 MySQL 5.7/PHP 7.4、真实双智能体、签名与公共发布验收 |

初始实机发现：当前登录账号有上述六种云端实例，服务器均显示 online；启动器设备已 online，但 agents 托管数组为空。当前本机扫描仅支持三种适配器。需要区分独立旧连接器与当前启动器的授权关系，不能强行抢占运行中的连接租约。

发布条件：保持签名模块热更新，按实际改动更新组件；真实安装版与公网路径分别记录，不把模拟测试当作实际联网验收。

## 2026-09-08 实机进展（尚未完成总验收）

- Claude Code、CodeBuddy、WorkBuddy、QClaw 的真实单条回复均已取得；QClaw 在用户完成登录后通过。Codex 原生原会话收发在前一轮已通过。以上不是六种智能体全部完成启动器—服务器端到端验收。
- WorkBuddy 修复默认 Gateway 认证导致 HTTP 401；每次进程使用临时认证，不关闭认证。QClaw 增加本机认证网关健康检查和必要启动，登录错误不再伪报在线。四份 Connector 文件已同步到网站工作树源目录。
- 新增 TRAE 本机命名管道扩展，0.1.0 原生投递成功但回复回传失败；0.1.1/0.1.2 尚待窗口重载后的真实收发验收。0.1.2 只提取严格匹配任务/会话的最终 ReplyUser，5 项隔离回归通过，不以历史回复补成功。
- 原实例归属解析 API 已部署，仅更新 agent-device-common.php、agent-devices.php，无迁移。服务器原地备份：/www/backup/agent-binding-20260908-resolve-legacy；网站提交 c77dc98；生产 PHP 语法、174 项权限断言通过，线上两文件哈希与本地完全一致。未将生产源码下载到本地。
- 用户明确允许后，QClaw 复用原实例 f64f9b33d4cc611aab69e702a390247f 关联到本机设备。原目录仅 C:\Users\Administrator\.qclaw\workspace；本机及服务器状态 stopped，autoStart=false。未启动/终止 QClaw 或旧服务任务。
- 用户随后明确允许其余五个原实例和列明的原目录。已通过真实启动器界面逐个关联 Claude Code、WorkBuddy、CodeBuddy、TRAE、Codex；与 QClaw 合计六个，原实例 ID 均保留，逐个检查 status=stopped、autoStart=false。未启动任务或增加目录。TRAE 重载仍待用户完成。
- 本机验收模块：agent-host 1.0.0+bca149c957ba、UI ui-a87cd47dc520a8fd，基础内核 0.10.34 未变。备份目录：AppData/Roaming/deepseek-harness-launcher/backups/local-agent-preview-20260908-115043。
- UI 实测发现并修复：重复点击指引未展开管理区、管理面板挤压聊天。绑定管理与会话现为独立视图，旧独立连接器不再标成本机已就绪。24 项绑定/状态回归、13 项连接器回归通过。
- 安全交接未完成：旧服务有待同步队列，快照空闲并不能保证下一刻不接新任务；已移除强制终止路径。需要完成协作式排空/停用旧自启/保留回执后再启用新托管，不能直接 Stop-Process 抢租约。
- 尚未发布以上启动器模块到公共更新源；尚未开展会话群调研与实现，严格等待连接验收完成。
- TRAE 0.1.2 扩展已通过原生 CLI 安装成功，不强制重载用户窗口。命名管道双方改用 UTF-8 流解码，避免中文跨包损坏；客户端补上断连立即失败、单次完成保护和与最终回复上限相容的大小限制。
- 六实例关联后实际截图：output/playwright/connection-acceptance-20260908/six-agents-bound.jpg。已检查返回会话后的三栏与完整发送区；顶部诚实显示 0/6 已就绪，各原实例显示本机托管/已停止。截图不代表原生收发已全部验收。

## 2026-09-08 13:50 安全交接增量

- 网站 Connector 源和启动器 vendor 同步增加 service-control.mjs。本机随机命名管道，仅持原实例密钥才能通过 HMAC 认证，无网络监听端口。单次交接先暂停轮询和新任务派发，等待运行/准备阶段任务、后台维护与回传结束，保留待回传结果，最后保存状态并返回 SHA-256 回执。
- 交接完成写入旧服务停用标记；新版独立服务自启/手动启动均会拒绝抢回实例。超时或保存失败恢复旧服务，不调用强制结束任务路径。启动器只有收到匹配状态哈希及停用标记才复制状态；已有新状态不会被旧快照覆盖。
- 修复另一个执行门禁缺口：原实现仅把运行状态上报当作可失败的进度，服务端撤销/租约冲突后仍可能执行本机任务。现已要求首次运行确认成功后才进入实际智能体调用。
- 验证：Connector 20 项（包含真实 Windows 管道认证/去重/回执、任务继续运行与磁盘失败回归）；启动器 28 项；TypeScript 和 diff 检查通过。构建产物 agent-host 1.0.0+fe89f090b8ce；尚未替换本机运行模块或公共发布。
- 本机权威状态复查：六个旧 PID 均仍真实运行且命令行匹配原配置；全部没有新版控制通道。运行中命令计数均为 0；Codex 仍有 81 条待同步记录，其余为 0。不能将这个瞬时快照视为可强制终止的充分依据。
- TRAE 探测仍为 ready=true、supportsExistingSession=false，窗口尚未加载已安装的 0.1.2；没有再次发送测试消息。
- 接下来必须处理一次旧服务迁移重启，验证当前任务没有被中止且 81 条待同步记录保留，再逐个启动并完成公网原会话收发。会话群阶段保持未开始。

## 2026-09-08 16:43 用户授权迁移后的实机进展

- 用户明确允许迁移重启后，六个旧同步服务完成一次性迁移。仅暂停并终止经路径、配置、进程句柄和空闲任务状态核验的同步服务，未终止用户智能体应用/运行任务。六个 Startup VBS 移入各原服务 backups/launcher-migration-20260908-*，可恢复；状态备份哈希一致。Codex 的 81 条待同步记录保留，原 app-server PID 36908 未终止。新版本后续使用协作式交接，无需这次迁移工具。
- TRAE 0.1.2 在用户重启后已加载，probe 支持原会话。但是唯一一次真实投递返回 `[send.internal] not supported for current user.`，因此不通过。证据 trae-reply-initial.report.json；不得删除 attempt 文件重试，也不得修改特性开关绕过账号限制。
- 本机当前 agent-host 为 1.0.0+74cd6c2e1da1，UI ui-a87cd47dc520a8fd，基础内核仍为 0.10.34。备份 local-agent-preview-20260908-163730。未发布公共更新源。
- 新增账号级健康检查：QClaw 认证网关、Claude auth status、Codex 桌面 relay；WorkBuddy/CodeBuddy 使用本机临时密码 Gateway 的 provider account status，不拿端口存在冒充账号登录。显式启动时创建网关，空闲停止时清理仅本次拥有的进程树。
- 修复状态耦合：运行检查失败不再让仍存活的同步服务变成 failed 而无法停止；历史任务回执失败不再把有效心跳误报断线。
- 真实启动器→公网任务队列→原生回复→启动器回显：QClaw 新会话、Claude Code 已有会话续聊、WorkBuddy 新会话已通过，有指定 marker 与 JPG 截图。CodeBuddy/Codex 的完整 UI 轮次继续验收中。这不代表六种原窗口收发全部完成。
- 增量回归：Launcher 28、Connector 23（含新增健康检查 3），TypeScript 与 diff 检查通过。会话群阶段仍未开始。

## 2026-09-08 17:04 五适配器端到端结果

- 当前本机模块升级到 agent-host 1.0.0+85b089f4f0e3（备份 local-agent-preview-20260908-165554），内核与 UI 不变；仍未公共发布。
- QClaw、WorkBuddy、CodeBuddy 新会话，Claude Code 已有会话续聊，Codex 桌面原会话续聊均已通过真实启动器→公网服务器→本机运行时→回复回显。截图分别为 qclaw-launcher-roundtrip.jpg、workbuddy-launcher-roundtrip.jpg、codebuddy-launcher-roundtrip.jpg、claude-launcher-resume.jpg、codex-launcher-native-resume.jpg。
- Codex 测试原会话 019fe241-5e67-71c2-a5cf-cf9b30278b33；桌面权威读取核对新 turn 01a0803f-df5a-7583-baba-e6f8d4718af9 completed，最终回复 SHENLAN_LAUNCHER_CODEX_20260908_1700。未另开会话，没有绕开桌面原 writer。
- 修复旧同步队列阻塞：历史 final_reply_conflict、history_session_not_synced 的记录保留，使用持久化指数退避；每轮限制历史维护数量，新任务优先且各原会话仍按 lane 串行。80 条仍待回传记录保留；由 81 到 80 是一次正常同步完成，不是删除丢弃。新任务不会因旧记录卡住。新增退避/不重放回归通过；累计本次 Connector 24 项、Launcher 28 项通过。
- 未完成：TRAE 当前账号的原窗口投递接口拒绝、六适配器全部验收、手机真实浏览器远程唤起验收、群聊调研/实现、公共模块发布。不得将五适配器收发通过写成所有功能完成。

## 2026-09-08 17:59 继续后的增量结果

- 用户接受“TRAE 暂不支持，其余五种继续”。TRAE 保留绑定和记录，启动、重启、发送在真实安装版界面中禁用；托管层拒绝启动，运行任务路由拒绝旧 IDE 模拟发送降级。其他五种任务能力不变。
- 本机已安装 agent-host 1.0.0+27d8950bbf0f / UI ui-1aa5b5d08ad51712，基础内核仍 0.10.34；备份 local-agent-preview-20260908-175650。真实 UI 恢复五种托管连接后，均 online/ready/busy=false，TRAE stopped/unavailable。证据 output/playwright/connection-acceptance-20260908/trae-unavailable.jpg。
- 网站真正生效的逻辑在 apps/agents/agents.js（不是未引用的独立 agent-device-panel.js）。修复“同步在线冒充运行就绪”、完成提示反复覆盖错误、未就绪仍可派发。状态涵盖 ready、unknown、error、needs_login、unavailable；页面缓存版本已更新。
- 网站提交 6371c22；已部署 ailishishu.com 的 /agents 与 /apps/agents 两处映射，备份 /www/backup/agent-runtime-status-20260908-1749。公网两文件 HTTP 200，SHA-256 与本地一致。没有数据库迁移，尚未推送该分支或发布新的公共启动器模块。
- Launcher 增量回归 29 项、Connector 健康与 TRAE 防降级 4 项通过；网站桌面/手机 mock UI 38 项通过，TypeScript/diff 检查通过。这些 mock 项不算真实手机远程验收。
- 五适配器收发已通过后完成 AutoGen/CrewAI/LangGraph 官方项目及文档核实；架构取舍见 docs/architecture/agent-session-groups.md。尚未实现或发布会话群。
- 真实网站浏览器当前未登录，已向用户请求登录绑定启动器的同一账号。不得从启动器提取令牌伪造浏览器登录。网页远程启动/手机响应式真实收发仍待此步骤；不标记总任务完成。

## 2026-09-08 晚间终态补录

- 后续已使用启动器保留的真实统一账号会话打开线上工作台；没有提取或复制令牌。Claude 原会话完成网页发送与回复；Codex、Claude Code、QClaw、WorkBuddy、CodeBuddy 五种均完成网页恢复托管连接。
- QClaw 在 390×844 视口完成发送、回复及刷新持久化；WorkBuddy 完成同尺寸布局检查。其余四种尚缺完整手机发送矩阵，因此阶段 4 仍只算部分通过。
- 网站 401 会话恢复已部署：相同幂等请求只重试一次，并发请求共用同一次刷新；账号切换、刷新失败和第二次 401 均不重放旧写操作。生产备份 `/www/backup/agent-session-recovery-20260908153957`。
- 本轮目标任务最终被安全系统中止，所以上述生产文件尚未提交，新的 agent-host/launcher-ui 也没有进入公共更新源。

## 2026-09-09 本地收口候选（未发布）

- 删除旧 `agent-device-panel.js`、TRAE 原窗口实验扩展、硬编码会话 QA、一次性强制迁移脚本和会读取/转运生产凭据的临时脚本；服务器 `/tmp` 两个 0644 QA 文件也已精确删除并复查不存在。
- 网站侧作为权威 Connector 源升级为 `0.10.6`：修复附件准备过早显示 running、`source=exec` 新版用户会话识别、`.qclaw` 默认目录、QClaw Gateway 冷启动、Gateway 进程回收、动态桌面模块路径验证及本机任务目录越界校验。
- 启动器修复：手动暂停设备在云端移除后重新登记仍保持暂停；连续登出 tick 不重复写加密状态；已迁移实例不再依赖旧目录；普通添加不消费 legacy 凭据；导入 TRAE 时立即显示 unavailable；管理指引 token 被消费后不会在以后每次进入工作台时重开。
- 网站权威源码已通过现有 `--vendor-from-source` 流程机械同步至 launcher vendor；两侧 27 个生产源文件及 `package.json` 语义一致，TRAE 独占实验文件被删除。
- 为内容哈希模块增加确定性换行归一化和 `.gitattributes`；从外部权威源与独立 vendor 两次构建均得到同一 `agent-host 1.0.0+5060df99303d`、同一归档 SHA-256 `88c4ae4c420925debdaa96491361a2cd7f8c2ef4fe1cd7f8fc065f4a06f68ed5`。
- 当前本地 UI 候选为 `launcher-ui ui-9c62edfb1920812c`。真实已安装启动器有五个托管子进程，预览安装器按安全门禁拒绝强制替换；未中断现有智能体，也未把本地候选冒充已安装/已发布。
- 验证：Connector 完整 39/39；Launcher TypeScript 通过、Vitest 210/210（另 1 项按生成物条件跳过）；合成桌面/手机工作台 16/16；隔离 Electron 可读取 38 个项目、89 个会话和 6 个模型，云端写入为 0。

### 仍需完成后才能发布

1. 把网站会话恢复、Connector、启动器后端/UI 与文档按窄提交收口，并合入正确集成基线。
2. 在不打断现有任务的窗口安装候选模块，完成设备首次登记/改名/暂停/移除恢复和 QClaw 网关完全关闭冷启动。
3. 补齐五适配器桌面与手机发送、附件、取消/中断、同会话串行、跨会话并发、断网和重启矩阵；Codex 桌面原对话目前无法真正远程中断，必须保持诚实禁用/说明。
4. Defender、模块签名、OSS/GitHub 匿名回下载、实际安装版更新与回滚全部通过后，最后原子更新 `release-v2/launcher-manifest.json`。

## 2026-09-09 会话群安全复核收口（未发布）

- 网站本地集成提交 `6d34e3c` 增加权威 runtime readiness：Launcher host 需设备、binding、active Connector node 三路同时新鲜，standalone 需 75 秒内真实探测；客户端只信服务端 `canDispatch=true`，同步 `online/working`、旧 Connector、未知/过期状态均不能创建单智能体或会话群任务。
- Connector 升至 `0.10.7`，确定性 tgz 为 78,992 bytes、SHA-256 `c2bd3905fcfb69a071ac442e5134a5214122abc1b5a373ae0290ceb2b7ae5703`。权威源与本 vendor 语义一致；两种来源构建均得到 `agent-host 1.0.0+a3e021d42877`、归档 SHA-256 `7265abb0888360148d817f484f17222692a7973ccd70ac7b2d478f85c20628e0`。
- 主控模式不会先运行再询问：首个主控 action 在 0 task/0 command 状态等待“允许主控开始”；批准只覆盖该主控在本 run/maxTurns 内的规划与汇总，每个跨角色 delegate 仍展示目标项目、原生会话和明确任务并逐次等待“允许委派”。取消可作为拒绝，批准与 Worker 真正插入任务前都会重验 runtime。
- 停用群会立即清理 run/action/task message/command payload 正文，只保留状态、哈希和批准时间等必要审计。详情最多返回 12 个 run、144 个 action，正文有明确截断标记；`afterRevision` 无变化时只返回 revision，空闲轮询逐步退避。
- 本地验证：网站会话群 30/30、Connector 39/39、核心 54 组、Agent 门禁 13 道及既有浏览器 14/14、会话群 Playwright 3/3（另 3 条按视口项目预期跳过）；Launcher 合成桌面/手机工作台 44/44。正式完成仍需隔离 MySQL 5.7/PHP 7.4 事务测试、真实两智能体/同智能体双原生会话、签名回下载和干净机安装验收。
- 发布必须先让 Connector `0.10.7` / 新 `agent-host` 到达受控设备，再执行 077 与启用服务端 fail-closed 门禁；随后才安装 Worker、开放 Web、发布基础 `0.10.35`，最后更新 `launcher-ui` 清单。禁止为兼容旧 Connector 回退到同步在线推断。
