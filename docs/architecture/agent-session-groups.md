# 多智能会话房间：Launcher v2 合同

2026-09-09。状态：本地界面与传输候选，使用合成数据验收；尚未连接生产 API、真实智能体或公开发布。

## 用户心智

用户创建并命名一个房间，为每位成员设置房间内身份、唯一 `@名称`、职责、已有智能体和已授权项目。界面不把产品描述成“双智能”，也不展示固定参与数量、手动/主控模式或最大步数控件。

- 未 `@` 任何成员的公开消息交给房间主控。主控理解目标、分派、收集成员公开汇报并持续推进，直到产出公开结论。
- 通过建议列表选中的 `@成员` 直接收到本条任务；没有被结构化提及的成员保持安静。
- 所有成员共享房间公共聊天记录。每位成员的本机工作记忆和房间专属原生会话彼此独立，不能把内部思考、凭据或完整私人历史复制到公共聊天。
- 编辑器只选择已有智能体和已授权项目，不选择旧原生会话。服务端在该成员首次参与时按需创建专属原生会话；`pending` 表示“尚未创建”，不是“正在创建”。
- 成员离线时消息仍先进入公共聊天，任务动态标记“等待连接”；连接恢复后再领取，不用假成功或阻塞用户继续说话。

## Launcher 布局

桌面固定为“房间列表｜任务动态｜公共聊天”。成员身份、项目、专属会话状态和房间编辑收进右侧成员面板。

- 房间列表是工作台内的二级导航，不显示成员数字。
- 任务动态明确展示“谁分派给谁”、排队、等待连接、执行、汇报、失败、取消和完成；不展示主控内部 `DELEGATE` / `FINISH` 协议文本。
- 公共聊天是主工作区。发送器在已有 run 执行、等待连接或结果待确认时仍可编辑和发送，新消息由服务端安全排队。
- 输入 `@` 打开可键盘操作的 combobox。只有从建议列表选中的 token 才序列化为 `{type:'mention',memberId}`；手工键入同名文字仍是普通 text，不能靠正则重新识别身份。
- 路由预览固定显示“未 @，将交给 @主控名”或“将通知 @成员名”。
- 手机默认打开“聊天”，用 44px 以上的“聊天｜任务动态｜成员”切页；当前房间使用独立选择器，输入区保持在视口内。

## v2 HTTP 合同

基础启动器继续通过 `agentWorkspaceRequest` 访问统一 Bearer 鉴权的 Agent Hub。仅使用新命名空间，不降级调用 `group_*`：

- `GET room_list`：返回 `{contractVersion:2, rooms, candidates:{agents,projects,truncated,limits:{candidateAgents,projects,maxMembers}}}`。成员上限只用于禁用“添加成员”并给出文字原因，不在主界面展示数字。
- `GET room_detail`：查询参数为 `roomId`，以及可选的 `afterRevision` 与一个消息方向游标；`afterMessageSeq`、`beforeMessageSeq` 不得同时出现。`detailRevision` 是 64 位十六进制哈希；房间 `definitionRevision/stateRevision` 是数字。
- `POST room_create`：`{clientRequestId,name,coordinatorMemberId,maxSteps,defaultAccess:"workspace_write",members}`。
- `POST room_update`：在创建字段之外增加 `{roomId,expectedDefinitionRevision}`。
- `POST room_delete`：`{roomId,clientRequestId}`。它会立即永久清理公共聊天、任务正文与结果、成员名称、职责和会话标签且无法恢复；不会删除智能体、授权项目、本地文件或原生会话。确认层必须在请求前逐项说明，网络结果不明时按房间复用同一请求编号。
- `POST room_send`：`{roomId,clientRequestId,expectedDefinitionRevision,content,replyToMessageId?,access:"workspace_write"}`。`content` 仅含 `{type:'text',text}` 或 `{type:'mention',memberId}`。
- `POST room_approve`：`{roomId,runId,approvalId}`；不能随批准请求改写正文、成员、项目或权限。
- `POST room_cancel`：`{roomId,runId}`。

