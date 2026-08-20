# Code signing policy

## 目标与当前状态

深蓝DeepSeekHarness启动器是 MIT 许可的公开开源项目。Windows 正式安装器计划使用 SignPath Foundation 提供的开源代码签名：**Free code signing provided by SignPath.io, certificate by SignPath Foundation**。

在 SignPath Foundation 审核通过并完成首个签名发布前，下载页必须明确标注“未知发布者”，不得声称已有 Authenticode 签名。仓库自己的 Ed25519 签名只保护远程目录和模块摘要，不代表 Windows 发布者身份。

## 来源与构建

- 唯一源码仓库：<https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher>
- 只接受 GitHub 托管 Windows runner 从公开提交构建的签名请求。
- 正式签名只允许 `main` 上的版本提交，并要求测试、类型检查和签名就绪门禁全部通过。
- 未签名制品先上传为 GitHub Actions artifact，再由 SignPath 的 GitHub trusted build system 验证来源。
- 签名后的文件必须重新验证 Authenticode、产品名、版本、SHA-256 和安装冒烟；任何失败都阻止发布。
- 正式发布仍需维护者人工批准，签名服务或自动化不得直接覆盖稳定下载地址。

## 角色

- Committer / reviewer：[仓库维护者 pingta-guangpingwang](https://github.com/pingta-guangpingwang)，负责代码审查和合并。
- Approver：[仓库所有者 pingta-guangpingwang](https://github.com/pingta-guangpingwang)，负责批准每次正式签名请求和稳定发布。
- 外部贡献者的变更必须先由维护者审查，不能直接触发正式签名。

## 签名范围

- 项目自己的 Windows 在线安装器和离线安装器使用 Authenticode 签名。
- 第三方上游二进制不得被重新签成项目自己的代码；保留其原签名或摘要与许可证信息。
- 安装器、版本信息、产品名称和下载页必须指向同一版本，不能复用签名包装未知载荷。
- 证书私钥只存在于签名服务的 HSM，不能进入仓库、GitHub Secret 或开发者电脑。

## 隐私

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. 启动时的签名目录检查和用户进入在线功能所需的必要联网边界、模型 Key、本机数据和诊断信息处理见 [PRIVACY.md](../PRIVACY.md)。

## 事件处理

如发现签名制品被篡改、签名流程被绕过或证书可能滥用，立即停止发布、撤回受影响清单并通过 [SECURITY.md](../SECURITY.md) 的私密渠道调查；必要时请求 SignPath 暂停签名策略或撤销证书。
