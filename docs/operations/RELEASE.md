# 发布流程

## 1. 准备地址

在启动器设置默认值或首次启动配置中填入：

- GitHub 仓库；
- Gitee 仓库；
- OSS/CDN 基础地址；
- npmmirror 或其他 npm registry。

GitHub 保存源码和内容寻址模块；Gitee仓库只在真实可用后加入镜像。OSS/CDN 对外发布不到 1 MB 的联网引导器、`release-v2/launcher-manifest.json` 和应急模块，不承载日常完整离线包流量。

## 2. 生成签名密钥

运行时 schema-2 清单使用独立 Ed25519 密钥。私钥不能进入仓库，也不能覆盖旧的 `update-public-key.pem` 商店信任根。

```sh
openssl genpkey -algorithm ED25519 -out runtime-production-v2-1-private.pem
openssl pkey -in runtime-production-v2-1-private.pem -pubout -out resources/runtime-update-public-key.pem
```

把私钥放入受保护的发布机或 CI Secret，把公钥随整合包发布。

## 3. 构建目标整合包

每个目标系统先执行质量检查，再构建该平台整合包：

```sh
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:plugin
npm run test:version
npm run verify:skins
npm run verify:pets
npm run build
```

Windows 运行 `npm run dist:win`，产出小型联网引导器、UI 壳、三个运行模块和百度网盘兜底的完整离线 EXE，并生成 `windows-artifacts.json`；macOS 运行 `npm run dist:mac`。正式公开前必须使用最新 Defender 定义扫描安装 EXE 和安装目录，并评估 Windows SmartScreen 信誉与 macOS 签名、notarization。

## 4. 上传与清单

1. `dist:win` 构建并真实启动模块化 Harness Web；计算引导器、UI 壳和模块的 SHA-256 与字节大小。
2. 使用 Microsoft Defender 扫描联网引导器、完整离线 EXE 和安装后的完整目录，任何检测都阻止发布。
3. 把 UI 壳和运行模块发布为 GitHub Release 附件；OSS只同步联网引导器、签名清单和应急副本。完整离线包发布到百度网盘。
4. 运行 `npm run catalog:prepare`，把小型联网引导器和 `runtime-modules.generated.json` 写入 schema-2 payload。
4. 使用生产私钥签名：

```sh
LAUNCHER_SIGNING_KEY=/secure/runtime-production-v2-1-private.pem \
LAUNCHER_SIGNING_KEY_ID=runtime-production-v2-1 \
npm run sign:manifest -- release/launcher-catalog-payload.json release/launcher-manifest-v2.json
```

5. 把签名后的清单原子发布到 OSS `release-v2/launcher-manifest.json`。
6. 用上一正式版启动器执行“检查更新”，验证每模块与总进度、公开渠道预检、主渠道失败后的自动回退、签名和 SHA-256；清单中的每条应急 URL 都必须在无凭据客户端返回可下载响应，403/404 地址不得发布。
7. 将通过审核并重新签名的皮肤、宠物目录同步到对应公开 Gitee 仓库。两个仓库的 `catalog.json`、`trust.json` 与资源地址均为固定 URL；安装包只携带目录正文作为离线浏览兜底，不携带商店媒体。
8. 商店签名密钥轮换时，在固定 `trust.json` 中同时保留旧、新公钥完成灰度，并使用长期启动器根私钥重新签署信任清单。目录切换到新 keyId 后再将旧钥匙标记为 retired；此过程不得修改目录 URL，也不要求发布新版启动器。

## 5. 灰度和回滚

- 先只在签名清单中给少量测试用户提供新 URL。
- 验证 Windows 安装/卸载、桌面快捷方式和 macOS Gatekeeper。
- Harness 更新验证用户数据备份、插件 profile 和回滚。
- 有问题时回退清单，不覆盖或删除旧整合包；旧版本目录仍可继续工作。