成员写入字段为 `{id,displayName,mentionHandle,responsibility,agentId,projectId,sessionLabel}`。`mentionHandle` 使用服务端相同的 Unicode 字母、数字、下划线、句点和短横线合同，最多 40 个字符。读取字段另含 `nativeSessionId|null`、`sessionState`、`runtimeStatus`、`canDispatch`、`dispatchErrorCode`、`readinessSource` 和 `statusMessage`。

消息的 `mentions` 是 `{memberId,displayName,mentionHandle}` 对象数组；正文渲染仍以 `segments` 的稳定 `memberId` 为准。详情窗口分别声明 `hasEarlierMessages` 和 `hasLaterMessages`：前者只控制“加载更早消息”，后者使用 `afterMessageSeq` 分批追上新消息，不能混成一个 `hasMore`。

房间、run 和发送回执采用严格解析，不把字符串数字转成版本、不截断越界 `maxSteps`，也不把其他权限或批准策略强制改写为安全值后继续显示。房间固定为 `contractVersion=2 + status=active + defaultAccess=workspace_write + approvalPolicy=bounded_run`；run 的房间、主控、定义版本、步数和成员范围必须与当前房间一致。详情窗口精确读取 `actionCount/hasMoreActions`，服务端以 `LIMIT 101` 区分完整的 100 条窗口与更多记录。

## 执行与批准

首发仅允许 `workspace_write`，不提供或暗示当前运行时无法一致强制的 `read_only` 模式。内部安全步数由服务端和客户端合同共同限制，但主界面不向用户暴露编排参数。每个新 run 都必须先显示并完成一次整项批准：

1. 发送成功后，公共消息已经落入房间，但批准前没有真实智能体任务。回执必须精确包含 `contractVersion=2`、`status=awaiting_approval`、`requiresApproval=true`，以及 32 位小写十六进制 `messageId/runId/approvalId`；任一项错误都保留草稿并 fail closed。
2. 批准冻结本 run 的房间定义版本、成员、项目、原始消息、权限和内部步数上限。
3. 这次批准只覆盖各成员在已授权项目中的工作。发布、发送、破坏性删除、扩大范围或读取凭据必须停下并另行询问；各本机运行时权限仍是最终技术边界。
4. 主控后续委派不再逐条打断用户，但每次分派和成员汇报都进入左侧任务动态与右侧公共聊天。

`reserved` 表示离线成员的动作已预留但尚未派发，Launcher 显示“等待连接”。`unknown` 继续占用执行状态并允许取消对账，不能被解释成完成。

## 版本与安全门禁

- `0.10.34` 及更旧基础内核必须在任何 `room_*` 请求前 fail closed；多智能会话最低基础版本仍为 `0.10.35`。
- 房间切换时，旧房间延迟返回的详情、消息窗口、发送、批准或取消响应不得写入新房间；发送和删除的结果不明请求编号按“房间 + 规范负载”保留，切换返回后仍复用。
- 任一 mutating 请求在途时，发送器正文仍可编辑，但不能并发提交。旧消息确认成功时，只清理仍与已发送内容相同的草稿，绝不能删除用户在等待期间输入的新文字。
- 取消界面采用服务端真实回执状态；幂等重放若已经是 `cancelled/completed/failed/unknown`，必须显示该终态或不确定态，不能一律写成 `cancel_requested`。
- 合成 fixture 必须显式标注，不得把 UI 结果冒充真实多智能联调。正式发布还需要真实账号、真实多成员、同智能体多专属会话、断网恢复、审批、取消、分页、权限和安装版验收。

## 本地验收入口

在本地启动 Vite 后运行：

```powershell
npm run dev:web -- --host 127.0.0.1 --port 4316
node scripts/qa-agent-workspace.mjs
```

报告和桌面/390px 截图写入 `output/playwright/agent-workspace-room-v2/`，并标记 `fixtureOnly: true`。
