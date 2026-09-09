# 智能体会话群：复用原实例的协作层

2026-09-08。状态：方案已核实，尚未接入生产；先完成五适配器网页远程验收。

## 参考项目与取舍

下列星标为当天 GitHub 页面显示的约数，不代表性能或本产品验收结果。

| 项目 | 星标约数 | 参考 | 本项目取舍 |
| --- | --- | --- | --- |
| [AutoGen](https://github.com/microsoft/autogen) | 60.9k | [SelectorGroupChat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html) 的角色、候选发言人和终止条件 | 借鉴显式角色选择与轮数上限；不引入整套 Python 运行时。官方现已标为维护模式，不作为新核心依赖。代码 MIT，文档另有 CC-BY-4.0。 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | 58.2k | [顺序与分层协作](https://docs.crewai.com/en/concepts/processes)：主控规划、委派、检查结果 | 提供“我来指挥”和“主控协调”两种运行方式。复用用户已有智能体，不另外购买一个主控 API。MIT。 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 41.2k | [持久化](https://docs.langchain.com/oss/python/langgraph/persistence) 将单次会话检查点和跨会话资料分开 | 将群编排状态和智能体原生会话分开保存；中断恢复先对账，不重复执行已提交任务。MIT。 |

以上只参考协议与产品设计，没有复制第三方实现或界面。

## 产品边界

- 当前开放 Codex、Claude Code、QClaw、WorkBuddy、CodeBuddy。TRAE 原窗口接口明确拒绝当前账号，显示暂不支持，禁止降级到未验证的前台模拟发送。
- 工作台新增“会话群”页签，沿用现有三栏：群列表 → 成员与角色 → 消息和任务进度。手机上逐层进入，输入区固定，不再叠加长页面。
- 创建群：名称、2–6 个角色、每个角色对应已绑定智能体及已授权项目、职责；同一智能体可以担任不同角色，但必须映射不同的原生会话。
- 群成员必须属于同一登录用户。添加角色不自动新增目录授权，也不自动启动智能体。离线或未登录成员明确提示需要启动/本机登录。
- 默认“我来指挥”：点选一个或多个角色发送任务；选择多个角色意味着允许将这条群内任务和明确附带的上下文传给这些角色。
- 可选“主控协调”：选择现有角色作为主控，预览参与成员、授权项目与最大执行轮数后开始；主控不能添加新成员或扩大权限。由于现有智能体没有可强制验证的只读模式，主控生成的每一次委派都必须先展示目标角色、项目、原生会话和完整任务，由用户点“允许委派”后才能创建真实任务。
- 模型默认沿用对应原生会话模型；群不会静默改模型。历史私聊不会自动整段复制到群内。

## 执行与恢复协议

1. 服务端统一鉴权，复用 agent-hub 的用户、设备、项目、任务、附件与取消机制，不创建另一套账号或钱包。
2. 群成员记录 `roleId → agentId + projectId + nativeSessionId`。首条任务先预留角色会话槽；拿到原生 sessionId 后持久化，再接受该角色后续任务。
3. 同项目写入默认串行；现有会话 lane 串行规则继续生效。不同角色不等于允许同时修改同一目录。
4. 每条群消息有稳定 clientRequestId；每次角色调用派生固定任务幂等键。断网重试查原任务，不创建替代任务。
5. 状态明确分为 queued、running、awaiting_approval、unknown、completed、failed、cancel_requested、cancelled。协调者生成的待确认动作另用 `awaiting_user_approval`；用户确认后先进入 `approved`，Worker 再以事务 fence 转为 `dispatching`。仅本机完成回执可标记 completed；进度不能代替结果。
6. 主控回复使用严格结构化动作：`delegate(roleId, instruction)` 或 `finish(summary)`。普通文字不是命令；不合法、越权或超过轮数的委派停止并显示原因。
7. 默认最多 6 次角色调用，用户可在开始前设置 1–12 次；主控规划/汇总也计入上限。限制单次上下文和输出，不允许无界自我对话。
8. 取消先停止后续派发，再对实际已创建任务发送取消；未收到本机停止回执时保持“取消中”。重启后根据任务 ID 对账，不重放已成功任务。
9. 服务器仅保存群元信息、角色映射和必要编排检查点；任务文本遵循现有保留策略。停用群时立即清理运行正文、动作提示/结果、指令载荷和对应远程任务消息，只保留状态、哈希和必要审计；敏感凭证不写入角色提示词。
10. 关闭网页不终止已提交任务；设备低频心跳继续。只有有订阅或活跃任务时同步增量内容。

## 发布前验收

- 五适配器实机收发已有记录；补齐真实登录网页的远程启动、掉线、恢复、角色可执行状态。
- 两个不同智能体完成一次“规划 → 执行 → 复核”，以及同智能体两个角色的会话隔离。
- 双击提交、网络中断/进程重启、未知执行结果、跨用户/跨项目、取消竞态、无效主控命令、达到轮数限制。
- 桌面与手机截图：创建、成员离线、执行中、停止中、失败、完成；验证输入区和关键按钮不被挤出视口。
- 签名发布 agent-host/UI 模块；只有主进程安全合同、IPC 或原生依赖变化时才升级基础安装器。新数据库迁移先登记，禁止修改已发布迁移。

## 2026-09-09 启动器本地 UI 纵向切片

启动器已增加本地“会话群”页签和合成数据验收，仍不代表生产 API 已发布。界面继续使用工作台三栏：群列表、成员与角色、群任务与动作；`390×844` 下按群、成员、任务逐层进入，任务输入区固定在可见区域内。

当前公共基础启动器 `0.10.34` 的主进程请求 allowlist 不认识 `group_*` 和 GET `groupId`，单独热更新 launcher-ui/agent-host 仍会在发网前拒绝请求。本分支把基础版本提升到 `0.10.35`，UI 同时按 `snapshot.launcherVersion >= 0.10.35` 自门禁；这只是界面能力检查，现有模块 metadata 的最低版本声明尚未改为或实现这项门禁，不得宣称模块安装器会替代检查。公开顺序必须是：先完成并验证服务端迁移、API 和受监督 Worker，再发布包含 allowlist 和内置 UI 的 `0.10.35` 基础启动器，最后才更新公共 launcher-ui 热更新清单。

Launcher 通过现有 `agentWorkspaceRequest` 使用以下固定动作：

- `group_list`：GET；返回 `groups`，并优先附带脱敏的 `candidates: { agents, projects, sessions, truncated, limits }`。候选被截断时编辑器明确显示最近条数和同步/刷新指引；只有旧服务完全缺少 candidates 结构时，Launcher 才回退到 `bootstrap + agent_state`。
- `group_detail`：GET，参数 `{ groupId, afterRevision? }`。首次返回有界的 `{ changed: true, detailRevision, group, roles, runs, actions, window }`；版本未变化时只返回 `{ changed: false, detailRevision }`。正文按服务端字符上限截断并明确标记，Launcher 对非运行态轮询退避，避免反复下载大段历史。
- `group_create` / `group_update`：POST；正文 `{ groupId?, name, mode, coordinatorRoleId, maxTurns, roles }`。角色为 `{ id, name, responsibility, agentId, projectId, nativeSessionId }`，其中新角色 ID 是 32 位小写十六进制；群名最多 80 字符，角色名最多 60 字符，职责最多 500 字符。
- `group_delete`：POST，正文 `{ groupId }`；语义为停用并从普通列表移除，同时清理任务正文、角色结果和待派发内容，只保留状态、哈希与必要审计；不删除原生项目、会话或智能体。
- `group_send`：POST，正文 `{ groupId, instruction, targetRoleIds, mode, coordinatorRoleId?, maxTurns, clientRequestId }`；返回 `{ runId, status, replayed }`。模式、主控和 1–12 次上限是本次运行的明确覆盖值；手动模式所选角色数不得超过 maxTurns。
- `group_cancel`：POST，正文 `{ groupId, runId }`；停止后续派发后保持 `cancel_requested`，直到本机回执确认最终状态。
- `group_approve`：POST，正文严格为 `{ groupId, runId, actionId }`；只允许当前用户确认当前 run 中由主控生成且仍为 `awaiting_user_approval` 的单次委派。拒绝不新增动作，复用 `group_cancel` 停止本轮。

同一发送内容在未确认时保留原 `clientRequestId`；发送和创建/更新的连续双击均由本机同步门禁合并，网络重试由服务端幂等记录返回原 run。编辑同一个群后先重新读取 detail，再用服务端返回的 mode、coordinatorRoleId、maxTurns 和角色集合重置发送器及 targetRoleIds，不能沿用编辑前的隐藏选择。候选、发送和 Worker 派发都只把新鲜权威来源报告的 `ready|busy` 视为可执行；普通同步 `online|working`、未知或失效运行时一律 fail closed。协调模式首期要求群内全部参与角色已就绪；手动模式要求所选角色已就绪且人数不超过本次 maxTurns，Launcher 在发网前显示具体原因并禁止无效提交。

worker 返回失败或派发结果无法确认时，run 保持 `unknown`（界面显示“结果待确认”）并继续占用群运行位，用户可发起取消以完成对账，不能直接发送下一条。旧 run 若返回 `contentAvailable: false` 与 `contentPrunedAt`，界面明确显示“正文已按最近 10 次保留策略清理”，不把空正文伪装成普通“群任务”。候选列表与群详情同时兼容 snake_case 和 camelCase，但写请求只使用以上 camelCase 合同。
